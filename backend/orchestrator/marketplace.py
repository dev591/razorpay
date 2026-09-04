import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from agents import buyer_agent
from agents.businesses import BUSINESSES
from protocol.terms import CREDIT_DAYS
from config import SESSIONS_DIR
from integrations import razorpay_client
from ds.ranking import top_k_offers
from orchestrator import economics, runtime
from orchestrator.shortlist import shortlist, verify_admissible
from orchestrator.session_manager import (
    MAX_ROUNDS,
    _emit,
    _finalize_or_flag,
    _negotiate_with_business,
    _persist,
    remember_offer,
)
from protocol.audit_ledger import AuditLedger
from protocol.mandates import new_id

_lock = threading.Lock()

# Winner-selection scoring: one sentence version for the pitch — "each offer
# is scored on how well its price uses the buyer's budget and how quickly the
# vendor converged, then offers priced suspiciously far below the pack are
# discounted (not disqualified) before picking the highest score."
#
# An offer priced below this fraction of the median converged price is
# flagged low_confidence — cheap enough relative to its peers that it looks
# more like a pricing mistake or a gamed value than a genuine best deal.
LOW_CONFIDENCE_MEDIAN_RATIO = 0.5
# Floor on the discount multiplier for a flagged offer — a discount, not an
# exclusion, so it never hits exactly zero and can still win if nothing else
# comes close. The actual multiplier applied scales down from ~1.0 toward
# this floor the further below LOW_CONFIDENCE_MEDIAN_RATIO the offer sits, so
# a near-zero gamed price is discounted far harder than a merely-cheap one
# that just barely tripped the flag.
LOW_CONFIDENCE_MIN_DISCOUNT = 0.1
# Fallback weights, used only when an intent doesn't state its own. A real
# buyer's priorities differ per purchase — a deadline-driven restock weights
# speed far above price — so these are defaults, not the model.
PRICE_SCORE_WEIGHT = 0.5
SPEED_SCORE_WEIGHT = 0.3
TERMS_SCORE_WEIGHT = 0.2

# Deliberately small. Converging quickly is weak evidence of a good fit, but
# it is evidence about the process rather than about the offer, so it may
# only break ties — never outrank a materially better price or delivery.
CONVERGENCE_TIEBREAK_WEIGHT = 0.03


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _low_confidence_discount(total_price: float, median_price: float) -> float:
    """Proportional, not flat: an offer at exactly the flag threshold gets a
    mild discount, one approaching zero gets discounted down to the floor.
    `price / (median * ratio)` is 1.0 right at the threshold and shrinks
    toward 0 as price shrinks, which is exactly the "how extreme is this
    outlier" signal the discount should scale with."""
    if median_price <= 0:
        return LOW_CONFIDENCE_MIN_DISCOUNT
    severity = total_price / (median_price * LOW_CONFIDENCE_MEDIAN_RATIO)
    return max(LOW_CONFIDENCE_MIN_DISCOUNT, min(1.0, severity))


