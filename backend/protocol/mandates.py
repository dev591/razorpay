import math
import time
import uuid
from typing import Literal, Optional

from pydantic import BaseModel, Field, computed_field

from protocol.shipping import freight_cost
from protocol.terms import (
    CREDIT_DAYS,
    MSMED_MAX_CREDIT_DAYS,
    PaymentTerms,
    financing_cost,
    net_realisable,
)

# Sanity cap on a buyer's stated budget — not a business rule, just a guard
# against absurd/gamed input reaching real OpenAI negotiation and Razorpay
# order creation. Mirrors the per-catalog-item price cap in agents/businesses.py.
MAX_SPEND_CAP = 10_000_000.0


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def validate_max_spend(max_spend: float) -> None:
    """Raises ValueError on 0, negative, non-finite, or absurdly large budgets.
    Call this at the API boundary, before any negotiation starts, so bad input
    is a clean rejection rather than something that silently reaches an LLM
    call or a real Razorpay order."""
    if not math.isfinite(max_spend) or max_spend <= 0:
        raise ValueError("max_spend must be a positive number")
    if max_spend > MAX_SPEND_CAP:
        raise ValueError(f"max_spend must not exceed {MAX_SPEND_CAP:,.0f}")


# Quantity guards. A band is only meaningful if it is a band: qty_min above
# qty_max describes nothing, and an unbounded upper end lets a model propose
# a cart of a million units that no floor check would flag, because per-unit
# margin stays fine while the total goes absurd.
MAX_QUANTITY = 100_000
MAX_SHIP_WINDOW_DAYS = 365


def validate_quantity_band(qty_min: int, qty_max: int) -> None:
    if qty_min <= 0 or qty_max <= 0:
        raise ValueError("quantities must be positive")
    if qty_min > qty_max:
        raise ValueError(f"qty_min ({qty_min}) cannot exceed qty_max ({qty_max})")
    if qty_max > MAX_QUANTITY:
        raise ValueError(f"qty_max must not exceed {MAX_QUANTITY:,}")


def validate_ship_window(ship_within_days: int) -> None:
    if ship_within_days <= 0:
        raise ValueError("ship_within_days must be at least 1")
    if ship_within_days > MAX_SHIP_WINDOW_DAYS:
        raise ValueError(f"ship_within_days must not exceed {MAX_SHIP_WINDOW_DAYS}")


MAX_REQUESTED_LINES = 6


def validate_requested_lines(lines: list[dict] | None, qty_max: int) -> None:
    """The basket has to be buyable before anyone spends a model call on it."""
    if not lines:
        return
    if len(lines) > MAX_REQUESTED_LINES:
        raise ValueError(
            f"at most {MAX_REQUESTED_LINES} distinct items per request, got {len(lines)}"
        )
    seen: set[str] = set()
    total = 0
    for line in lines:
        name = str(line.get("name", "")).strip()
        qty = int(line.get("qty", 0))
        if not name:
            raise ValueError("every requested item needs a name")
        key = name.casefold()
        if key in seen:
            raise ValueError(f"'{name}' is requested twice; combine it into one line")
        seen.add(key)
        if qty < 1:
            raise ValueError(f"'{name}' needs a quantity of at least 1")
        total += qty
    if total > qty_max:
        raise ValueError(
            f"the requested items add up to {total} units, above the {qty_max}-unit ceiling"
        )


def check_basket_available(lines: list[dict] | None) -> None:
    """Rejects a basket no registered vendor stocks at all.

    Matched on name rather than SKU: each vendor prices the same goods under
    its own SKU, and a buyer shopping a marketplace asks for "Wireless Mouse",
    not "QS-01".
    """
    if not lines:
        return
    from agents.businesses import BUSINESSES

    stocked = {
        item["name"].casefold()
        for business in BUSINESSES
        for item in business["catalog"]
    }
    missing = [
        line["name"] for line in lines
        if str(line.get("name", "")).strip().casefold() not in stocked
    ]
    if missing:
        raise ValueError(
            "no registered vendor stocks: " + ", ".join(missing)
        )


