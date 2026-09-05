import json

import openai
from openai import OpenAI

from agents.fallback import evaluate_cart_offline
from agents.resilience import call_with_retry
from config import OPENAI_API_KEY, OPENAI_MODEL, OPENAI_TIMEOUT_SECONDS
from protocol.mandates import BuyerDecision, CartMandate, IntentMandate, RequestedLine
from orchestrator import economics
from protocol.signing import sign
from protocol.terms import CREDIT_DAYS, PaymentTerms, describe_terms

# The SDK refuses to construct without a key, so stand one in when none is
# configured. It is never used: `call_with_retry` short-circuits to the
# rule-based path before any request is made when HAS_OPENAI is false.
_client = OpenAI(
    api_key=OPENAI_API_KEY or "no-key-configured",
    timeout=OPENAI_TIMEOUT_SECONDS,
    max_retries=1,
)

_DECISION_SCHEMA = {
    "name": "buyer_decision",
    "schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["accept", "counter", "walk"]},
            "counter_on": {
                "type": "string",
                "enum": ["price", "lead_time", "payment_terms", "quantity"],
            },
            "reasoning": {"type": "string"},
        },
        "required": ["action", "counter_on", "reasoning"],
        "additionalProperties": False,
    },
    "strict": True,
}


def create_intent(
    buyer_ref: str,
    goal: str,
    max_spend: float,
    qty_min: int,
    qty_max: int,
    ship_within_days: int,
    requested_lines: list[dict] | None = None,
    preferred_payment_terms: PaymentTerms = "net_30",
    weight_price: float = 0.5,
    weight_speed: float = 0.3,
    weight_terms: float = 0.2,
) -> IntentMandate:
    intent = IntentMandate(
        buyer_ref=buyer_ref,
        goal=goal,
        max_spend=max_spend,
        qty_min=qty_min,
        qty_max=qty_max,
        ship_within_days=ship_within_days,
        requested_lines=[RequestedLine(**line) for line in (requested_lines or [])],
        preferred_payment_terms=preferred_payment_terms,
        weight_price=weight_price,
        weight_speed=weight_speed,
        weight_terms=weight_terms,
    )
    # The signature covers every bound the agent must not exceed — budget,
    # quantity band, delivery deadline, the credit ceiling, and the basket the
    # human actually asked for. Signing only price and quantity would leave the
    # terms unprotected, so an approved mandate could be settled on delivery,
    # credit, or a completely different set of goods the human never saw.
    intent.signature = sign(
        "buyer_agent",
        {
            "id": intent.id,
            "max_spend": intent.max_spend,
            "qty_min": intent.qty_min,
            "qty_max": intent.qty_max,
            "ship_within_days": intent.ship_within_days,
            "preferred_payment_terms": intent.preferred_payment_terms,
            "requested_lines": [
                {"name": line.name, "qty": line.qty} for line in intent.requested_lines
            ],
        },
    )
    return intent


def basket_shortfall(
    intent: IntentMandate, cart: CartMandate
) -> list[tuple[str, int, int]]:
    """Requested lines the cart under-delivers, as (name, asked, offered).

    Matched on item name, case-folded: each vendor sells the same goods under
    its own SKU, so SKU equality would fail for every vendor but one. The
    upsell line is deliberately excluded — an extra the merchant attached
    cannot count toward what the buyer asked for.
    """
    if not intent.requested_lines:
        return []
    offered: dict[str, int] = {}
    for item in cart.items:
        offered[item.name.casefold()] = offered.get(item.name.casefold(), 0) + item.qty
    return [
        (line.name, line.qty, offered.get(line.name.casefold(), 0))
        for line in intent.requested_lines
        if offered.get(line.name.casefold(), 0) < line.qty
    ]


