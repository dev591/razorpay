"""Ranking structures for offer selection and the vendor leaderboard.

Two different problems, two different structures:

  * `top_k_offers` — a *one-shot* selection over a batch that already exists
    in memory. `heapq.nlargest` keeps a k-sized heap and does one pass:
    O(n log k), versus O(n log n) to sort every offer just to read the top
    of the list. With three seeded vendors that is academic; the marketplace
    broadcast is a fan-out designed to grow to every registered merchant,
    and this is the line that would otherwise be the bottleneck.

  * `Leaderboard` — an *incrementally maintained* ranking. A settled order
    arrives, the vendor's cumulative revenue changes, and the top-k has to
    stay correct. A heap can't do that (no efficient decrease-key on an
    arbitrary element), so this keeps a `bisect.insort` sorted list keyed on
    revenue: O(log n) to find the insertion point, O(n) memmove to splice,
    and O(1) to read the top k. For a leaderboard that is read on every
    dashboard poll and written once per settlement, that trade is the right
    way round.
"""

import bisect
import heapq
import threading
from typing import Any, Callable, Sequence


def top_k_offers(
    offers: Sequence[dict[str, Any]],
    k: int,
    key: Callable[[dict[str, Any]], float] | None = None,
) -> list[dict[str, Any]]:
    """Highest-scoring k offers, best first. Bounded heap pass, no full sort."""
    score_of = key or (lambda o: o.get("score") or 0.0)
    if k >= len(offers):
        return sorted(offers, key=score_of, reverse=True)
    return heapq.nlargest(k, offers, key=score_of)


class Leaderboard:
    """Vendor revenue ranking, kept sorted as settlements land.

    Entries are held ascending as `(revenue, business_id)` tuples so
    `bisect.insort` orders them without a key function; reads reverse the
    tail to hand back descending order.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sorted: list[tuple[float, str]] = []
        self._revenue: dict[str, float] = {}
        self._orders: dict[str, int] = {}
        self._settled_orders: dict[str, int] = {}
        self._units: dict[str, int] = {}
        self._margin_sum: dict[str, float] = {}

    def record_settlement(
        self,
        business_id: str,
        amount: float,
        units: int = 0,
        margin_pct: float = 0.0,
        settled: bool = False,
    ) -> None:
        """Adds one booked order to a vendor's totals and re-files it in the
        sorted list. Removing the stale tuple before re-inserting keeps the
        list a true ordering rather than an append-only log with duplicates.

        `settled` distinguishes money actually captured through Razorpay from
        a signed mandate with a real order behind it that nobody has paid
        yet. Both are ranked (a locked mandate is genuine committed demand),
        but the dashboard must never present booked GMV as revenue."""
        with self._lock:
            previous = self._revenue.get(business_id)
            if previous is not None:
                stale = (previous, business_id)
                position = bisect.bisect_left(self._sorted, stale)
                if position < len(self._sorted) and self._sorted[position] == stale:
                    self._sorted.pop(position)

            updated = round((previous or 0.0) + amount, 2)
            self._revenue[business_id] = updated
            self._orders[business_id] = self._orders.get(business_id, 0) + 1
            if settled:
                self._settled_orders[business_id] = (
                    self._settled_orders.get(business_id, 0) + 1
                )
            self._units[business_id] = self._units.get(business_id, 0) + units
            self._margin_sum[business_id] = (
                self._margin_sum.get(business_id, 0.0) + margin_pct
            )
            bisect.insort(self._sorted, (updated, business_id))

    def top(self, k: int = 10) -> list[dict[str, Any]]:
        with self._lock:
            rows = list(reversed(self._sorted[-k:]))
            return [
                {
                    "rank": i + 1,
                    "business_id": business_id,
                    "revenue": revenue,
                    "orders": self._orders.get(business_id, 0),
                    "settled_orders": self._settled_orders.get(business_id, 0),
                    "units": self._units.get(business_id, 0),
                    "avg_margin_pct": round(
                        self._margin_sum.get(business_id, 0.0)
                        / max(self._orders.get(business_id, 1), 1),
                        2,
                    ),
                    "avg_order_value": round(
                        revenue / max(self._orders.get(business_id, 1), 1), 2
                    ),
                }
                for i, (revenue, business_id) in enumerate(rows)
            ]

    def orders_for(self, business_id: str) -> int:
        """Orders booked by one vendor. Used by the negotiation shortlist to
        favour merchants the marketplace has not yet given a chance."""
        with self._lock:
            return self._orders.get(business_id, 0)

    def totals(self) -> dict[str, Any]:
        with self._lock:
            return {
                "booked_gmv": round(sum(self._revenue.values()), 2),
                "total_orders": sum(self._orders.values()),
                "settled_orders": sum(self._settled_orders.values()),
                "vendors_ranked": len(self._sorted),
            }

    def reset(self) -> None:
        with self._lock:
            self._sorted.clear()
            self._revenue.clear()
            self._orders.clear()
            self._settled_orders.clear()
            self._units.clear()
            self._margin_sum.clear()
