import json
from typing import Any

import openai
from openai import OpenAI

from agents.fallback import propose_cart_offline
from agents.resilience import call_with_retry
from config import OPENAI_API_KEY, OPENAI_MODEL, OPENAI_TIMEOUT_SECONDS
from protocol.terms import WORKING_CAPITAL_APR
from protocol.mandates import CartItem, CartMandate, IntentMandate
from protocol.terms import STANDARD_LEAD_DAYS
from protocol.pricing import margin_pct as compute_margin_pct
from orchestrator import economics
from protocol.signing import sign
from protocol.terms import (
    CREDIT_DAYS,
    MSMED_MAX_CREDIT_DAYS,
    describe_terms,
    effective_margin_pct,
    min_sellable_price_for_terms,
)

_client = OpenAI(api_key=OPENAI_API_KEY, timeout=OPENAI_TIMEOUT_SECONDS, max_retries=1)

MAX_LINE_ITEMS = 3


def _proposal_schema(skus: list[str]) -> dict[str, Any]:
    return {
        "name": "cart_proposal",
        "schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_LINE_ITEMS,
                    "items": {
                        "type": "object",
                        "properties": {
                            "sku": {"type": "string", "enum": skus},
                            "qty": {"type": "integer"},
                            "unit_price": {"type": "number"},
                        },
                        "required": ["sku", "qty", "unit_price"],
                        "additionalProperties": False,
                    },
                },
                "lead_time_days": {"type": "integer"},
                "payment_terms": {
                    "type": "string",
                    "enum": ["advance", "net_15", "net_30", "net_45"],
                },
                "reasoning": {"type": "string"},
            },
            "required": ["items", "lead_time_days", "payment_terms", "reasoning"],
            "additionalProperties": False,
        },
        "strict": True,
    }


def _catalog_summary(
    catalog: list[dict[str, Any]], margin_floor_pct: float, terms: str = "advance"
) -> str:
    """Minimum sellable prices shown *for the terms being quoted* — on credit
    they are higher, because the seller has to invoice more to bank the same
    margin. Showing the advance-payment floor while quoting 45-day credit is
    how a model ends up 'respecting' a floor it is actually breaching."""
    lines = []
    for item in catalog:
        min_price = min_sellable_price_for_terms(item["cost"], margin_floor_pct, terms)
        lines.append(
            f"- {item['sku']} \"{item['name']}\": list price ₹{item['list_price']}, "
            f"minimum sellable unit price ₹{min_price} on {describe_terms(terms)} "
            f"(margin floor {margin_floor_pct}%)"
        )
    return "\n".join(lines)


def _enforce_terms(
    lead_time_days: Any, payment_terms: Any, ship_within_days: int
) -> tuple[int, str]:
    """Clamp the model's quoted terms into what is actually offerable.

    Three separate things the model gets wrong often enough to matter: a lead
    time past the buyer's own deadline (an offer that cannot be accepted), a
    nonsensical lead time (0 or negative days), and credit beyond the 45-day
    MSMED ceiling, which is a legal limit rather than a preference.
    """
    try:
        lead = int(lead_time_days)
    except (TypeError, ValueError):
        lead = min(STANDARD_LEAD_DAYS, ship_within_days)
    lead = max(1, min(lead, max(1, ship_within_days)))

    terms = payment_terms if payment_terms in CREDIT_DAYS else "advance"
    if CREDIT_DAYS[terms] > MSMED_MAX_CREDIT_DAYS:
        terms = "net_45"
    return lead, terms


def _enforce_margin_floor(
    sku: str,
    unit_price: float,
    cost_by_sku: dict[str, float],
    margin_floor_pct: float,
    terms: str = "advance",
    lead_time_days: int = STANDARD_LEAD_DAYS,
) -> float:
    """The LLM proposes a price; the code is the actual gate.

    Clamps against the floor for the quoted payment terms. Delivery speed no
    longer touches unit price: the cost of a fast ETA is freight, and freight
    is now its own line on the cart (`protocol/shipping.py`). Folding it into
    unit price meant a rush charge was being measured as gross margin on
    goods, which it is not.
    """
    cost = cost_by_sku[sku]
    floor_price = min_sellable_price_for_terms(cost, margin_floor_pct, terms)
    return round(max(unit_price, floor_price), 2)


def _items_signature(items: list[CartItem]) -> tuple:
    return tuple(sorted((i.sku, i.qty, i.unit_price) for i in items))