def check_basket_affordable(
    lines: list[dict] | None, qty_min: int, max_spend: float
) -> None:
    """Rejects a basket no vendor could fill inside the budget.

    `check_budget_feasible` asks whether the budget buys `qty_min` of the
    cheapest thing on offer; once the buyer names specific goods that is much
    too weak a test. Twenty keyboards cost what eighty mice do, so a basket can
    be wildly unaffordable while passing the generic check — and the buyer would
    only find out after a full round of real negotiations returned nothing.

    Uses the same provable floor as the shortlist: the cheapest vendor's total
    at its own margin floor. If that exceeds the budget, no negotiation can
    succeed, so say so now and name the number.
    """
    if not lines:
        return
    from agents.businesses import BUSINESSES
    from protocol.pricing import min_sellable_price

    best: float | None = None
    for business in BUSINESSES:
        by_name = {item["name"].casefold(): item for item in business["catalog"]}
        floor_pct = business["margin_floor_pct"]
        total = 0.0
        covered = 0
        fillable = True
        for line in lines:
            item = by_name.get(str(line["name"]).strip().casefold())
            if item is None:
                fillable = False
                break
            total += min_sellable_price(item["cost"], floor_pct) * int(line["qty"])
            covered += int(line["qty"])
        if not fillable:
            continue
        remainder = max(qty_min - covered, 0)
        if remainder:
            total += min(
                min_sellable_price(i["cost"], floor_pct) for i in business["catalog"]
            ) * remainder
        if best is None or total < best:
            best = round(total, 2)

    if best is None:
        raise ValueError("no single vendor stocks every requested item")
    if max_spend < best:
        detail = ", ".join(f"{line['qty']}x {line['name']}" for line in lines)
        raise ValueError(
            f"budget of ₹{max_spend:,.2f} cannot buy {detail}: the cheapest vendor "
            f"can only reach ₹{best:,.2f} at its own margin floor"
        )


def check_budget_feasible(max_spend: float, qty_min: int) -> None:
    """Rejects a budget no vendor could possibly fill.

    Imported lazily: `agents.businesses` reads the catalog, and importing it
    at module scope here would make the protocol layer depend on the agent
    layer, inverting the dependency direction the rest of the package keeps.
    """
    from agents.businesses import BUSINESSES
    from protocol.pricing import min_sellable_price

    cheapest = None
    for business in BUSINESSES:
        for item in business["catalog"]:
            price = min_sellable_price(item["cost"], business["margin_floor_pct"])
            if cheapest is None or price < cheapest:
                cheapest = price
    if cheapest is None:
        return

    floor_total = round(cheapest * qty_min, 2)
    if max_spend < floor_total:
        raise ValueError(
            f"budget of ₹{max_spend:,.2f} cannot buy {qty_min} units: the cheapest "
            f"item any vendor can sell at its margin floor is ₹{cheapest:,.2f}, so "
            f"{qty_min} units cost at least ₹{floor_total:,.2f}"
        )


class CartItem(BaseModel):
    sku: str
    name: str
    qty: int
    unit_price: float

    # `computed_field`, not a plain `@property`: a bare property is invisible
    # to `model_dump()`, so every cart we persisted or returned over the API
    # silently omitted its own totals and callers had to re-derive them (or,
    # as the leaderboard did, read zero).
    @computed_field
    @property
    def line_total(self) -> float:
        return round(self.qty * self.unit_price, 2)


class RequestedLine(BaseModel):
    """One item the buyer actually wants, and how many.

    A single free-text goal plus one total quantity band can only ever express
    "sell me ~50 of something". A named basket is what a real restock looks
    like, and it makes the negotiation harder in a useful way: a vendor cannot
    win by loading the cart with whatever it happens to be cheapest at, and no
    single vendor is cheapest on every line, so the trade-offs get real.
    """

    name: str
    qty: int


class IntentMandate(BaseModel):
    id: str = Field(default_factory=lambda: new_id("intent"))
    type: Literal["intent_mandate"] = "intent_mandate"
    buyer_ref: str
    goal: str
    max_spend: float
    qty_min: int
    qty_max: int
    ship_within_days: int
    # The specific basket, when the buyer named one. Empty means "anything that
    # fits the quantity band", which is the original behaviour.
    requested_lines: list[RequestedLine] = Field(default_factory=list)
    # What the buyer would *like* on terms, and how much each lever matters to
    # them. A purchase is not one-dimensional: a buyer racing a deadline will
    # pay a premium for speed, and one managing cash flow will pay a premium
    # for credit. Without these the agent can only ever haggle on price.
    preferred_payment_terms: PaymentTerms = "net_30"
    # Weights are normalised at scoring time, so they express relative
    # priority rather than needing to sum to 1 here.
    weight_price: float = 0.5
    weight_speed: float = 0.3
    weight_terms: float = 0.2
    created_at: float = Field(default_factory=time.time)
    signature: Optional[str] = None


