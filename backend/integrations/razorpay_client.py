import random
import time

import razorpay
from razorpay.errors import (
    BadRequestError,
    GatewayError,
    ServerError,
    SignatureVerificationError,
)
from requests.exceptions import RequestException

from config import RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET

_client = razorpay.Client(auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET))

PUBLIC_KEY_ID = RAZORPAY_KEY_ID  # safe to expose client-side; it's the publishable key

# The Razorpay SDK wraps `requests` but sets no timeout of its own (unlike the
# OpenAI client, which does) — without one, a stalled connection to
# api.razorpay.com hangs the call indefinitely instead of failing. Passed as
# a per-call kwarg (the SDK forwards **kwargs straight to `requests`) to
# every real HTTP call below.
# 15s was tight enough that api.razorpay.com read-timed-out on an
# otherwise healthy negotiation during testing. The call still has to be
# bounded (an unbounded one hangs the settlement thread forever), but the
# bound should sit above normal provider latency, not inside it.
REQUEST_TIMEOUT_SECONDS = 30.0

# Everything a caller needs to catch to treat a Razorpay call as a clean,
# handleable failure rather than an unhandled exception: transport-level
# failures (REQUEST_TIMEOUT_SECONDS expiring, connection reset, DNS, ...) via
# RequestException, plus the SDK's own non-2xx-response error types.
RazorpayCallError = (RequestException, BadRequestError, GatewayError, ServerError)


def _with_retry(fn, attempts: int = 3, base_delay: float = 0.5):
    """Retries transport-level Razorpay failures with jittered backoff.

    A read timeout to api.razorpay.com killed an otherwise-complete
    negotiation during testing: the cart was agreed, signed and hash-locked,
    and the only thing missing was an order id. Retrying transport failures
    costs a second and saves the deal.

    Only `RequestException` is retried — a 4xx from Razorpay means the request
    itself is wrong and will fail identically on the next attempt.
    """
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except RequestException as e:
            last = e
            if attempt == attempts:
                break
            time.sleep(random.uniform(0, min(base_delay * (2 ** (attempt - 1)), 3.0)))
    assert last is not None
    raise last


def create_order(amount_rupees: float, receipt: str) -> dict:
    """Creates a real Razorpay test-mode order. Amount is in rupees; Razorpay
    expects paise (integer)."""
    return _with_retry(
        lambda: _client.order.create(
            {
                "amount": int(round(amount_rupees * 100)),
                "currency": "INR",
                "receipt": receipt,
                "payment_capture": 1,
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    )


def fetch_order(order_id: str) -> dict:
    return _client.order.fetch(order_id, timeout=REQUEST_TIMEOUT_SECONDS)


def verify_checkout_signature(
    order_id: str, payment_id: str, signature: str
) -> bool:
    """Verifies the HMAC signature Razorpay Checkout returns on success —
    proof the payment actually happened and wasn't spoofed by the client.
    Pure local HMAC comparison, no HTTP call — no timeout needed."""
    try:
        _client.utility.verify_payment_signature(
            {
                "razorpay_order_id": order_id,
                "razorpay_payment_id": payment_id,
                "razorpay_signature": signature,
            }
        )
        return True
    except SignatureVerificationError:
        return False


def fetch_payment(payment_id: str) -> dict:
    return _client.payment.fetch(payment_id, timeout=REQUEST_TIMEOUT_SECONDS)


def capture_payment(payment_id: str, amount_rupees: float) -> dict:
    """Idempotent capture: our orders are created with payment_capture=1, so
    Razorpay auto-captures on successful authorization before our callback
    even runs. Treat an already-captured payment as success rather than
    erroring — check current status first instead of blindly calling capture."""
    payment = _with_retry(lambda: fetch_payment(payment_id))
    if payment.get("status") == "captured":
        return payment
    return _with_retry(
        lambda: _client.payment.capture(
            payment_id,
            int(round(amount_rupees * 100)),
            {"currency": "INR"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    )
