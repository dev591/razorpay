"""Retry policy for transient upstream failures.

Observed in testing on a flaky connection: all three vendor agents failed at
round one with a bare `Connection error`, the session ended `no_valid_offers`,
and the whole negotiation was lost to a blip that lasted under a second. That
is correct failure handling and a useless outcome.

Two ideas, kept separate on purpose:

  * **Transient vs terminal.** A dropped socket, a 429 or a 5xx is worth
    retrying. A malformed request or an auth failure is not — retrying those
    burns the clock and still fails, so they propagate immediately.
  * **Bounded, jittered backoff.** Retries are capped in both count and total
    wall time, because a negotiation that silently takes four minutes is its
    own kind of outage. Jitter matters here specifically because three vendor
    threads fail simultaneously on a network blip; without it they would
    retry in lockstep and hammer the same recovering endpoint.
"""

import random
import threading
import time
from typing import Callable, TypeVar

import openai

from config import HAS_OPENAI

T = TypeVar("T")

MAX_ATTEMPTS = 3
BASE_DELAY_SECONDS = 0.6
MAX_DELAY_SECONDS = 4.0

# Worth retrying: the upstream may simply be unreachable or busy right now.
TRANSIENT = (
    openai.APIConnectionError,
    openai.APITimeoutError,
    openai.RateLimitError,
    openai.InternalServerError,
)

# Never worth retrying: the request itself is the problem.
TERMINAL = (
    openai.AuthenticationError,
    openai.PermissionDeniedError,
    openai.BadRequestError,
    openai.NotFoundError,
)


class _ModelOutage:
    """A switch that makes the model genuinely unreachable, on demand.

    The point of the degraded path is that it is real, so this breaks the
    *upstream* rather than short-circuiting to the fallback: `call_with_retry`
    raises the same `APIConnectionError` the SDK raises when OpenAI cannot be
    reached, and everything downstream — the retry budget, the jittered
    backoff, the rule-based quoting, the `degraded` flag on the cart and in the
    audit trail — runs exactly as it would in a real outage. A switch that
    jumped straight to the fallback would demonstrate nothing.

    Expires on its own. A demo control that can be left on by accident is a
    control that eventually makes a working system look broken.
    """

    DEFAULT_TTL_SECONDS = 300.0

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._until: float | None = None

    def enable(self, ttl_seconds: float | None = None) -> dict[str, object]:
        with self._lock:
            self._until = time.time() + (ttl_seconds or self.DEFAULT_TTL_SECONDS)
        return self.status()

    def disable(self) -> dict[str, object]:
        with self._lock:
            self._until = None
        return self.status()

    def active(self) -> bool:
        with self._lock:
            if self._until is None:
                return False
            if time.time() >= self._until:
                self._until = None  # lapsed; heal without needing a call
                return False
            return True

    def status(self) -> dict[str, object]:
        with self._lock:
            remaining = None if self._until is None else round(self._until - time.time(), 1)
        active = remaining is not None and remaining > 0
        return {
            # Without a key the model is unreachable for the life of the
            # process, which the UI needs to show as a standing state rather
            # than a switch someone can flip back.
            "model_unreachable": active or not HAS_OPENAI,
            "expires_in_seconds": remaining if active else None,
            "no_api_key": not HAS_OPENAI,
        }


model_outage = _ModelOutage()


def call_with_retry(fn: Callable[[], T], on_retry: Callable[[int, Exception], None] | None = None) -> T:
    """Runs `fn`, retrying transient upstream failures with jittered backoff.

    Re-raises the last exception once attempts are exhausted, so every existing
    `except openai.OpenAIError` handler upstream keeps working unchanged — this
    only changes how many times we try before giving up.
    """
    # No key configured is not a transient failure, so there is nothing to
    # retry — go straight to the rule-based path the caller already has.
    if not HAS_OPENAI:
        raise openai.APIConnectionError(request=None)  # type: ignore[arg-type]

    last: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            if model_outage.active():
                raise openai.APIConnectionError(request=None)  # type: ignore[arg-type]
            return fn()
        except TERMINAL:
            raise
        except TRANSIENT as e:
            last = e
            if attempt == MAX_ATTEMPTS:
                break
            delay = min(BASE_DELAY_SECONDS * (2 ** (attempt - 1)), MAX_DELAY_SECONDS)
            # Full jitter: three vendor threads fail together on a blip, so
            # spreading their retries is the point, not a refinement.
            time.sleep(random.uniform(0, delay))
            if on_retry is not None:
                on_retry(attempt, e)
    assert last is not None
    raise last