def evaluate_cart(
    intent: IntentMandate,
    cart: CartMandate,
    round_num: int,
    max_rounds: int,
    previous_total: float | None = None,
) -> BuyerDecision:
    # Hard, code-enforced constraints — never let the model override these.
    # The LLM decides how to respond, not whether a bound was breached.
    if cart.total_price > intent.max_spend:
        return BuyerDecision(
            action="walk" if round_num >= max_rounds else "counter",
            counter_on="price",
            reasoning=(
                f"Cart total ₹{cart.total_price} exceeds max_spend ₹{intent.max_spend}; "
                "rejecting on hard budget constraint."
            ),
        )

    # A cart that arrives after the buyer needs it is not a cheaper deal, it
    # is a different (unusable) one. Enforced here rather than left to the
    # model, for the same reason as the budget.
    if cart.lead_time_days > intent.ship_within_days:
        return BuyerDecision(
            action="walk" if round_num >= max_rounds else "counter",
            counter_on="lead_time",
            reasoning=(
                f"Quoted lead time of {cart.lead_time_days} days misses the "
                f"{intent.ship_within_days}-day delivery window; rejecting on "
                "hard delivery constraint."
            ),
        )

    # A cart missing what the buyer named is not a cheaper deal, it is a
    # different one. Enforced in code alongside budget and lead time: the model
    # decides how to push back, never whether the basket was honoured.
    shortfalls = basket_shortfall(intent, cart)
    if shortfalls:
        detail = "; ".join(
            f"{name}: asked {asked}, offered {offered}"
            for name, asked, offered in shortfalls
        )
        return BuyerDecision(
            action="walk" if round_num >= max_rounds else "counter",
            counter_on="quantity",
            reasoning=(
                f"Cart does not cover the requested basket ({detail}); "
                "rejecting on hard basket constraint."
            ),
        )

    item_lines = ", ".join(
        f"{i.qty}x {i.name} ({i.sku}) @ ₹{i.unit_price}" for i in cart.items
    )
    headroom_pct = round((1 - cart.total_price / intent.max_spend) * 100, 1)
    rounds_left = max_rounds - round_num

    # Terms are a real part of the deal, so the buyer has to weigh them
    # rather than reading price in isolation. Credit shorter than preferred
    # costs the buyer working capital; a lead time at the deadline leaves no
    # slack if anything slips.
    offered_days = CREDIT_DAYS.get(cart.payment_terms, 0)
    preferred_days = CREDIT_DAYS.get(intent.preferred_payment_terms, 0)
    if offered_days < preferred_days:
        terms_line = (
            f"The terms are worse than you wanted by {preferred_days - offered_days} days of "
            "credit — that is working capital out of your pocket, so it is worth "
            "pushing on even if the price looks fine."
        )
    elif offered_days > preferred_days:
        terms_line = (
            f"The terms are better than you asked for ({offered_days - preferred_days} extra days "
            "of credit) — that has real cash-flow value, so weigh it against a slightly higher price."
        )
    else:
        terms_line = "The terms match what you asked for."

    improvement_line = "This is the merchant's opening offer — no prior round to compare against."
    improvement_pct = None
    if previous_total is not None and previous_total > 0:
        improvement_pct = round((previous_total - cart.total_price) / previous_total * 100, 1)
        if improvement_pct > 0:
            improvement_line = (
                f"That's a {improvement_pct}% drop from the previous offer of ₹{previous_total}."
            )
        elif improvement_pct < 0:
            improvement_line = (
                f"That's actually {-improvement_pct}% HIGHER than the previous offer of ₹{previous_total} "
                "— the merchant moved the wrong way."
            )
        else:
            improvement_line = f"That's unchanged from the previous offer of ₹{previous_total}."

    prompt = f"""You are a buyer agent. Your intent: goal="{intent.goal}",
max_spend=₹{intent.max_spend}, quantity {intent.qty_min}-{intent.qty_max} units,
ship within {intent.ship_within_days} days.

The merchant agent proposed this cart (round {round_num} of {max_rounds}, {rounds_left} rounds left after this):
{item_lines}
Total: ₹{cart.total_price} — that's {round(cart.total_price / intent.max_spend * 100, 1)}% of your budget, leaving {headroom_pct}% headroom.
Delivery: {cart.lead_time_days} days (you need it within {intent.ship_within_days}).
Goods ₹{cart.goods_subtotal} + freight ₹{cart.shipping_cost} = ₹{cart.total_price}. Freight scales with how fast you ask for it, so a later ETA is genuinely cheaper if your deadline allows.
Payment terms: {describe_terms(cart.payment_terms)} (you prefer {describe_terms(intent.preferred_payment_terms)}).
{terms_line}
{improvement_line}
Merchant's reasoning: {cart.reasoning}

Decide: accept, counter, or walk. Apply these rules directly based on the
numbers above — don't just aim to fill out every round:

- If headroom is under 10%, accept now. There isn't enough budget left to
  meaningfully negotiate further.
- If headroom is under ~30% AND the merchant just dropped the price by 8% or
  more from the previous offer, accept now — that's a real concession
  landing close to a fair price, squeezing for more reads as unreasonable.
- If headroom is still high (~30% or more), a single concession is not
  enough to accept on its own — there's real budget left on the table, so
  keep pushing (ask for a better price, more quantity, or added items) even
  after the merchant moves. Only ease up on this once headroom has come down
  into a more reasonable range or rounds are running out.
- If there are rounds left and neither accept condition above is met, counter
  with one specific, concrete ask (a target unit price, a different
  quantity, or an item to add/swap) — not a vague complaint.
- Price is not the only lever. If the merchant will not move on price, a
  shorter lead time or better payment terms can be worth more than a small
  discount — counter on whichever of those actually helps you most, and set
  `counter_on` to the lever you are pushing ("price", "lead_time",
  "payment_terms" or "quantity").
- Weigh the levers by your stated priorities: price {intent.weight_price},
  delivery speed {intent.weight_speed}, payment terms {intent.weight_terms}.
  If speed matters more to you than price, do not trade away a fast delivery
  for a small saving.
- If you're down to the last round or two, accept a good-faith offer rather
  than walking away over a small remaining gap.
- Walk only if the merchant has refused to move at all (same or worse offer)
  after you've already pushed back at least once, or the deal is genuinely
  bad regardless of budget.

Give brief reasoning either way, and if you accept because of the rules
above, say so explicitly (e.g. "headroom is only X%" or "that's an N% price
drop, taking it").
"""

    try:
        completion = call_with_retry(
            lambda: _client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_schema", "json_schema": _DECISION_SCHEMA},
            )
        )
    except openai.OpenAIError:
        # The buyer's rules are stated in the prompt and operate on numbers
        # already computed here, so applying them directly loses very little.
        decision = evaluate_cart_offline(intent, cart, round_num, max_rounds, previous_total)
        decision.degraded = True
        return decision
    economics.record(completion.usage, session_id=intent.id, agent="buyer")
    data = json.loads(completion.choices[0].message.content)

    action = data["action"]
    if action == "counter" and round_num >= max_rounds:
        action = "accept" if cart.total_price <= intent.max_spend else "walk"

    return BuyerDecision(
        action=action,
        counter_on=data.get("counter_on"),
        reasoning=data["reasoning"],
    )
