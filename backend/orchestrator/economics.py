"""Unit economics, measured rather than estimated.

Every OpenAI response carries a `usage` block. Recording it turns "an agent
negotiation probably costs a fraction of a cent" into a number we can put in
front of a finance team — and, more usefully, into a number that can be
compared against the margin the negotiation earned.

That comparison is the whole argument for the system: an agent that spends
₹0.30 of inference to defend ₹4,000 of margin is not a cost centre. Stating
it without measuring it would be a guess.

Rates are OpenAI list prices for gpt-4o-mini (USD per million tokens).
"""

import threading
from collections import defaultdict
from typing import Any

# https://platform.openai.com/docs/pricing — gpt-4o-mini, standard tier.
USD_PER_M_INPUT = 0.15
USD_PER_M_CACHED_INPUT = 0.075
USD_PER_M_OUTPUT = 0.60

# Indicative INR conversion, stated explicitly so a reader can re-derive the
# rupee figures rather than having to trust them.
USD_TO_INR = 88.0

_lock = threading.Lock()
_totals: dict[str, float] = defaultdict(float)
_calls: dict[str, int] = defaultdict(int)
# session_id -> accumulated usage, so cost can be attributed per negotiation
# rather than only in aggregate.
_by_session: dict[str, dict[str, float]] = {}
# How many vendors each session actually negotiated with. Cost per vendor is
# what the shortlist saves, and it can only be derived if the divisor is
# recorded alongside the spend.
_vendors_per_session: dict[str, int] = {}


def usd_cost(prompt_tokens: int, completion_tokens: int, cached_tokens: int = 0) -> float:
    """Cost of one call. Cached prefix tokens bill at half rate, so they are
    subtracted from the full-price input count rather than double-counted."""
    fresh_input = max(prompt_tokens - cached_tokens, 0)
    return (
        fresh_input / 1_000_000 * USD_PER_M_INPUT
        + cached_tokens / 1_000_000 * USD_PER_M_CACHED_INPUT
        + completion_tokens / 1_000_000 * USD_PER_M_OUTPUT
    )


def record_vendor_count(session_id: str, vendors: int) -> None:
    """Records how many vendors a session negotiated with, so per-vendor cost
    can be derived from real sessions rather than assumed."""
    with _lock:
        _vendors_per_session[session_id] = vendors


def record(usage: Any, session_id: str | None = None, agent: str = "unknown") -> None:
    """Records one completion's usage. Never raises: metering must not be able
    to take down a negotiation, and the OpenAI SDK's usage object shape varies
    across model families."""
    try:
        prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
        details = getattr(usage, "prompt_tokens_details", None)
        cached = int(getattr(details, "cached_tokens", 0) or 0) if details else 0
    except (TypeError, ValueError):
        return

    cost = usd_cost(prompt_tokens, completion_tokens, cached)

    with _lock:
        _totals["prompt_tokens"] += prompt_tokens
        _totals["completion_tokens"] += completion_tokens
        _totals["cached_tokens"] += cached
        _totals["usd"] += cost
        _calls[agent] += 1
        _calls["total"] += 1

        if session_id:
            bucket = _by_session.setdefault(
                session_id,
                {"prompt_tokens": 0.0, "completion_tokens": 0.0, "cached_tokens": 0.0, "usd": 0.0, "calls": 0.0},
            )
            bucket["prompt_tokens"] += prompt_tokens
            bucket["completion_tokens"] += completion_tokens
            bucket["cached_tokens"] += cached
            bucket["usd"] += cost
            bucket["calls"] += 1


def for_session(session_id: str) -> dict[str, Any] | None:
    with _lock:
        bucket = _by_session.get(session_id)
        if bucket is None:
            return None
        return {
            **{k: round(v, 6) if k == "usd" else int(v) for k, v in bucket.items()},
            "inr": round(bucket["usd"] * USD_TO_INR, 4),
        }


def cost_per_vendor() -> dict[str, float]:
    """Measured average cost of negotiating with ONE vendor.

    The shortlist needs this to say what it saved, and it runs before any call
    is made, so the figure has to come from history rather than the session in
    flight. Falls back to figures measured on this build when nothing has been
    metered yet (a clean clone's first negotiation).
    """
    with _lock:
        sessions = list(_by_session.values())
        vendors = list(_vendors_per_session.values())

    metered = min(len(sessions), len(vendors))
    if metered:
        total_calls = sum(s["calls"] for s in sessions[:metered])
        total_usd = sum(s["usd"] for s in sessions[:metered])
        total_vendors = sum(vendors[:metered]) or 1
        return {
            "calls": round(total_calls / total_vendors, 2),
            "inr": round(total_usd * USD_TO_INR / total_vendors, 4),
            "measured": True,
        }
    return {"calls": 9.0, "inr": 0.115, "measured": False}


def summary() -> dict[str, Any]:
    """Aggregate spend plus the per-negotiation averages the economics page
    quotes. Averages are over sessions that actually made calls, so a restart
    that leaves old sessions un-metered doesn't drag the mean to zero."""
    with _lock:
        totals = dict(_totals)
        calls = dict(_calls)
        sessions = list(_by_session.values())

    metered = len(sessions)
    avg_usd = sum(s["usd"] for s in sessions) / metered if metered else 0.0
    avg_calls = sum(s["calls"] for s in sessions) / metered if metered else 0.0
    avg_tokens = (
        sum(s["prompt_tokens"] + s["completion_tokens"] for s in sessions) / metered
        if metered
        else 0.0
    )

    return {
        "model": "gpt-4o-mini",
        "rates_usd_per_million": {
            "input": USD_PER_M_INPUT,
            "cached_input": USD_PER_M_CACHED_INPUT,
            "output": USD_PER_M_OUTPUT,
        },
        "usd_to_inr": USD_TO_INR,
        "totals": {
            "llm_calls": int(calls.get("total", 0)),
            "prompt_tokens": int(totals.get("prompt_tokens", 0)),
            "completion_tokens": int(totals.get("completion_tokens", 0)),
            "cached_tokens": int(totals.get("cached_tokens", 0)),
            "usd": round(totals.get("usd", 0.0), 6),
            "inr": round(totals.get("usd", 0.0) * USD_TO_INR, 4),
        },
        "calls_by_agent": {k: v for k, v in calls.items() if k != "total"},
        "per_negotiation": {
            "sessions_metered": metered,
            "avg_llm_calls": round(avg_calls, 2),
            "avg_tokens": round(avg_tokens, 1),
            "avg_usd": round(avg_usd, 6),
            "avg_inr": round(avg_usd * USD_TO_INR, 4),
        },
    }
