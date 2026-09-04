"""One definition of margin, used everywhere.

There were previously two, silently compared against each other:

  * pricing clamped to a **markup on cost** — `cost * (1 + floor/100)`
  * reporting measured **margin on revenue** — `(revenue - cost) / revenue`

Those are different quantities. A 12% floor clamped a ₹100-cost item to ₹112,
which reports as `12/112` = 10.71% margin — under its own floor, for every
item, on every round. The clamp was correct and the measurement was correct;
comparing them was not. It made the near-floor escalation fire on healthy
deals and made the floor look violated when it never was.

`margin_floor_pct` is named margin, so margin-on-revenue is the definition
that wins. Inverting it gives the minimum sellable price:

    margin = (price - cost) / price   =>   price = cost / (1 - margin)
"""

# Guard against a 100%+ floor, which has no finite price solution.
MAX_MARGIN_FLOOR_PCT = 95.0

# A converged deal landing within this many points of the seller's floor is
# too thin to auto-finalise and is escalated for human seller confirmation.
# Lives here rather than in the orchestrator because the offline pricing rules
# need it too — a second copy of this number is how the margin definitions
# drifted apart the first time.
NEAR_FLOOR_BUFFER_PCT = 3.0


def min_sellable_price(cost: float, margin_floor_pct: float) -> float:
    """Cheapest unit price that still clears `margin_floor_pct` margin on
    revenue. The inverse of `margin_pct` below, so a cart priced at exactly
    this value measures at exactly the floor."""
    floor = min(max(margin_floor_pct, 0.0), MAX_MARGIN_FLOOR_PCT)
    return round(cost / (1 - floor / 100), 2)


def margin_pct(revenue: float, cost: float) -> float:
    """Margin on revenue, as a percentage."""
    if revenue <= 0:
        return 0.0
    return round((revenue - cost) / revenue * 100, 2)
