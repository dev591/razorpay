"""Commercial terms: the dimensions a real purchase is negotiated on.

Price alone is not a negotiation. A buyer in this market trades across four
levers at once, and a merchant concedes on whichever costs it least:

  * **unit price** — the obvious one
  * **lead time** — faster costs the seller expediting/overtime, slower frees
    capacity, so the price should move with it in both directions
  * **payment terms** — cash up front is worth a discount; credit is a loan
    the seller funds, so it carries a cost
  * **quantity** — already in the intent as a min/max band

The important consequence for a margin floor: a rupee collected in 45 days is
not a rupee. A seller quoting the same sticker price on `advance` and on
`net_45` is quietly earning several points less margin on the second, and a
floor checked against sticker price would not notice. So the floor here is
enforced on **net realisable revenue** — price minus the cost of carrying the
receivable — which is what the seller actually banks.

Rates are Indian-SMB realistic: working capital lines run in the high teens,
and the classic cash discount is ~2%.
"""

from typing import Literal

PaymentTerms = Literal["advance", "net_15", "net_30", "net_45"]

# Days of credit each term grants the buyer.
CREDIT_DAYS: dict[str, int] = {
    "advance": 0,
    "net_15": 15,
    "net_30": 30,
    "net_45": 45,
}

# Section 43B(h) / the MSMED Act cap payment to a registered micro or small
# enterprise at 45 days, so no term beyond that is offerable here — it isn't a
# tuning knob, it's the legal ceiling.
MSMED_MAX_CREDIT_DAYS = 45

# Annualised cost of the seller carrying the receivable. Indian SMB working
# capital sits in the high teens; 18% is a defensible mid-point.
WORKING_CAPITAL_APR = 18.0

# The classic "2/10" cash discount: paying up front is worth ~2% off, because
# the seller avoids both the financing cost and the collection risk.
ADVANCE_DISCOUNT_PCT = 2.0

# Lead time. Anything faster than standard is expedited and costs the seller
# real money (overtime, priority freight); anything slower frees up capacity
# and is worth a modest concession.
STANDARD_LEAD_DAYS = 7
EXPEDITE_PREMIUM_PCT_PER_DAY = 0.9
SLACK_DISCOUNT_PCT_PER_DAY = 0.35
MAX_EXPEDITE_PREMIUM_PCT = 12.0
MAX_SLACK_DISCOUNT_PCT = 5.0


def validate_payment_terms(terms: str) -> str:
    if terms not in CREDIT_DAYS:
        raise ValueError(
            f"unknown payment terms {terms!r}; expected one of {sorted(CREDIT_DAYS)}"
        )
    if CREDIT_DAYS[terms] > MSMED_MAX_CREDIT_DAYS:
        raise ValueError(f"{terms} exceeds the {MSMED_MAX_CREDIT_DAYS}-day MSMED cap")
    return terms


def financing_cost(amount: float, terms: str) -> float:
    """What the seller gives up by waiting for the money. Zero on advance."""
    days = CREDIT_DAYS.get(terms, 0)
    if days <= 0 or amount <= 0:
        return 0.0
    return round(amount * (WORKING_CAPITAL_APR / 100) * (days / 365), 2)


def net_realisable(amount: float, terms: str) -> float:
    """Revenue the seller actually banks, after carrying the receivable.

    This — not the sticker price — is what a margin floor has to be measured
    against, or a seller can 'hold the floor' on paper while conceding real
    margin through the terms instead.
    """
    return round(amount - financing_cost(amount, terms), 2)


def lead_time_adjustment_pct(lead_time_days: int) -> float:
    """Percentage to move price by for a lead time away from standard.

    Positive is a premium the seller charges for rushing; negative is a
    concession for being allowed to take longer.
    """
    delta = STANDARD_LEAD_DAYS - lead_time_days
    if delta > 0:
        return round(min(delta * EXPEDITE_PREMIUM_PCT_PER_DAY, MAX_EXPEDITE_PREMIUM_PCT), 2)
    if delta < 0:
        return round(-min(-delta * SLACK_DISCOUNT_PCT_PER_DAY, MAX_SLACK_DISCOUNT_PCT), 2)
    return 0.0


def effective_margin_pct(revenue: float, cost: float, terms: str) -> float:
    """Margin on what the seller banks, not on what it invoices."""
    realisable = net_realisable(revenue, terms)
    if realisable <= 0:
        return 0.0
    return round((realisable - cost) / realisable * 100, 2)


def min_sellable_price_for_terms(cost: float, margin_floor_pct: float, terms: str) -> float:
    """Cheapest unit price clearing the floor *given these payment terms*.

    Inverts `effective_margin_pct`: the seller has to invoice more on credit
    to bank the same margin, so the floor price rises with the credit period.
    """
    from protocol.pricing import MAX_MARGIN_FLOOR_PCT

    floor = min(max(margin_floor_pct, 0.0), MAX_MARGIN_FLOOR_PCT)
    days = CREDIT_DAYS.get(terms, 0)
    # realisable = price * (1 - apr*days/365); require (realisable-cost)/realisable >= floor
    carry = (WORKING_CAPITAL_APR / 100) * (days / 365)
    denominator = (1 - floor / 100) * (1 - carry)
    if denominator <= 0:
        return float("inf")
    return round(cost / denominator, 2)


def describe_terms(terms: str) -> str:
    days = CREDIT_DAYS.get(terms, 0)
    return "payment on despatch" if days == 0 else f"{days}-day credit"
