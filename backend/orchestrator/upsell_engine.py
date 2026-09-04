from typing import Any

from protocol.mandates import CartItem, CartMandate
from protocol.pricing import min_sellable_price

UPSELL_MARGIN_HEADROOM_PCT = 20.0  # only upsell when the base cart already clears this


def decide_upsell(
    cart: CartMandate,
    max_spend: float,
    catalog: list[dict[str, Any]],
    margin_floor_pct: float,
) -> CartItem | None:
    """Rule-based (not LLM), so the decision is explainable and reproducible:
    only offer an upsell when the base cart's margin already has real headroom
    above the floor, and only if it still fits the buyer's budget."""
    if cart.margin_pct < UPSELL_MARGIN_HEADROOM_PCT:
        return None

    existing_skus = {item.sku for item in cart.items}
    remaining_budget = max_spend - cart.total_price

    for catalog_item in catalog:
        if catalog_item["sku"] in existing_skus:
            continue
        min_price = min_sellable_price(catalog_item["cost"], margin_floor_pct)
        if min_price <= remaining_budget:
            return CartItem(
                sku=catalog_item["sku"],
                name=catalog_item["name"],
                qty=1,
                unit_price=min_price,
            )
    return None
