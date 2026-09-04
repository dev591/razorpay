import random
import threading
import time
from typing import Any

from orchestrator import session_manager

_BATCH_GOALS = [
    ("Restock office peripherals", 42000, 40, 60),
    ("Bulk order for new hires", 65000, 50, 80),
    ("Warehouse replenishment", 30000, 25, 45),
    ("Quarterly accessory refresh", 55000, 60, 90),
]

_lock = threading.Lock()
_cache: dict[str, Any] | None = None
_cache_at: float = 0.0
_computing = False
TTL_SECONDS = 600  # 10 minutes — real numbers, refreshed periodically rather than per-visitor


def _compute_batch(n: int) -> dict[str, Any]:
    results = []
    for _ in range(n):
        goal, max_spend, qty_min, qty_max = random.choice(_BATCH_GOALS)
        jitter = random.uniform(0.9, 1.1)
        session = session_manager.run_session(
            goal=goal,
            max_spend=round(max_spend * jitter, 2),
            qty_min=qty_min,
            qty_max=qty_max,
        )
        results.append(session)

    locked = [s for s in results if s.get("final_cart") is not None]
    settled_or_locked_count = len(locked)

    margins = [s["final_cart"]["margin_pct"] for s in locked]
    avg_margin = round(sum(margins) / len(margins), 2) if margins else 0.0

    with_upsell = [s for s in locked if s["final_cart"].get("upsell_item") is not None]
    upsell_offer_rate = (
        round(len(with_upsell) / settled_or_locked_count * 100, 1)
        if settled_or_locked_count
        else 0.0
    )

    tamper_results = [session_manager.simulate_tamper(s["id"]) for s in locked]
    caught = sum(1 for t in tamper_results if t["rejected"])
    tamper_catch_rate = (
        round(caught / len(tamper_results) * 100, 1) if tamper_results else 0.0
    )

    return {
        "n": n,
        "locked_or_settled": settled_or_locked_count,
        "walked_away": sum(1 for s in results if s["status"] == "walked_away"),
        "avg_margin_pct": avg_margin,
        "upsell_offer_rate_pct": upsell_offer_rate,
        "tamper_catch_rate_pct": tamper_catch_rate,
        "computed_at": time.time(),
    }


def _background_compute(n: int) -> None:
    global _cache, _cache_at, _computing
    try:
        fresh = _compute_batch(n)
        with _lock:
            _cache = fresh
            _cache_at = time.time()
    finally:
        with _lock:
            _computing = False


def get_metrics(n: int = 20, force_refresh: bool = False) -> dict[str, Any]:
    """Non-blocking: if no fresh cache exists yet, kicks off a background
    computation (if one isn't already running) and immediately returns
    ready=False rather than making the caller wait minutes. Poll again."""
    global _computing
    with _lock:
        is_stale = _cache is None or (time.time() - _cache_at) > TTL_SECONDS
        if not force_refresh and not is_stale:
            return {**_cache, "ready": True}

        if _computing:
            return {"ready": False}

        _computing = True

    threading.Thread(target=_background_compute, args=(n,), daemon=True).start()
    with _lock:
        if _cache is not None:
            # Serve the last-known-good numbers while a refresh runs underneath.
            return {**_cache, "ready": True, "refreshing": True}
    return {"ready": False}