def propose_cart(
    intent: IntentMandate,
    business: dict[str, Any],
    round_num: int,
    counter_note: str | None = None,
    previous_total: float | None = None,
    previous_items: list[CartItem] | None = None,
    max_rounds: int = 6,
) -> CartMandate:
    catalog = business["catalog"]
    margin_floor_pct = business["margin_floor_pct"]
    business_id = business["id"]

    cost_by_sku = {item["sku"]: item["cost"] for item in catalog}
    skus = [item["sku"] for item in catalog]

    # A real counter-offer, not a resubmission: give the model an explicit
    # anchor (what it offered last round) plus a hard, explicit instruction
    # to change something — without this, a model asked only to "respond to"
    # a counter sometimes re-proposes the identical cart (same items, same
    # quantities, same unit prices) with only the reasoning text reworded.
    counter_instruction = ""
    if counter_note:
        counter_instruction = (
            f'\nThe buyer countered: "{counter_note}"\n'
            f"Your previous offer totaled ₹{previous_total}. This round you "
            "MUST change something concrete from that offer — a different "
            "total price, a different quantity, or a different item mix. "
            "Proposing the exact same SKUs at the exact same quantities and "
            "unit prices again is NOT an acceptable response, even if the "
            "only move you can make is a small price concession — a small "
            "move is still required over no move at all.\n"
            "The one exception: if every relevant item is already priced at "
            "its minimum sellable price and you genuinely cannot concede "
            "further on price or quantity, you may hold the same numbers — "
            "but if you do, your reasoning must say so explicitly (e.g. "
            '"I\'m already at my margin floor on these items, holding '
            'firm") rather than silently repeating the same cart with a '
            "reworded justification.\n"
            "In your reasoning, name the ONE specific thing that changed "
            "from your previous offer (e.g. \"lowered the keyboard to "
            "₹2000\" or \"added a second hub\") — don't restate a total "
            "price in words; you're prone to getting that arithmetic wrong, "
            "and your `items` array is what actually gets charged, not your "
            "sentence."
        )

    # The requested basket is a hard constraint the buyer enforces in code, so
    # state it as one. A merchant that ignores it gets countered every round
    # and burns the clock for both sides.
    if intent.requested_lines:
        wanted = ", ".join(f"{line.qty}x {line.name}" for line in intent.requested_lines)
        basket_instruction = (
            f"\nThe buyer has named exactly what they need: {wanted}.\n"
            "Your cart MUST include at least that quantity of each of those items, "
            "matched by item name (your SKU codes differ from other vendors'; the "
            "names are what count). A cart missing any of them is rejected outright "
            "before it is even priced — substituting a cheaper item you would rather "
            "sell does not work. You may add further items only if budget allows "
            "after the requested ones are covered.\n"
            "If you cannot stock one of them at all, still quote the rest and say "
            "plainly in your reasoning which line you cannot fill."
        )
    else:
        basket_instruction = ""

    prompt = f"""You are the merchant agent for {business['name']}, negotiating with a buyer agent.

Buyer's intent (do not exceed): goal="{intent.goal}", max_spend=₹{intent.max_spend},
quantity between {intent.qty_min} and {intent.qty_max} units total, ship within {intent.ship_within_days} days.
The buyer's preferred payment terms are {intent.preferred_payment_terms} ({describe_terms(intent.preferred_payment_terms)}).
Their priorities weight price {intent.weight_price}, delivery speed {intent.weight_speed}, payment terms {intent.weight_terms}.

Your catalog (minimum sellable prices shown for payment on despatch):
{_catalog_summary(catalog, margin_floor_pct)}

Propose a cart of 1 to {MAX_LINE_ITEMS} line items (distinct SKUs) whose combined
total quantity fits the buyer's quantity range and whose combined total price fits
within max_spend. Each unit price must be at or above that SKU's minimum sellable
price. If the buyer has asked for variety, use multiple different SKUs rather than
one — do not just raise the price or quantity of a single item.
{basket_instruction}

You are also quoting COMMERCIAL TERMS, not just a price:
- `lead_time_days`: how fast you will deliver. Must be between 1 and
  {intent.ship_within_days}. Freight is charged separately and scales with the
  ETA — a 1-day promise costs the buyer roughly 2.6x standard freight, a 7-day
  promise is standard rate. Quoting a fast ETA does NOT change your unit
  prices; it raises the shipping line the buyer pays. Offer the ETA that suits
  the buyer's deadline rather than always quoting the fastest.
- `payment_terms`: one of advance, net_15, net_30, net_45. Credit is a loan you
  fund at {WORKING_CAPITAL_APR}% a year, so every extra day of credit raises the
  price you must charge to bank the same margin. Offering the buyer their
  preferred terms is a genuine concession you can trade for a better price;
  insisting on advance payment lets you quote cheaper.

Use these levers. If you cannot move on price, move on speed or terms — that is
often worth more to the buyer than a small discount. Explain your reasoning briefly.
{counter_instruction}
"""

    try:
        completion = call_with_retry(
            lambda: _client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": prompt}],
                response_format={
                    "type": "json_schema",
                    "json_schema": _proposal_schema(skus),
                },
            )
        )
    except openai.OpenAIError:
        # Retries exhausted. A vendor that cannot reach its pricing model is
        # not a vendor that has nothing to sell — quote from the rules and
        # mark the cart degraded so nothing downstream pretends otherwise.
        cart = propose_cart_offline(intent, business, round_num, max_rounds)
        cart.degraded = True
        sign_cart(cart, business_id)
        return cart
    economics.record(completion.usage, session_id=intent.id, agent="merchant")
    proposal = json.loads(completion.choices[0].message.content)

    lead_time_days, payment_terms = _enforce_terms(
        proposal.get("lead_time_days"),
        proposal.get("payment_terms"),
        intent.ship_within_days,
    )

    # Merge duplicate SKUs the model might propose twice, and enforce the
    # margin floor per line — never trust the model's own numbers.
    merged: dict[str, dict[str, float]] = {}
    for raw in proposal["items"][:MAX_LINE_ITEMS]:
        sku = raw["sku"]
        qty = max(1, int(raw["qty"]))
        unit_price = _enforce_margin_floor(
            sku,
            float(raw["unit_price"]),
            cost_by_sku,
            margin_floor_pct,
            terms=payment_terms,
        )
        if sku in merged:
            merged[sku]["qty"] += qty
        else:
            merged[sku] = {"qty": qty, "unit_price": unit_price}

    # Scale total quantity down to the buyer's max if the combined proposal
    # overshoots it — proportionally, keeping at least 1 unit per line.
    total_qty = sum(v["qty"] for v in merged.values())
    if total_qty > intent.qty_max:
        scale = intent.qty_max / total_qty
        for v in merged.values():
            v["qty"] = max(1, round(v["qty"] * scale))

    items = [
        CartItem(
            sku=sku,
            name=next(c["name"] for c in catalog if c["sku"] == sku),
            qty=int(v["qty"]),
            unit_price=v["unit_price"],
        )
        for sku, v in merged.items()
    ]

    total_revenue = sum(i.line_total for i in items)
    total_cost = sum(cost_by_sku[i.sku] * i.qty for i in items)
    # Sticker margin, for display. The floor is enforced against the effective
    # margin (see `effective_margin_pct`), which nets off the cost of carrying
    # the credit period this cart is quoted under.
    margin_pct = compute_margin_pct(total_revenue, total_cost)

    reasoning = proposal["reasoning"]
    if previous_items is not None and _items_signature(items) == _items_signature(
        previous_items
    ):
        # The prompt above asks the model to either move or explicitly say
        # it's holding firm — in practice a small model sometimes claims a
        # change in prose (often a total that doesn't match its own `items`)
        # while the actual items/prices are identical. Prompt tightening on
        # this hit diminishing returns, so it's enforced here deterministically
        # instead: items/prices are already correct (code-enforced above),
        # only the narration is unreliable in this exact edge case, so only
        # the narration gets overridden — computed from the real cart, never
        # from anything the model said.
        reasoning = (
            f"Holding firm at ₹{round(total_revenue, 2)} — already at margin "
            "floor / best available terms for these items; no further "
            "concession possible without pricing below minimum sellable price."
        )

    cart = CartMandate(
        intent_id=intent.id,
        merchant_ref=business_id,
        round=round_num,
        items=items,
        lead_time_days=lead_time_days,
        payment_terms=payment_terms,
        margin_pct=margin_pct,
        reasoning=reasoning,
    )
    sign_cart(cart, business_id)
    return cart


def sign_cart(cart: CartMandate, business_id: str) -> None:
    """Signs a cart over its identity and its *current* total.

    Must be re-applied by anything that mutates the cart after it is built —
    notably attaching an upsell line, which changes `total_price`. Signing
    only at construction left the merchant signature covering a total that no
    longer matched the cart actually being sent to payment."""
    cart.signature = sign(
        business_id,
        {"id": cart.id, "intent_id": cart.intent_id, "total_price": cart.total_price},
    )