def _score_offer(
    total_price: float,
    rounds_used: int,
    max_spend: float,
    low_confidence: bool,
    median_price: float | None,
    intent: Any = None,
    lead_time_days: int | None = None,
    payment_terms: str | None = None,
) -> tuple[float, dict[str, Any]]:
    """Multi-attribute score, weighted by the buyer's own stated priorities.

    A purchase is won or lost on more than price. Three components:

      * **price** — how comfortably it fits under the stated budget.
      * **delivery** — how much slack it leaves against the deadline. A quote
        landing exactly on the last acceptable day is worth less than one
        arriving with room to spare, because the first has no tolerance for
        anything slipping.
      * **terms** — how close the payment terms land to what the buyer asked
        for. Credit is working capital; getting less of it than requested is a
        real cost, and more of it is a real benefit.

    Weights come from the intent, so a buyer who says speed matters more than
    price actually gets ranked that way. An outlier priced far below the pack
    is then discounted in proportion to how extreme it is, so a gamed
    near-zero price cannot win on raw cheapness alone.
    """
    price_score = _clamp01(1 - (total_price / max_spend)) if max_spend > 0 else 0.0

    # How quickly a vendor caved is a property of the *negotiation*, not of
    # the deal the buyer ends up with. Weighting it as half of "speed" made
    # the most expensive vendor win purely for accepting in round one — the
    # buyer's speed preference is about delivery, so that is what it scores.
    # Convergence survives only as a small tiebreaker between otherwise
    # comparable offers.
    convergence_score = (
        _clamp01(1 - (rounds_used - 1) / (MAX_ROUNDS - 1)) if MAX_ROUNDS > 1 else 1.0
    )

    ship_within = getattr(intent, "ship_within_days", None) or 1
    if lead_time_days is None:
        delivery_score = convergence_score
    else:
        # Full marks for same/next-day, scaling down to zero at the deadline.
        delivery_score = _clamp01((ship_within - lead_time_days + 1) / max(ship_within, 1))
    speed_score = round(delivery_score, 4)

    preferred = getattr(intent, "preferred_payment_terms", "net_30")
    preferred_days = CREDIT_DAYS.get(preferred, 30)
    offered_days = CREDIT_DAYS.get(payment_terms or "advance", 0)
    if preferred_days <= 0:
        terms_score = 1.0 if offered_days == 0 else 0.6
    else:
        # Meeting or beating the requested credit is full marks; falling short
        # scales down by how many days short it is.
        terms_score = _clamp01(offered_days / preferred_days)

    w_price = float(getattr(intent, "weight_price", PRICE_SCORE_WEIGHT) or PRICE_SCORE_WEIGHT)
    w_speed = float(getattr(intent, "weight_speed", SPEED_SCORE_WEIGHT) or SPEED_SCORE_WEIGHT)
    w_terms = float(getattr(intent, "weight_terms", TERMS_SCORE_WEIGHT) or TERMS_SCORE_WEIGHT)
    total_weight = w_price + w_speed + w_terms
    if total_weight <= 0:
        w_price, w_speed, w_terms, total_weight = 0.5, 0.3, 0.2, 1.0

    score = (
        w_price * price_score + w_speed * speed_score + w_terms * terms_score
    ) / total_weight
    score += CONVERGENCE_TIEBREAK_WEIGHT * convergence_score

    discount = 1.0
    if low_confidence and median_price is not None:
        discount = _low_confidence_discount(total_price, median_price)
        score *= discount

    breakdown = {
        "price_score": round(price_score, 4),
        "speed_score": speed_score,
        "delivery_score": round(delivery_score, 4),
        "convergence_score": round(convergence_score, 4),
        "terms_score": round(terms_score, 4),
        "weights": {
            "price": round(w_price / total_weight, 3),
            "speed": round(w_speed / total_weight, 3),
            "terms": round(w_terms / total_weight, 3),
        },
        "lead_time_days": lead_time_days,
        "payment_terms": payment_terms,
        "rounds_used": rounds_used,
        "low_confidence_discount_applied": low_confidence,
        "discount_multiplier": round(discount, 4),
    }
    return round(score, 4), breakdown


def run_marketplace_session(
    goal: str,
    max_spend: float,
    qty_min: int,
    qty_max: int,
    ship_within_days: int = 3,
    buyer_business_id: str | None = None,
    requested_lines: list[dict] | None = None,
) -> dict[str, Any]:
    """Broadcasts one buyer intent to every registered business concurrently —
    each runs its own full real negotiation against the same buyer agent
    (real OpenAI calls, real signed mandates) — then picks the winner by the
    lowest real total price among businesses that actually reached a deal.
    This is a prototype: 3 seeded businesses, not a registered-business
    marketplace with auth/onboarding — see project notes for what real scale
    would additionally need.

    `buyer_business_id` identifies which business is acting as buyer (e.g. a
    registered business restocking from another vendor). Defaults to the
    original constant so existing behavior/tests are unaffected when it's
    omitted."""

    buyer_business_id = buyer_business_id or "buyer_agent"

    # A business acting as buyer must never be a seller candidate against its
    # own restock request. Filtering unconditionally (rather than only when
    # buyer_business_id is a "real" id) is simplest and a no-op for the
    # default "buyer_agent" — no business is ever registered with that id.
    sellers = [b for b in BUSINESSES if b["id"] != buyer_business_id]
    if not sellers:
        raise ValueError("no other businesses available to negotiate with")

    intent = buyer_agent.create_intent(
        buyer_ref=buyer_business_id,
        goal=goal,
        max_spend=max_spend,
        qty_min=qty_min,
        qty_max=qty_max,
        ship_within_days=ship_within_days,
        requested_lines=requested_lines,
    )

    session_id = new_id("session")
    # One shared AuditLedger instance across all threads for this session —
    # its internal lock makes concurrent appends safe. Each business gets its
    # own thread creating a *new* ledger instance would corrupt the chain (see
    # AuditLedger docstring), so this single instance must be reused, never
    # re-constructed per thread.
    ledger = AuditLedger(session_id)
    ledger.append("intent_mandate.created", intent.model_dump())

    session: dict[str, Any] = {
        "id": session_id,
        "status": "negotiating",
        "intent": intent.model_dump(),
        "rounds": [],
        "final_cart": None,
        "payment_mandate": None,
        "razorpay_order": None,
        "razorpay_checkout_key": razorpay_client.PUBLIC_KEY_ID,
        "razorpay_payment_id": None,
        "transcript": [
            {
                "from": "buyer",
                "text": f"Broadcasting intent to {len(sellers)} businesses: {goal}, "
                f"max ₹{max_spend}, {qty_min}-{qty_max} units, ship in {ship_within_days} days.",
            }
        ],
        "offers": [],
        "winner_business_id": None,
        "pending_seller_confirmation": False,
        "margin_pct": None,
        "margin_floor_pct": None,
        "buyer_business_id": buyer_business_id,
        "seller_business_id": None,
        "created_at": time.time(),
    }
    _persist(session)
    return execute_marketplace(session, intent, ledger)


