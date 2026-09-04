import hashlib
import math
import re
import threading
from typing import Any

from agents.catalog import CATALOG, MARGIN_FLOOR_PCT

# Simulated Razorpay Route attribution — NOT a real linked account, NOT a real
# Route API call, and settlement still goes through the single real test
# account exactly as before. This exists purely to make "who this payment is
# for" explicit and visible (in the payment mandate / audit trail) instead of
# implicit. Deterministic so the same business_id always yields the same id
# (verifiable, stable across restarts) while different businesses get
# different ids — a real linked account id would look similar but be issued
# by Razorpay at KYC/onboarding time, which is out of scope for this demo.
def _linked_account_id(business_id: str) -> str:
    digest = hashlib.sha256(f"acp-route-linked-account:{business_id}".encode()).hexdigest()
    return f"acc_{digest[:14]}"

# Three independently priced/margined businesses so the marketplace produces
# genuinely different offers, not cosmetic variety. "techmart" mirrors the
# original single-merchant catalog exactly, so the default (non-marketplace)
# negotiation flow is unaffected by this feature's existence.

BUSINESSES: list[dict[str, Any]] = [
    {
        "id": "techmart",
        "name": "TechMart",
        "catalog": CATALOG,
        "margin_floor_pct": MARGIN_FLOOR_PCT,
    },
    {
        "id": "bytebazaar",
        "name": "ByteBazaar",
        "catalog": [
            {"sku": "BB-200", "name": "Wireless Mouse", "cost": 610.0, "list_price": 999.0},
            {"sku": "BB-210", "name": "USB-C Hub", "cost": 395.0, "list_price": 699.0},
            {"sku": "BB-220", "name": "Mechanical Keyboard", "cost": 1780.0, "list_price": 2950.0},
            {"sku": "BB-230", "name": "Laptop Stand", "cost": 505.0, "list_price": 949.0},
        ],
        "margin_floor_pct": 18.0,
    },
    {
        "id": "quicksupply",
        "name": "QuickSupply",
        "catalog": [
            {"sku": "QS-01", "name": "Wireless Mouse", "cost": 660.0, "list_price": 880.0},
            {"sku": "QS-02", "name": "USB-C Hub", "cost": 425.0, "list_price": 600.0},
            {"sku": "QS-03", "name": "Mechanical Keyboard", "cost": 1900.0, "list_price": 2650.0},
            {"sku": "QS-04", "name": "Laptop Stand", "cost": 535.0, "list_price": 830.0},
        ],
        "margin_floor_pct": 8.0,
    },
]

for _b in BUSINESSES:
    _b["razorpay_linked_account_id"] = _linked_account_id(_b["id"])
del _b

DEFAULT_BUSINESS = BUSINESSES[0]

BUSINESS_BY_ID: dict[str, dict[str, Any]] = {b["id"]: b for b in BUSINESSES}

_registry_lock = threading.Lock()

MIN_MARGIN_FLOOR_PCT = 5.0
MAX_MARGIN_FLOOR_PCT = 40.0
MAX_CATALOG_ITEMS = 4

MAX_BUSINESS_NAME_LENGTH = 80
MAX_ITEM_NAME_LENGTH = 60

# Sanity cap on a submitted catalog item's price — rejects gamed/typo'd
# values (e.g. an extra zero or two) with a clean error instead of letting
# them flow into a real negotiation and Razorpay order.
MIN_ITEM_PRICE = 0.01
MAX_ITEM_PRICE = 10_000_000.0

# A submitted item price is treated as the business's cost basis (what the
# merchant agent's margin floor is computed against); list_price is a display
# reference only (shown to the LLM as a ceiling), so a simple markup heuristic
# is fine here — nothing downstream enforces it.
_LIST_PRICE_MARKUP = 1.5

# Defensive cap independent of MAX_BUSINESS_NAME_LENGTH — this id is used as a
# dict key, a file-path component (audit ledger, session persistence), and a
# signing ref, so it must stay short and filesystem-safe even if a caller
# somehow bypasses the name-length check above.
_MAX_SLUG_LENGTH = 40


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    slug = slug[:_MAX_SLUG_LENGTH].strip("-")
    return slug or "vendor"


def _unique_id(name: str) -> str:
    base = _slugify(name)
    if base not in BUSINESS_BY_ID:
        return base
    i = 2
    while f"{base}-{i}" in BUSINESS_BY_ID:
        i += 1
    return f"{base}-{i}"