class CartMandate(BaseModel):
    id: str = Field(default_factory=lambda: new_id("cart"))
    type: Literal["cart_mandate"] = "cart_mandate"
    intent_id: str
    merchant_ref: str
    round: int
    items: list[CartItem]
    upsell_item: Optional[CartItem] = None
    # The commercial terms this cart is quoted under. The same basket at the
    # same price is a materially different offer on advance vs 45-day credit,
    # so terms travel with the cart and are signed alongside it.
    lead_time_days: int = 7
    payment_terms: PaymentTerms = "advance"
    # Sticker margin. `effective_margin_pct` below is the one the floor is
    # actually enforced against.
    margin_pct: float
    reasoning: str
    # True when this cart came from rule-based pricing because the model was
    # unreachable. Surfaced in the UI and the audit trail — serving a
    # deterministic quote as if a model produced it would be dishonest.
    degraded: bool = False
    created_at: float = Field(default_factory=time.time)
    signature: Optional[str] = None

    @computed_field
    @property
    def total_units(self) -> int:
        units = sum(item.qty for item in self.items)
        if self.upsell_item is not None:
            units += self.upsell_item.qty
        return units

    @computed_field
    @property
    def goods_subtotal(self) -> float:
        """Goods only. This is the base the margin floor is measured against —
        freight is a pass-through and must not be counted as gross margin."""
        total = sum(item.line_total for item in self.items)
        if self.upsell_item is not None:
            total += self.upsell_item.line_total
        return round(total, 2)

    @computed_field
    @property
    def shipping_cost(self) -> float:
        """Freight, priced off the promised ETA — its own line, as on a real
        quote, rather than hidden inside unit price."""
        return freight_cost(self.total_units, self.lead_time_days)

    @computed_field
    @property
    def total_price(self) -> float:
        """What the buyer is invoiced: goods plus freight."""
        return round(self.goods_subtotal + self.shipping_cost, 2)

    @computed_field
    @property
    def credit_days(self) -> int:
        return CREDIT_DAYS.get(self.payment_terms, 0)

    @computed_field
    @property
    def financing_cost(self) -> float:
        """What the credit period costs the seller on this cart."""
        return financing_cost(self.total_price, self.payment_terms)

    @computed_field
    @property
    def goods_cost_basis(self) -> float:
        """The merchant's cost of goods, recovered from the signed margin.

        Exposed so downstream floor checks stop re-deriving it from
        `total_price` — which now includes freight and would understate the
        margin, wrongly tripping the floor guard on healthy carts.
        """
        return round(self.goods_subtotal * (1 - self.margin_pct / 100), 2)

    @computed_field
    @property
    def net_realisable_total(self) -> float:
        """What the seller actually banks after carrying the receivable."""
        return net_realisable(self.total_price, self.payment_terms)


class PaymentMandate(BaseModel):
    id: str = Field(default_factory=lambda: new_id("payment"))
    type: Literal["payment_mandate"] = "payment_mandate"
    cart_id: str
    cart_hash: str
    amount: float
    # Terms are part of what was agreed, so they are locked into the payment
    # mandate too — settling a 45-day-credit deal as if it were paid on
    # despatch is a different transaction from the one both sides signed.
    lead_time_days: int = 7
    payment_terms: PaymentTerms = "advance"
    buyer_ref: str
    merchant_ref: str
    created_at: float = Field(default_factory=time.time)
    buyer_signature: Optional[str] = None
    merchant_signature: Optional[str] = None
    # Simulated Razorpay Route attribution — which of the merchant's linked
    # accounts this payment settles to. Display/audit only: no real Route
    # API call, no real linked account, no actual fund-splitting. See
    # agents/businesses.py's razorpay_linked_account_id.
    razorpay_linked_account_id: Optional[str] = None


class BuyerDecision(BaseModel):
    action: Literal["accept", "counter", "walk"]
    reasoning: str
    counter_max_spend: Optional[float] = None
    # What the buyer is pushing on this round. Lets the merchant concede on
    # the lever that actually matters instead of reflexively cutting price.
    counter_on: Optional[Literal["price", "lead_time", "payment_terms", "quantity"]] = None
    degraded: bool = False
