"""Rule-based pricing and decisions, used when the model is unreachable.

A merchant whose LLM provider is down should not become unable to quote. In a
real deployment that is lost revenue for the duration of someone else's
outage; on a demo laptop on venue wifi it is the difference between a working
system and a blank screen.

So after retries are exhausted, both agents fall back to deterministic logic
built from the same numbers the prompts were given. The result is a genuine,
signed, floor-respecting offer — just a less creative one. Every cart produced
this way is flagged `degraded`, surfaced in the UI and written to the audit
trail, because quietly serving rule-based pricing as if a model produced it
would be the dishonest version of this.

The concession schedule is the only judgement call here: open near the top of
the band and walk down toward the floor as rounds run out, which is what a
human sales desk does and what the model was being asked to imitate.
"""

from typing import Any

from protocol.mandates import BuyerDecision, CartItem, CartMandate, IntentMandate
from protocol.pricing import NEAR_FLOOR_BUFFER_PCT
from protocol.pricing import margin_pct as compute_margin_pct
from protocol.terms import STANDARD_LEAD_DAYS, min_sellable_price_for_terms

# Opening margin sits this far above the floor; by the final round the offer
# has walked all the way down to it.
# Opening margin above the *effective* floor below.
OPENING_MARGIN_HEADROOM_PCT = 12.0

# How far above the hard floor an automated quote refuses to go.
#
# An unattended quote should not park its own seller in the manual-review
# queue, so the floor these rules concede toward is the margin floor plus the
# near-floor review buffer, with a little clearance. Conceding to the hard
# floor is a decision for a human at the desk, not for a fallback path running
# because a model was unreachable.
AUTO_QUOTE_CLEARANCE_PCT = 1.0
# Each round concedes ~45% of the margin still above the floor.
CONCESSION_DECAY = 0.55
MAX_LINE_ITEMS = 3


def _target_margin_pct(margin_floor_pct: float, round_num: int, max_rounds: int) -> float:
    """Decaying concession from the opening margin toward the floor.

    Geometric, not linear. A linear walk concedes the same amount every round,
    which is not how anyone negotiates and had a concrete bad effect here: the
    buyer's "concessions have flattened" rule could never fire, so every
    offline deal ran the full six rounds and landed on the exact floor — which
    then tripped the near-floor seller gate every single time.

    Decaying gives a big opening move and progressively smaller ones, so the
    negotiation settles naturally a few rounds in, comfortably above the floor.
    """
    effective_floor = margin_floor_pct + NEAR_FLOOR_BUFFER_PCT + AUTO_QUOTE_CLEARANCE_PCT
    if max_rounds <= 1:
        return effective_floor
    remaining = CONCESSION_DECAY ** max(round_num - 1, 0)
    return effective_floor + OPENING_MARGIN_HEADROOM_PCT * remaining


