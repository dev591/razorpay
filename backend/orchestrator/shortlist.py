"""Which vendors are allowed to negotiate.

Negotiation is the expensive step — roughly nine model calls per vendor. The
broadcast previously went to every registered business, which makes the cost of
one purchase O(vendors). At Razorpay's scale that isn't a latency problem, it's
a *spend* problem: 100k merchants would be ~900k model calls for one restock.
So the fan-out is gated before it happens rather than ranked after it.

Two properties make this a defensible gate rather than a guess:

  * **The key is a provable lower bound.** `min_sellable_price` is the cheapest
    unit price a vendor can quote without breaching its own margin floor. No
    amount of negotiation moves it, so `qty_min x cheapest floor price` is a
    hard lower bound on any cart that vendor could ever sign. If an excluded
    vendor's bound is above the winning price, that vendor *could not* have
    won — the shortlist is admissible, and `verify_admissible` says so in the
    audit trail.

    List price is the wrong key: it ranks who *starts* cheap, not who *ends*
    cheap. ByteBazaar lists 39% above its floor and QuickSupply 25% above its
    own; the sticker ordering and the achievable ordering are different
    questions.

  * **One slot is held for exploration.** A purely greedy shortlist means the
    same k merchants win every auction and nobody else ever transacts — for a
    platform whose whole point is growing merchant revenue, that is an
    anti-feature. The last slot goes to the vendor with the fewest orders so
    far, so new and unproven merchants get real impressions.
"""

import random
from typing import Any, Callable, Iterable

from protocol.pricing import min_sellable_price

# How many vendors may negotiate at once. Roughly nine model calls each, so
# this is the per-purchase spend cap: cost becomes O(1) in marketplace size
# rather than O(vendors).
SHORTLIST_K = 3

# The gate is a no-op at or below this many vendors — there is nothing to
# eliminate when everyone already fits inside k.
SHORTLIST_MIN_VENDORS = SHORTLIST_K

# Slots reserved for vendors that would not have made the cut on price.
#
# Off by default, so the shortlist is exactly "the k cheapest achievable" and a
# reader comparing bounds to the selection sees them agree. Turning this up
# trades a little price for marketplace health: a purely greedy gate means the
# same k merchants win every auction and nobody else ever transacts, which for
# a platform meant to grow merchant revenue is an anti-feature. The machinery
# is here and tested; the default is the one that is simplest to verify.
EXPLORE_SLOTS = 0


def floor_bound(
    business: dict[str, Any],
    qty_min: int,
    requested_lines: list[Any] | None = None,
) -> float | None:
    """Lower bound on any cart this vendor could sign. None if it cannot bid.

    Without a named basket, every unit costs at least the vendor's cheapest
    floor-clearing price, so `qty_min x that` bounds a basket of any
    composition.

    With a named basket the bound gets both tighter and more honest: the buyer
    has committed to specific goods, so each requested line contributes its own
    floor price rather than the cheapest thing in the catalog. A vendor that
    does not stock a requested item is dropped outright — it cannot fill the
    order at any price, which is a stronger statement than being expensive.
    """
    catalog = business.get("catalog") or []
    if not catalog:
        return None
    floor_pct = business.get("margin_floor_pct", 0.0)

    if requested_lines:
        by_name = {item["name"].casefold(): item for item in catalog}
        total = 0.0
        covered = 0
        for line in requested_lines:
            name = (line.name if hasattr(line, "name") else line["name"]).casefold()
            qty = line.qty if hasattr(line, "qty") else line["qty"]
            item = by_name.get(name)
            if item is None:
                return None  # cannot fill this order at all
            total += min_sellable_price(item["cost"], floor_pct) * qty
            covered += qty
        # Any units the band demands beyond the basket cost at least the
        # cheapest thing this vendor sells.
        remainder = max(qty_min - covered, 0)
        if remainder:
            cheapest = min(min_sellable_price(i["cost"], floor_pct) for i in catalog)
            total += cheapest * remainder
        return round(total, 2)

    cheapest = min(min_sellable_price(item["cost"], floor_pct) for item in catalog)
    return round(cheapest * max(qty_min, 1), 2)


def shortlist(
    sellers: Iterable[dict[str, Any]],
    qty_min: int,
    requested_lines: list[Any] | None = None,
    k: int = SHORTLIST_K,
    explore_slots: int = EXPLORE_SLOTS,
    orders_of: Callable[[str], int] | None = None,
    seed: str | None = None,
) -> dict[str, Any]:
    """Picks the vendors that will negotiate, with the reasoning attached.

    `orders_of` supplies each vendor's settled order count so exploration can
    favour merchants who have never won; it is injected rather than imported so
    this stays testable and free of a leaderboard dependency. `seed` makes the
    tie-break reproducible for a given session.
    """
    sellers = list(sellers)
    bounds = {b["id"]: floor_bound(b, qty_min, requested_lines) for b in sellers}

    # A vendor that can't stock the basket (or has no catalog at all) can't
    # bid; drop it before it consumes a slot.
    biddable = [b for b in sellers if bounds[b["id"]] is not None]

    if len(biddable) <= max(k, SHORTLIST_MIN_VENDORS):
        return {
            "strategy": "all",
            "selected": biddable,
            "bounds": bounds,
            "excluded": [
                {"business_id": b["id"], "bound": None, "reason": "cannot_fill_basket"}
                for b in sellers
                if bounds[b["id"]] is None
            ],
            "k": len(biddable),
            "explore_slots": 0,
        }

    rng = random.Random(seed)
    orders = orders_of or (lambda _: 0)

    # Cheapest achievable first; a stable random tie-break stops vendors with
    # identical bounds from being ordered by registration date forever.
    ranked = sorted(biddable, key=lambda b: (bounds[b["id"]], rng.random()))

    price_slots = max(k - explore_slots, 1)
    selected = ranked[:price_slots]
    remainder = ranked[price_slots:]

    # Exploration: fewest orders first, so the slot goes to merchants the
    # marketplace has not yet given a chance.
    explored: list[dict[str, Any]] = []
    if remainder and explore_slots > 0:
        by_exposure = sorted(remainder, key=lambda b: (orders(b["id"]), rng.random()))
        explored = by_exposure[:explore_slots]

    chosen_ids = {b["id"] for b in selected} | {b["id"] for b in explored}
    return {
        "strategy": "bounded",
        "selected": selected + explored,
        "explored_ids": [b["id"] for b in explored],
        "bounds": bounds,
        "excluded": [
            {
                "business_id": b["id"],
                "bound": bounds[b["id"]],
                "reason": "above_price_bound" if bounds[b["id"]] is not None else "cannot_fill_basket",
            }
            for b in sellers
            if b["id"] not in chosen_ids
        ],
        "k": k,
        "explore_slots": explore_slots,
    }


def verify_admissible(excluded: list[dict[str, Any]], winning_price: float) -> dict[str, Any]:
    """Checks the claim the gate rests on: no vendor we refused to negotiate
    with could have beaten the price we got.

    A violation is not a crash — it means a cheaper vendor existed and we never
    asked, which is exactly the fact an audit trail should carry rather than
    hide. `k` is the knob that trades this risk against spend.
    """
    undercut = [
        e for e in excluded
        if e.get("bound") is not None and e["bound"] < winning_price
    ]
    return {
        "admissible": not undercut,
        "winning_price": winning_price,
        "excluded_count": len(excluded),
        "could_have_undercut": [
            {"business_id": e["business_id"], "bound": e["bound"]} for e in undercut
        ],
    }
