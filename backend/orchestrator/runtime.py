"""Process-wide singletons: the session store, the search index, the vendor
leaderboard and the event bus.

Lives in its own module so `session_manager`, `marketplace` and `api.routes`
can all reach the same instances without importing each other (the import
cycle that would otherwise force these to be constructed inside
`session_manager` and reached through it).

Nothing here does I/O at import time except building the catalog index over
the seeded businesses, which is pure in-memory work. `boot()` is what reads
the session corpus off disk, and `main.py` calls it on startup.
"""

from typing import Any

from agents.businesses import BUSINESSES, restore_registered_businesses
from config import DB_PATH, SESSIONS_DIR
from ds.catalog_index import CatalogIndex
from ds.database import Database
from ds.event_bus import bus
from ds.lru_index import SessionStore
from ds.ranking import Leaderboard

db = Database(DB_PATH)
store = SessionStore(SESSIONS_DIR, database=db, max_hot=512, recent_size=100)
catalog_index = CatalogIndex()
leaderboard = Leaderboard()
events = bus

for _business in BUSINESSES:
    catalog_index.add_business(_business)


# A session counts as *booked* once it carries a signed payment mandate and
# a real Razorpay order — committed demand the agents actually converged on.
# `settled` is the strict subset where a payment was captured. The dashboard
# reports both and never conflates them.
BOOKED_STATUSES = {"awaiting_payment", "settled"}


def _record_if_settled(session: dict[str, Any]) -> None:
    if session.get("status") not in BOOKED_STATUSES:
        return
    seller = session.get("seller_business_id")
    cart = session.get("final_cart")
    if not seller or not cart:
        return
    # `total_price` is a computed field now, but sessions written before
    # that fix have carts on disk without it — fall back to the signed
    # mandate's amount, which is the same number and always present.
    amount = cart.get("total_price")
    if amount is None:
        amount = (session.get("payment_mandate") or {}).get("amount") or 0.0

    units = sum(item.get("qty", 0) for item in cart.get("items", []))
    if cart.get("upsell_item"):
        units += cart["upsell_item"].get("qty", 0)
    leaderboard.record_settlement(
        business_id=seller,
        amount=amount,
        units=units,
        margin_pct=cart.get("margin_pct") or 0.0,
        settled=session.get("status") == "settled",
    )


def boot() -> dict[str, Any]:
    """Rebuilds in-memory state from disk. Replays every settled session
    through the leaderboard so vendor rankings survive a restart instead of
    resetting to zero mid-demo."""
    leaderboard.reset()

    # Vendors first: a session's seller must exist before the leaderboard
    # tries to attribute revenue to it.
    restored = restore_registered_businesses(db.all_businesses())
    for business in BUSINESSES:
        catalog_index.add_business(business)

    loaded = store.rehydrate(on_session=_record_if_settled)
    return {
        "sessions_rehydrated": loaded,
        "vendors_restored": restored,
        "store": store.stats(),
        "catalog": catalog_index.stats(),
        "leaderboard": leaderboard.totals(),
    }


def record_settlement(session: dict[str, Any]) -> None:
    """Called by the session manager the moment a payment is captured."""
    _record_if_settled(session)