def list_price_subtotal(cart: Any, business: dict[str, Any]) -> float | None:
    """What this exact basket would cost at the vendor's sticker price.

    The honest "before" for a "before and after": identical SKUs, identical
    quantities, priced off `list_price` instead of what the agent talked the
    merchant down to. Goods only — freight is a function of the promised ETA,
    not something negotiated on price, so folding it in would flatter the
    saving.

    The upsell line is included, because it is included in `goods_subtotal`
    too; comparing a negotiated total that carries an upsell against a
    baseline that does not would invent a saving that never happened.

    Returns None if any line has no list price to compare against — a missing
    baseline must read as "unknown", never as zero.
    """
    by_sku = {item["sku"]: item for item in business.get("catalog", [])}
    lines = list(cart.items) + ([cart.upsell_item] if cart.upsell_item else [])
    total = 0.0
    for line in lines:
        entry = by_sku.get(line.sku)
        if entry is None or entry.get("list_price") is None:
            return None
        total += entry["list_price"] * line.qty
    return round(total, 2)


def _name_of(businesses: list[dict[str, Any]], business_id: str) -> str:
    return next(
        (b["name"] for b in businesses if b["id"] == business_id), business_id
    )


def execute_marketplace(
    session: dict[str, Any],
    intent: Any,
    ledger: AuditLedger,
) -> dict[str, Any]:
    """Runs the broadcast against an *already created* session. Split out of
    `run_marketplace_session` so the approval-gated flow can execute a session
    a human approved in an earlier request instead of creating a new one."""
    buyer_business_id = session.get("buyer_business_id") or "buyer_agent"
    max_spend = intent.max_spend
    candidates = [b for b in BUSINESSES if b["id"] != buyer_business_id]
    if not candidates:
        raise ValueError("no other businesses available to negotiate with")

    # Gate the fan-out *before* it happens. Ranking offers afterwards (see
    # `top_k_offers` below) sorts survivors of an expense already incurred;
    # this is the line that actually bounds what a purchase costs.
    gate = shortlist(
        candidates,
        qty_min=intent.qty_min,
        requested_lines=intent.requested_lines,
        orders_of=runtime.leaderboard.orders_for,
        seed=session["id"],
    )
    sellers = gate["selected"]
    if not sellers:
        raise ValueError("no other businesses available to negotiate with")

    # What the gate saved, in the unit that matters. Negotiation is the
    # expensive step, so eliminating a vendor before it starts is the only
    # place this cost can actually be avoided.
    per_vendor = economics.cost_per_vendor()
    eliminated = len(candidates) - len(sellers)
    session["shortlist"] = {
        "strategy": gate["strategy"],
        "k": gate["k"],
        "considered": len(candidates),
        "negotiating": len(sellers),
        "eliminated": eliminated,
        "explored_ids": gate.get("explored_ids", []),
        "bounds": gate["bounds"],
        "excluded": gate["excluded"],
        "saved": {
            "model_calls": round(eliminated * per_vendor["calls"], 1),
            "inr": round(eliminated * per_vendor["inr"], 3),
            "basis": "measured" if per_vendor["measured"] else "estimated",
        },
    }
    ledger.append("marketplace.shortlisted", session["shortlist"])
    economics.record_vendor_count(session["id"], len(sellers))

    session["status"] = "negotiating"
    _persist(session)
    _emit(
        session["id"],
        "marketplace.broadcast",
        {
            "vendor_count": len(sellers),
            "considered": len(candidates),
            "strategy": gate["strategy"],
            "vendors": [{"id": b["id"], "name": b["name"]} for b in sellers],
            "eliminated": [
                {
                    "id": e["business_id"],
                    "name": _name_of(candidates, e["business_id"]),
                    "bound": e["bound"],
                    "reason": e["reason"],
                }
                for e in gate["excluded"]
            ],
            "saved": session["shortlist"]["saved"],
        },
    )

    def negotiate(business: dict[str, Any]) -> dict[str, Any]:
        result = _negotiate_with_business(intent, business, ledger)
        return {"business": business, "result": result}

    with ThreadPoolExecutor(max_workers=len(sellers)) as pool:
        outcomes = list(pool.map(negotiate, sellers))

    offers = []
    for outcome in outcomes:
        business = outcome["business"]
        result = outcome["result"]
        cart = result["cart"]
        if cart is not None:
            # Keep every converged cart settleable, not just the top-scoring
            # one — see `session_manager._converged_offers`.
            remember_offer(session["id"], business["id"], cart)
        offers.append(
            {
                "business_id": business["id"],
                "business_name": business["name"],
                "status": result["status"],
                "cart": cart.model_dump() if cart is not None else None,
                "total_price": cart.total_price if cart is not None else None,
                "lead_time_days": cart.lead_time_days if cart is not None else None,
                "payment_terms": cart.payment_terms if cart is not None else None,
                "goods_subtotal": cart.goods_subtotal if cart is not None else None,
                # The same basket at sticker price, so the console can show
                # what the negotiation actually moved.
                "list_subtotal": (
                    list_price_subtotal(cart, business) if cart is not None else None
                ),
                "shipping_cost": cart.shipping_cost if cart is not None else None,
                "margin_pct": cart.margin_pct if cart is not None else None,
                "rounds": result["rounds"],
                # Defaults so every offer has a consistent shape in the
                # JSON response regardless of whether it converged — filled
                # in below only for offers with a valid cart.
                "low_confidence": False,
                "low_confidence_reason": None,
                "score": None,
                "score_breakdown": None,
            }
        )
        event = "marketplace.offer_received" if cart is not None else "marketplace.offer_failed"
        detail = {
            "business_id": business["id"],
            "business_name": business["name"],
            "status": result["status"],
            "total_price": cart.total_price if cart is not None else None,
            "goods_subtotal": cart.goods_subtotal if cart is not None else None,
            "list_subtotal": (
                list_price_subtotal(cart, business) if cart is not None else None
            ),
        }
        ledger.append(event, detail)
        _emit(session["id"], event, detail)

    session["offers"] = offers
    # Degraded if any vendor had to fall back — the buyer should know the
    # field they are choosing from was not fully negotiated.
    session["degraded"] = any(o["result"].get("degraded") for o in outcomes)

    valid_offers = [o for o in offers if o["cart"] is not None]
    if not valid_offers:
        session["status"] = "no_valid_offers"
        ledger.append("marketplace.no_valid_offers", {"business_count": len(sellers)})
        _persist(session)
        _emit(session["id"], "session.ended", {"status": "no_valid_offers"})
        return session

    # Outlier detection: a price dramatically below what everyone else
    # converged on reads more like a mistake or a gamed value than a genuine
    # best deal. Needs at least 2 valid offers to have a median to compare
    # against — with only one offer there's nothing to flag it against.
    prices = [o["total_price"] for o in valid_offers]
    median_price = statistics.median(prices) if len(prices) >= 2 else None

    for offer in valid_offers:
        is_outlier = bool(
            median_price is not None
            and median_price > 0
            and offer["total_price"] < LOW_CONFIDENCE_MEDIAN_RATIO * median_price
        )
        offer["low_confidence"] = is_outlier
        offer["low_confidence_reason"] = (
            f"₹{offer['total_price']:,.2f} is less than "
            f"{int(LOW_CONFIDENCE_MEDIAN_RATIO * 100)}% of the ₹{median_price:,.2f} median "
            f"across {len(valid_offers)} converged offers — unusually low vs other offers "
            "for similar items."
            if is_outlier
            else None
        )

        rounds_used = len(offer["rounds"]) or 1
        cart = offer["cart"] or {}
        score, breakdown = _score_offer(
            offer["total_price"],
            rounds_used,
            max_spend,
            is_outlier,
            median_price,
            intent=intent,
            lead_time_days=cart.get("lead_time_days"),
            payment_terms=cart.get("payment_terms"),
        )
        offer["score"] = score
        offer["score_breakdown"] = breakdown

        scored = {
            "business_id": offer["business_id"],
            "business_name": offer["business_name"],
            "total_price": offer["total_price"],
            "goods_subtotal": offer["goods_subtotal"],
            "list_subtotal": offer["list_subtotal"],
            "score": score,
            "score_breakdown": breakdown,
            "low_confidence": is_outlier,
            "low_confidence_reason": offer["low_confidence_reason"],
        }
        ledger.append("marketplace.offer_scored", scored)
        _emit(session["id"], "marketplace.offer_scored", scored)

    # Bounded heap selection rather than `max` over a full sort — O(n log k)
    # against O(n log n). This ranks the vendors that were *allowed* to
    # negotiate; the spend is bounded upstream by the shortlist gate. Taking
    # the top 3 (not just 1) also gives the console a runner-up board to show
    # *why* the winner won.
    ranked = top_k_offers(valid_offers, k=3)
    winner = ranked[0]

    # The claim the gate rests on: nobody we refused to negotiate with could
    # have undercut the price we got. Recorded either way — a shortlist that
    # skipped a cheaper vendor is precisely the fact an audit trail owes the
    # buyer, not one it should quietly drop.
    admissibility = verify_admissible(
        session.get("shortlist", {}).get("excluded", []),
        winner["total_price"],
    )
    session["shortlist_admissible"] = admissibility
    ledger.append("marketplace.shortlist_admissible", admissibility)
    _emit(session["id"], "marketplace.shortlist_admissible", admissibility)
    session["ranked_offers"] = [
        {
            "business_id": o["business_id"],
            "business_name": o["business_name"],
            "total_price": o["total_price"],
            "goods_subtotal": o["goods_subtotal"],
            "list_subtotal": o["list_subtotal"],
            "lead_time_days": o["lead_time_days"],
            "payment_terms": o["payment_terms"],
            "score": o["score"],
            "score_breakdown": o["score_breakdown"],
            "low_confidence": o["low_confidence"],
        }
        for o in ranked
    ]
    session["winner_business_id"] = winner["business_id"]
    ledger.append(
        "marketplace.winner_selected",
        {
            "winner_business_id": winner["business_id"],
            "winner_business_name": winner["business_name"],
            "winner_score": winner["score"],
            "median_price": median_price,
            "offers": [
                {
                    "business_id": o["business_id"],
                    "total_price": o["total_price"],
                    "score": o["score"],
                    "low_confidence": o["low_confidence"],
                    "status": o["status"],
                }
                for o in offers
            ],
        },
    )

    _emit(
        session["id"],
        "marketplace.winner_selected",
        {
            "winner_business_id": winner["business_id"],
            "winner_business_name": winner["business_name"],
            "winner_score": winner["score"],
            "total_price": winner["total_price"],
            "median_price": median_price,
            "ranked": session["ranked_offers"],
        },
    )

    winning_outcome = next(o for o in outcomes if o["business"]["id"] == winner["business_id"])
    winning_cart = winning_outcome["result"]["cart"]
    session["rounds"] = winning_outcome["result"]["rounds"]
    session["transcript"].extend(
        [{"from": "merchant", "text": f"[{winner['business_name']}] wins this round."}]
        + winning_outcome["result"]["transcript"]
    )

    _finalize_or_flag(
        session,
        ledger,
        winning_cart,
        merchant_ref=winner["business_id"],
        business=winning_outcome["business"],
    )
    _emit(session["id"], "session.ended", {"status": session["status"]})
    return session