def _persist_business(business: dict[str, Any]) -> None:
    """Writes a runtime-registered vendor to the database.

    Imported lazily: `orchestrator.runtime` builds the catalog index from
    `BUSINESSES` at import time, so a module-level import here would be
    circular. Persistence failing must never fail the registration itself —
    the caller already has a working in-memory vendor.
    """
    try:
        from orchestrator.runtime import db

        db.upsert_business(business)
    except Exception:
        pass


def restore_registered_businesses(records: list[dict[str, Any]]) -> int:
    """Re-admits vendors persisted by a previous process.

    Seeded businesses are skipped: they are defined in code and would
    otherwise be duplicated by an older copy of themselves.
    """
    restored = 0
    with _registry_lock:
        for record in records:
            business_id = record.get("id")
            if not business_id or business_id in BUSINESS_BY_ID:
                continue
            if not record.get("catalog"):
                continue
            BUSINESSES.append(record)
            BUSINESS_BY_ID[business_id] = record
            restored += 1
    return restored


def register_business(
    name: str,
    catalog_items: list[dict[str, Any]],
    margin_floor_pct: float,
) -> dict[str, Any]:
    """Registers a new business into the in-memory marketplace roster at
    runtime — no restart, no editing this file by hand. Reuses the existing
    HMAC identity derivation (protocol/signing.py derives every agent's
    secret from a master secret + its ref), so the new business's id is a
    valid signing identity the moment it exists; nothing there needs to
    change. In-memory only — resets on restart, which is fine for a demo."""
    name = (name or "").strip()
    if not name:
        raise ValueError("business name is required")
    if len(name) > MAX_BUSINESS_NAME_LENGTH:
        raise ValueError(f"business name must be at most {MAX_BUSINESS_NAME_LENGTH} characters")

    if not catalog_items:
        raise ValueError("at least one catalog item is required")
    if len(catalog_items) > MAX_CATALOG_ITEMS:
        raise ValueError(f"at most {MAX_CATALOG_ITEMS} catalog items are supported")

    if not math.isfinite(margin_floor_pct) or not (
        MIN_MARGIN_FLOOR_PCT <= margin_floor_pct <= MAX_MARGIN_FLOOR_PCT
    ):
        raise ValueError(
            f"margin_floor_pct must be between {MIN_MARGIN_FLOOR_PCT} and {MAX_MARGIN_FLOOR_PCT}"
        )

    with _registry_lock:
        business_id = _unique_id(name)
        slug_upper = _slugify(name).upper()[:8] or "VENDOR"

        catalog: list[dict[str, Any]] = []
        for i, item in enumerate(catalog_items, start=1):
            item_name = (item.get("name") or "").strip()
            if not item_name:
                raise ValueError("each catalog item needs a name")
            if len(item_name) > MAX_ITEM_NAME_LENGTH:
                raise ValueError(
                    f'catalog item name must be at most {MAX_ITEM_NAME_LENGTH} characters: "{item_name[:20]}..."'
                )

            try:
                price = float(item.get("price", 0))
            except (TypeError, ValueError):
                raise ValueError(f'"{item_name}" has an invalid price')

            if not math.isfinite(price) or price < MIN_ITEM_PRICE:
                raise ValueError(f'"{item_name}" needs a positive price')
            if price > MAX_ITEM_PRICE:
                raise ValueError(
                    f'"{item_name}" price ({price:,.2f}) exceeds the sanity cap of {MAX_ITEM_PRICE:,.0f}'
                )

            catalog.append(
                {
                    "sku": f"{slug_upper}-{i:02d}",
                    "name": item_name,
                    "cost": round(price, 2),
                    "list_price": round(price * _LIST_PRICE_MARKUP, 2),
                }
            )

        business = {
            "id": business_id,
            "name": name,
            "catalog": catalog,
            "margin_floor_pct": float(margin_floor_pct),
            "razorpay_linked_account_id": _linked_account_id(business_id),
        }

        # Mutate the existing list/dict in place (never rebind BUSINESSES to a
        # new object) — marketplace.py imported this list by reference, so an
        # append here is what lets it pick up new vendors automatically.
        BUSINESSES.append(business)
        BUSINESS_BY_ID[business_id] = business

    # Persist outside the registry lock — the database has its own. A vendor
    # that only exists in memory disappears on the next restart, which is
    # exactly what happened to vendors added during a demo.
    _persist_business(business)

    return business