def propose_cart_offline(
    intent: IntentMandate,
    business: dict[str, Any],
    round_num: int,
    max_rounds: int,
) -> CartMandate:
    """Builds a valid cart without calling a model.

    Fills the buyer's quantity band from the cheapest items the vendor sells,
    prices each at the target margin for this round, then — if the total
    overshoots the budget — walks the price back toward the floor and, failing
    that, trims quantity. It never prices below the floor: an offer that
    breaches the vendor's own limit is worse than no offer.
    """
    catalog = business["catalog"]
    margin_floor_pct = business["margin_floor_pct"]
    terms = intent.preferred_payment_terms
    lead_time = max(1, min(STANDARD_LEAD_DAYS, intent.ship_within_days))

    target_margin = _target_margin_pct(margin_floor_pct, round_num, max_rounds)

    if not catalog:
        raise ValueError(f"{business['id']} has an empty catalog")

    # A named basket is a hard constraint the buyer checks in code, so the
    # offline path has to honour it exactly as the model path does — degraded
    # must mean "priced by rule", never "quietly sold something else".
    by_name = {c["name"].casefold(): c for c in catalog}
    requested = [
        (by_name[line.name.casefold()], line.qty)
        for line in intent.requested_lines
        if line.name.casefold() in by_name
    ]

    if requested:
        ranked = [c for c, _ in requested][:MAX_LINE_ITEMS]
        quantities = [q for _, q in requested][:MAX_LINE_ITEMS]
        # The band still governs the total: top the cheapest line up if the
        # basket alone falls short of qty_min.
        shortfall = max(intent.qty_min - sum(quantities), 0)
        if shortfall:
            cheapest = min(range(len(ranked)), key=lambda i: ranked[i]["cost"])
            quantities[cheapest] += shortfall
        # Quantities the buyer named are a floor this vendor may not trim past.
        floors = {c["sku"]: q for (c, q) in requested}
    else:
        # Cheapest-first: the most units for the buyer's money, which is what a
        # vendor competing on a broadcast would actually lead with.
        ranked = sorted(catalog, key=lambda c: c["cost"])[:MAX_LINE_ITEMS]
        # Spread the quantity band across the chosen SKUs, remainder to the first.
        total_qty = max(intent.qty_min, 1)
        per_item = max(total_qty // len(ranked), 1)
        quantities = [per_item] * len(ranked)
        quantities[0] += total_qty - sum(quantities)
        floors = {}

    def build(margin: float, qtys: list[int]) -> list[CartItem]:
        items: list[CartItem] = []
        for catalog_item, qty in zip(ranked, qtys):
            floor_price = min_sellable_price_for_terms(catalog_item["cost"], margin_floor_pct, terms)
            asking = min_sellable_price_for_terms(catalog_item["cost"], margin, terms)
            items.append(
                CartItem(
                    sku=catalog_item["sku"],
                    name=catalog_item["name"],
                    qty=int(qty),
                    unit_price=round(max(asking, floor_price), 2),
                )
            )
        return items

    items = build(target_margin, quantities)
    total = sum(i.line_total for i in items)

    # Concede price toward the floor before touching quantity — a buyer asked
    # for a quantity band and expects it honoured.
    if total > intent.max_spend:
        items = build(margin_floor_pct, quantities)
        total = sum(i.line_total for i in items)

    # Still over budget at the floor: reduce quantity, never price — and never
    # below a quantity the buyer explicitly named, which would produce a cart
    # the buyer rejects anyway.
    def trimmable(item: CartItem) -> bool:
        return item.qty > max(floors.get(item.sku, 0), 1)

    while total > intent.max_spend and sum(i.qty for i in items) > max(intent.qty_min, len(items)):
        candidates = [i for i in items if trimmable(i)]
        if not candidates:
            break
        biggest = max(candidates, key=lambda i: i.qty)
        biggest.qty -= 1
        total = sum(i.line_total for i in items)

    cost = sum(
        next(c["cost"] for c in catalog if c["sku"] == item.sku) * item.qty for item in items
    )
    return CartMandate(
        intent_id=intent.id,
        merchant_ref=business["id"],
        round=round_num,
        items=items,
        lead_time_days=lead_time,
        payment_terms=terms,
        margin_pct=compute_margin_pct(total, cost),
        reasoning=(
            f"Rule-based quote (pricing model unreachable): {sum(i.qty for i in items)} units "
            f"at a {round(target_margin, 1)}% target margin, {lead_time}-day delivery on your "
            f"requested terms. Priced from the catalog floor, not negotiated."
        ),
    )


def evaluate_cart_offline(
    intent: IntentMandate,
    cart: CartMandate,
    round_num: int,
    max_rounds: int,
    previous_total: float | None,
) -> BuyerDecision:
    """The buyer's decision rules, applied directly.

    These are the same thresholds the prompt states — the model was being asked
    to apply them to numbers already computed in code, so running them here
    loses very little and keeps the negotiation alive.
    """
    if cart.total_price > intent.max_spend:
        return BuyerDecision(
            action="walk" if round_num >= max_rounds else "counter",
            counter_on="price",
            reasoning=f"₹{cart.total_price} is over the ₹{intent.max_spend} ceiling.",
        )
    if cart.lead_time_days > intent.ship_within_days:
        return BuyerDecision(
            action="walk" if round_num >= max_rounds else "counter",
            counter_on="lead_time",
            reasoning=f"{cart.lead_time_days}-day delivery misses the {intent.ship_within_days}-day window.",
        )

    headroom_pct = (1 - cart.total_price / intent.max_spend) * 100
    improvement_pct = (
        (previous_total - cart.total_price) / previous_total * 100
        if previous_total and previous_total > 0
        else 0.0
    )

    if headroom_pct < 10:
        return BuyerDecision(
            action="accept",
            counter_on="price",
            reasoning=f"Only {headroom_pct:.1f}% headroom left — taking it. (Rule-based: model unreachable.)",
        )
    # Diminishing returns. Headroom stays high throughout a falling-price
    # negotiation, so a headroom-only rule never fires and every offline deal
    # ran to the final round and landed on the exact floor — which then always
    # tripped the near-floor seller gate. A real buyer stops pushing once the
    # concessions stop being worth the round.
    if round_num >= 3 and previous_total is not None and improvement_pct < 3.0:
        return BuyerDecision(
            action="accept",
            counter_on="price",
            reasoning=(
                f"Concessions have flattened to {improvement_pct:.1f}% a round — "
                "further pushing is not worth the delay. (Rule-based: model unreachable.)"
            ),
        )
    if headroom_pct < 30 and improvement_pct >= 8:
        return BuyerDecision(
            action="accept",
            counter_on="price",
            reasoning=f"{improvement_pct:.1f}% concession at {headroom_pct:.1f}% headroom — taking it. (Rule-based.)",
        )
    if round_num >= max_rounds:
        return BuyerDecision(
            action="accept",
            counter_on="price",
            reasoning="Final round and the offer is inside every limit — accepting rather than walking. (Rule-based.)",
        )
    return BuyerDecision(
        action="counter",
        counter_on="price",
        reasoning=f"{headroom_pct:.1f}% of budget still unused — pushing for a better price. (Rule-based.)",
    )
