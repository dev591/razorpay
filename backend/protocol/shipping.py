"""Freight, priced off the promised ETA.

Previously the cost of a fast delivery was folded into unit price as an
"expedite premium". No real quote works that way: a buyer sees goods on one
line and freight on another, and the freight line is what moves when they ask
for it sooner. Burying it in unit price also corrupted the margin story —
a rush charge is not gross margin on goods, but it was being measured as if
it were.

So freight is now explicit:

  * it scales with **units**, because that is what fills a vehicle, and
  * it is multiplied by an **ETA factor**, because same-day costs a dedicated
    run while a two-week window rides on whatever is already going that way.

Freight is treated as a pass-through: it is added to the invoice total but
excluded from the margin the floor is enforced against. A merchant does not
earn its margin on someone else's diesel.
"""

# Indicative Indian surface-freight economics for small B2B consignments.
BASE_FREIGHT_PER_UNIT = 11.0
MIN_FREIGHT = 240.0

# Standard despatch. At or beyond this, freight is at its base rate.
STANDARD_ETA_DAYS = 7

# Multiplier by promised ETA. Steep at the short end because next-day is a
# dedicated vehicle, not a slot on a shared one.
_ETA_MULTIPLIERS: list[tuple[int, float]] = [
    (1, 2.60),
    (2, 2.00),
    (3, 1.60),
    (4, 1.35),
    (5, 1.18),
    (6, 1.07),
    (7, 1.00),
]

# Beyond standard, a longer window earns a small consolidation discount —
# floored, because freight never becomes free.
LONG_WINDOW_DISCOUNT_PER_DAY = 0.02
MIN_ETA_MULTIPLIER = 0.85


def eta_multiplier(lead_time_days: int) -> float:
    """Freight multiplier for a promised ETA."""
    days = max(1, int(lead_time_days))
    for threshold, multiplier in _ETA_MULTIPLIERS:
        if days <= threshold:
            return multiplier
    extra_days = days - STANDARD_ETA_DAYS
    return round(max(1.0 - extra_days * LONG_WINDOW_DISCOUNT_PER_DAY, MIN_ETA_MULTIPLIER), 4)


def freight_cost(units: int, lead_time_days: int) -> float:
    """What shipping this consignment at this ETA costs the buyer."""
    if units <= 0:
        return 0.0
    raw = units * BASE_FREIGHT_PER_UNIT * eta_multiplier(lead_time_days)
    return round(max(raw, MIN_FREIGHT), 2)


def describe_freight(units: int, lead_time_days: int) -> str:
    multiplier = eta_multiplier(lead_time_days)
    if multiplier > 1:
        speed = f"{multiplier:.2f}x expedited"
    elif multiplier < 1:
        speed = "consolidated"
    else:
        speed = "standard"
    return f"{units} units, {lead_time_days}-day ETA ({speed})"
