import json
import random

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

from agents.businesses import BUSINESS_BY_ID, BUSINESSES, register_business
from agents.resilience import model_outage
from orchestrator import economics, marketplace, metrics_cache, runtime, session_manager
from protocol.audit_ledger import AuditLedger
from protocol.mandates import (
    check_basket_affordable,
    check_basket_available,
    check_budget_feasible,
    validate_max_spend,
    validate_quantity_band,
    validate_requested_lines,
    validate_ship_window,
)
from protocol.terms import validate_payment_terms

router = APIRouter()


class CatalogItemInput(BaseModel):
    name: str
    price: float


class RegisterBusinessRequest(BaseModel):
    name: str
    catalog: list[CatalogItemInput]
    margin_floor_pct: float


@router.get("/businesses")
def list_businesses():
    """Full marketplace roster — seeded businesses plus any registered at
    runtime via POST /businesses."""
    return [
        {
            "id": b["id"],
            "name": b["name"],
            "margin_floor_pct": b["margin_floor_pct"],
            "razorpay_linked_account_id": b["razorpay_linked_account_id"],
            # `price` kept as the merchant's unit cost for backwards
            # compatibility, but `list_price` is now returned alongside it.
            # Returning only cost while /agent/catalog/search returned only
            # list_price meant the same SKU showed two different numbers on
            # one page with nothing saying which was which.
            "catalog": [
                {
                    "sku": i["sku"],
                    "name": i["name"],
                    "price": i["cost"],
                    "cost": i["cost"],
                    "list_price": i.get("list_price", i["cost"]),
                }
                for i in b["catalog"]
            ],
        }
        for b in BUSINESSES
    ]


@router.post("/businesses")
def create_business(req: RegisterBusinessRequest):
    """Registers a new business into the marketplace at runtime — no restart,
    no editing businesses.py. Demo-scoped: no auth, no persistence (resets on
    restart)."""
    try:
        business = register_business(
            name=req.name,
            catalog_items=[item.model_dump() for item in req.catalog],
            margin_floor_pct=req.margin_floor_pct,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # A merchant that isn't in the index is invisible to AI buyers, so
    # indexing is part of registration, not a later batch job.
    runtime.catalog_index.add_business(business)

    return {
        "id": business["id"],
        "name": business["name"],
        "margin_floor_pct": business["margin_floor_pct"],
        "razorpay_linked_account_id": business["razorpay_linked_account_id"],
        "catalog": [
            {
                "sku": i["sku"],
                "name": i["name"],
                "price": i["cost"],
                "cost": i["cost"],
                "list_price": i.get("list_price", i["cost"]),
            }
            for i in business["catalog"]
        ],
    }


@router.get("/businesses/{business_id}/orders")
def get_business_orders(business_id: str):
    """Vendor-dashboard lookup: every session where `business_id` acted as
    buyer (restocking) vs. every session where it won as seller — split so a
    business's own dashboard can show both sides without scanning all
    sessions client-side. Doesn't require the id to match a registered
    business — an id that never appears on either side just returns two
    empty lists."""
    return session_manager.get_business_orders(business_id)


@router.get("/metrics")
def get_metrics():
    """Real batch metrics, cached and refreshed periodically (see
    orchestrator/metrics_cache.py) so visitors get an instant real number
    instead of waiting minutes for a fresh 20-session batch on every load."""
    return metrics_cache.get_metrics()


@router.post("/metrics/refresh")
def refresh_metrics(n: int = 20):
    return metrics_cache.get_metrics(n=n, force_refresh=True)


class CreateSessionRequest(BaseModel):
    goal: str = "Restock office peripherals"
    max_spend: float = 42000
    qty_min: int = 40
    qty_max: int = 60
    ship_within_days: int = 3
    buyer_business_id: str | None = None


@router.post("/sessions")
def create_session(req: CreateSessionRequest):
    try:
        validate_max_spend(req.max_spend)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        session = session_manager.run_session(
            goal=req.goal,
            max_spend=req.max_spend,
            qty_min=req.qty_min,
            qty_max=req.qty_max,
            ship_within_days=req.ship_within_days,
            buyer_business_id=req.buyer_business_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return session


@router.get("/sessions")
def get_sessions():
    return session_manager.list_sessions()


@router.post("/marketplace/sessions")
def create_marketplace_session(req: CreateSessionRequest):
    """Broadcasts the intent to every seeded business concurrently and
    settles with whichever produced the best real offer. Prototype: 3 fixed
    businesses, not a registered marketplace with auth/onboarding."""
    try:
        validate_max_spend(req.max_spend)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        return marketplace.run_marketplace_session(
            goal=req.goal,
            max_spend=req.max_spend,
            qty_min=req.qty_min,
            qty_max=req.qty_max,
            ship_within_days=req.ship_within_days,
            buyer_business_id=req.buyer_business_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/sessions/{session_id}")
def get_session(session_id: str):
    session = session_manager.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    return session


@router.post("/sessions/{session_id}/confirm-seller")
def confirm_seller(session_id: str):
    """Simulates the seller reviewing and approving a converged deal whose
    margin came in too close to the business's floor to auto-finalize (see
    session_manager.NEAR_FLOOR_BUFFER_PCT). Proceeds to the same
    hash-lock/sign/Razorpay path as an auto-finalized deal, but the audit
    trail records a distinct 'seller.confirmed' event for it."""
    try:
        return session_manager.confirm_seller(session_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/sessions/{session_id}/status")
def get_session_status(session_id: str):
    """Lightweight status view for the bounded-autonomy escalation: whether
    this session is parked awaiting seller confirmation, and the margin/
    floor numbers behind that decision, so a future UI can explain "why this
    needs review" without pulling the full session or audit log."""
    session = session_manager.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {
        "id": session["id"],
        "status": session["status"],
        "pending_seller_confirmation": session.get("pending_seller_confirmation", False),
        "margin_pct": session.get("margin_pct"),
        "margin_floor_pct": session.get("margin_floor_pct"),
        "near_floor_buffer_pct": session_manager.NEAR_FLOOR_BUFFER_PCT,
    }


@router.get("/sessions/{session_id}/offers")
def get_offers(session_id: str):
    """Every vendor whose offer on this session can still be settled, with the
    score breakdown behind the recommendation. The scorer ranks; the buyer
    chooses."""
    try:
        return session_manager.get_offer_options(session_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/sessions/{session_id}/select-offer/{business_id}")
def select_offer(session_id: str, business_id: str):
    """Settle a specific vendor's offer instead of the recommended one.

    Runs the chosen cart through the identical hash-lock / dual-sign /
    Razorpay path, and records the override in the audit trail."""
    try:
        return session_manager.select_offer(session_id, business_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/sessions/{session_id}/audit")
def get_audit(session_id: str):
    ledger = AuditLedger(session_id)
    return {"entries": ledger.entries(), "chain_valid": ledger.verify_chain()}


class ModelOutageRequest(BaseModel):
    enabled: bool
    ttl_seconds: float | None = None


@router.post("/chaos/model-outage")
def set_model_outage(req: ModelOutageRequest):
    """Makes the model genuinely unreachable, so the degraded path can be
    demonstrated rather than described.

    This does not fake a fallback result: it breaks the upstream call, and the
    retry budget, backoff, rule-based quoting and `degraded` labelling all run
    for real. Self-expires, so it cannot be left on by accident."""
    return model_outage.enable(req.ttl_seconds) if req.enabled else model_outage.disable()


@router.get("/chaos/model-outage")
def get_model_outage():
    return model_outage.status()


class AcknowledgeRequest(BaseModel):
    business_id: str


@router.post("/sessions/{session_id}/acknowledge")
def acknowledge_dispatch(session_id: str, req: AcknowledgeRequest):
    """Seller confirms payment received and goods dispatched. Appended to the
    hash chain like every other action."""
    try:
        return session_manager.acknowledge_dispatch(session_id, req.business_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/sessions/{session_id}/tamper")
def tamper_session(session_id: str):
    try:
        return session_manager.simulate_tamper(session_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class PaymentCallback(BaseModel):
    razorpay_payment_id: str
    razorpay_order_id: str
    razorpay_signature: str


@router.post("/sessions/{session_id}/payment-callback")
def payment_callback(session_id: str, body: PaymentCallback):
    try:
        return session_manager.confirm_payment(
            session_id,
            body.razorpay_payment_id,
            body.razorpay_order_id,
            body.razorpay_signature,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/sessions/{session_id}/checkout", response_class=HTMLResponse)
def checkout_page(session_id: str):
    session = session_manager.get_session(session_id)
    if session is None or session.get("razorpay_order") is None:
        raise HTTPException(status_code=404, detail="no order for this session")

    order = session["razorpay_order"]
    key = session["razorpay_checkout_key"]
    amount = order["amount"] / 100
    seller_id = session.get("seller_business_id") or ""
    seller = BUSINESS_BY_ID.get(seller_id, {}).get("name", seller_id)

    # The callback answers 200 for a failed signature and a failed capture too
    # — the outcome is in the returned session's `status`, not the HTTP code.
    # Reporting success off `res.ok` alone would tell a buyer their money moved
    # when it did not.
    return f"""
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Pay — {session_id}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#050b1a;color:#fff;padding:24px;">
  <div id="root" style="max-width:460px;width:100%;text-align:center;">
    <p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8fb0ff;margin:0 0 8px;">Razorpay test mode</p>
    <p style="font-size:32px;font-weight:700;margin:0 0 4px;">&#8377;{amount:,.2f}</p>
    <p style="color:#9fb0c9;font-size:13px;margin:0 0 24px;">{order['id']} &middot; payable to {seller}</p>
    <button id="pay-btn" style="padding:14px 28px;border-radius:999px;background:#3b5bfd;color:#fff;border:none;font-size:15px;font-weight:600;cursor:pointer;">Pay with Razorpay</button>
    <p style="color:#66799a;font-size:12px;margin-top:18px;">No real funds move. Use any Razorpay test card.</p>
  </div>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    var root = document.getElementById('root');

    function screen(colour, title, lines) {{
      root.innerHTML =
        '<div style="font-size:44px;line-height:1;margin-bottom:14px;">' + colour.icon + '</div>' +
        '<p style="font-size:22px;font-weight:700;margin:0 0 10px;color:' + colour.hex + ';">' + title + '</p>' +
        lines.map(function (l) {{
          return '<p style="color:#9fb0c9;font-size:13.5px;line-height:1.6;margin:0 0 6px;">' + l + '</p>';
        }}).join('');
    }}

    var OK = {{ icon: '&#10003;', hex: '#38d39f' }};
    var BAD = {{ icon: '&#9888;', hex: '#ff6b6b' }};

    document.getElementById('pay-btn').onclick = function () {{
      var rzp = new Razorpay({{
        key: "{key}",
        amount: {order['amount']},
        currency: "INR",
        order_id: "{order['id']}",
        name: "Mandate",
        description: "Session {session_id}",
        handler: function (response) {{
          root.innerHTML = '<p style="color:#9fb0c9;">Capturing payment&hellip;</p>';
          fetch("/sessions/{session_id}/payment-callback", {{
            method: "POST",
            headers: {{"Content-Type": "application/json"}},
            body: JSON.stringify({{
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_signature: response.razorpay_signature
            }})
          }})
            .then(function (r) {{ return r.json(); }})
            .then(function (s) {{
              if (s.status === 'settled') {{
                screen(OK, 'Payment complete', [
                  '<strong style="color:#fff;">&#8377;{amount:,.2f}</strong> captured and routed to {seller}.',
                  'Payment ' + response.razorpay_payment_id,
                  'Order {order['id']}',
                  '<span style="color:#66799a;">{seller} confirms dispatch next &mdash; the whole chain is in the audit trail.</span>'
                ]);
              }} else if (s.status === 'payment_signature_invalid') {{
                screen(BAD, 'Payment rejected', [
                  'The signature did not verify, so nothing was captured.',
                  '<span style="color:#66799a;">The signed mandate is untouched.</span>'
                ]);
              }} else if (s.status === 'payment_capture_failed') {{
                screen(BAD, 'Capture failed', [
                  'The signature verified, but Razorpay could not be reached to capture.',
                  '<span style="color:#66799a;">The signed mandate is held intact &mdash; nothing was lost.</span>'
                ]);
              }} else {{
                screen(BAD, 'Unexpected state', ['The session reported: ' + s.status]);
              }}
            }})
            .catch(function (e) {{
              screen(BAD, 'Could not confirm', [
                'The payment may have gone through, but this page could not reach the backend.',
                '<span style="color:#66799a;">' + e + '</span>'
              ]);
            }});
        }}
      }});
      rzp.on('payment.failed', function (resp) {{
        screen(BAD, 'Payment failed', [
          (resp.error && resp.error.description) || 'Razorpay declined the payment.',
          '<span style="color:#66799a;">Nothing was captured. You can close this tab and retry.</span>'
        ]);
      }});
      rzp.open();
    }};
  </script>
</body>
</html>
"""


class BatchRequest(BaseModel):
    n: int = 10


_BATCH_GOALS = [
    ("Restock office peripherals", 42000, 40, 60),
    ("Bulk order for new hires", 65000, 50, 80),
    ("Warehouse replenishment", 30000, 25, 45),
    ("Quarterly accessory refresh", 55000, 60, 90),
]


@router.post("/batch")
def run_batch(req: BatchRequest):
    results = []
    for i in range(req.n):
        goal, max_spend, qty_min, qty_max = random.choice(_BATCH_GOALS)
        jitter = random.uniform(0.9, 1.1)
        session = session_manager.run_session(
            goal=goal,
            max_spend=round(max_spend * jitter, 2),
            qty_min=qty_min,
            qty_max=qty_max,
        )
        results.append(session)

    locked = [s for s in results if s.get("final_cart") is not None]
    settled_or_locked_count = len(locked)

    margins = [s["final_cart"]["margin_pct"] for s in locked]
    avg_margin = round(sum(margins) / len(margins), 2) if margins else 0.0

    with_upsell = [
        s for s in locked if s["final_cart"].get("upsell_item") is not None
    ]
    upsell_offer_rate = (
        round(len(with_upsell) / settled_or_locked_count * 100, 1)
        if settled_or_locked_count
        else 0.0
    )

    tamper_results = [
        session_manager.simulate_tamper(s["id"]) for s in locked
    ]
    caught = sum(1 for t in tamper_results if t["rejected"])
    tamper_catch_rate = (
        round(caught / len(tamper_results) * 100, 1) if tamper_results else 0.0
    )

    walked = sum(1 for s in results if s["status"] == "walked_away")

    return {
        "n": req.n,
        "locked_or_settled": settled_or_locked_count,
        "walked_away": walked,
        "avg_margin_pct": avg_margin,
        "upsell_offer_rate_pct": upsell_offer_rate,
        "tamper_catch_rate_pct": tamper_catch_rate,
        "session_ids": [s["id"] for s in results],
    }


# ─── Agent-readable surface ───────────────────────────────────────────────


@router.get("/.well-known/agent-card.json")
def agent_card():
    """Discovery document for an outside AI buyer.

    Without this, being "agent-readable" means a human reads our docs and
    hand-writes an integration. An agent that lands on this host can read one
    well-known URL and learn what this merchant sells, what protocol it
    speaks, what the spend bounds are, and which endpoint to hit — the same
    role `/.well-known/openid-configuration` plays for OIDC.
    """
    return {
        "protocol": "agentic-commerce/0.1",
        "name": "Mandate — agentic commerce on Razorpay",
        "description": (
            "Merchant marketplace transactable by an autonomous buyer agent. "
            "Negotiation is agent-to-agent; every money action is signed, "
            "hash-chained and gated behind a human-approved intent mandate."
        ),
        "mandate_types": ["intent_mandate", "cart_mandate", "payment_mandate"],
        "settlement": {
            "provider": "razorpay",
            "mode": "test",
            "currency": "INR",
            "instrument": "razorpay_order + checkout signature verification",
        },
        "bounds": {
            "max_spend_cap": 10_000_000.0,
            "max_negotiation_rounds": session_manager.MAX_ROUNDS,
            "human_approval_required": True,
            "near_floor_buffer_pct": session_manager.NEAR_FLOOR_BUFFER_PCT,
        },
        "endpoints": {
            "catalog_search": {"method": "GET", "path": "/agent/catalog/search?q="},
            "catalog_complete": {"method": "GET", "path": "/agent/catalog/complete?prefix="},
            "create_intent": {"method": "POST", "path": "/intents"},
            "approve_intent": {"method": "POST", "path": "/intents/{session_id}/approve"},
            "reject_intent": {"method": "POST", "path": "/intents/{session_id}/reject"},
            "stream_session": {"method": "GET", "path": "/sessions/{session_id}/stream"},
            "audit_trail": {"method": "GET", "path": "/sessions/{session_id}/audit"},
        },
        "guarantees": [
            "No agent spends before a human approves and signs the intent mandate.",
            "Every cart is hash-locked before payment; a mutated cart is rejected.",
            "Every money action is an append-only, hash-chained audit entry.",
            "Every negotiated cart waits for the merchant to confirm stock before the buyer is asked to pay.",
        ],
        "catalog": runtime.catalog_index.stats(),
    }


@router.get("/agent/catalog/search")
def catalog_search(q: str, limit: int = 20):
    """Term search across every registered merchant's catalog, cheapest-first.

    Backed by an inverted index, so cost scales with the rarest query token's
    posting list rather than with the number of merchants onboarded."""
    return {"query": q, "results": runtime.catalog_index.search(q, limit=limit)}


@router.get("/agent/catalog/complete")
def catalog_complete(prefix: str, limit: int = 10):
    """Prefix completion over a trie — O(len(prefix)), independent of catalog
    size. Lets a buyer agent resolve a fuzzy product name before committing
    to an intent."""
    return {"prefix": prefix, "results": runtime.catalog_index.prefix(prefix, limit=limit)}


# ─── Human-gated intent lifecycle ─────────────────────────────────────────


class RequestedLineRequest(BaseModel):
    name: str
    qty: int


class CreateIntentRequest(BaseModel):
    goal: str = "Restock office peripherals"
    max_spend: float = 42000
    qty_min: int = 40
    qty_max: int = 60
    ship_within_days: int = 3
    # Optional named basket. Empty keeps the original "anything in the band"
    # behaviour, so existing callers are unaffected.
    requested_lines: list[RequestedLineRequest] = []
    buyer_business_id: str | None = None
    mode: str = "marketplace"
    preferred_payment_terms: str = "net_30"
    weight_price: float = 0.5
    weight_speed: float = 0.3
    weight_terms: float = 0.2


@router.post("/intents")
def create_intent(req: CreateIntentRequest):
    """Mints and signs an Intent Mandate and stops. Nothing reaches an LLM,
    a vendor or Razorpay until POST /intents/{id}/approve."""
    try:
        validate_max_spend(req.max_spend)
        validate_payment_terms(req.preferred_payment_terms)
        validate_quantity_band(req.qty_min, req.qty_max)
        validate_ship_window(req.ship_within_days)
        lines = [line.model_dump() for line in req.requested_lines]
        validate_requested_lines(lines, req.qty_max)
        check_basket_available(lines)
        check_basket_affordable(lines, req.qty_min, req.max_spend)
        # Feasibility, not just well-formedness: a budget that cannot buy
        # qty_min of the cheapest thing on offer is a request no vendor can
        # fill, and every agent would burn six rounds of real LLM calls
        # discovering that. Rejecting up front with the actual shortfall is
        # both cheaper and a far better answer than "no vendor responded".
        check_budget_feasible(req.max_spend, req.qty_min)
        return session_manager.create_intent_session(
            goal=req.goal,
            max_spend=req.max_spend,
            qty_min=req.qty_min,
            qty_max=req.qty_max,
            ship_within_days=req.ship_within_days,
            requested_lines=lines,
            buyer_business_id=req.buyer_business_id,
            mode=req.mode,
            preferred_payment_terms=req.preferred_payment_terms,
            weight_price=req.weight_price,
            weight_speed=req.weight_speed,
            weight_terms=req.weight_terms,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class ApproveRequest(BaseModel):
    approved_by: str = "human"


@router.post("/intents/{session_id}/approve")
def approve_intent(session_id: str, body: ApproveRequest | None = None):
    """Records a signed human approval and kicks the negotiation off on a
    background thread. Returns immediately — watch /sessions/{id}/stream."""
    try:
        return session_manager.approve_intent(
            session_id, approved_by=(body.approved_by if body else "human")
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class RejectRequest(BaseModel):
    reason: str = "rejected by human"


@router.post("/intents/{session_id}/reject")
def reject_intent(session_id: str, body: RejectRequest | None = None):
    try:
        return session_manager.reject_intent(
            session_id, reason=(body.reason if body else "rejected by human")
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ─── Live stream ──────────────────────────────────────────────────────────


def _sse(event: dict | None) -> str:
    """One SSE frame. `None` is the bus's keepalive tick — sent as a comment
    line, which the EventSource spec ignores but which keeps proxies from
    reaping an idle connection."""
    if event is None:
        return ": keepalive\n\n"
    return f"event: {event['type']}\ndata: {json.dumps(event, default=str)}\n\n"


@router.get("/sessions/{session_id}/stream")
def stream_session(session_id: str):
    """Server-sent events for one negotiation.

    A negotiation is 10-20s of real OpenAI round-trips across several vendors
    concurrently. Returning only the final object threw away everything that
    made it interesting; this replays what already happened and then streams
    the rest live, so the console can show vendors bidding against each other
    in real time.
    """
    return StreamingResponse(
        (_sse(event) for event in runtime.events.stream(session_id)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/stream")
def stream_firehose():
    """Every session's events on one connection — backs the console's global
    activity rail without opening a socket per session."""
    from ds.event_bus import FIREHOSE

    return StreamingResponse(
        (_sse(event) for event in runtime.events.stream(FIREHOSE)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ─── Merchant growth surface ──────────────────────────────────────────────


@router.get("/leaderboard")
def get_leaderboard(k: int = 10):
    """Vendor ranking by booked GMV, maintained incrementally in a sorted
    list (bisect insert, O(1) top-k read) rather than re-sorted per request."""
    return {"top": runtime.leaderboard.top(k), "totals": runtime.leaderboard.totals()}


@router.get("/economics")
def get_economics():
    """Measured inference cost, not an estimate.

    Every completion's `usage` block is recorded, so the per-negotiation
    figures here are what this instance has actually spent — which is the only
    honest way to answer "what does it cost to run an agent per order".
    """
    return economics.summary()


@router.get("/system/stats")
def system_stats():
    """What the runtime is actually holding: LRU occupancy, index sizes, live
    stream subscribers. Exposed so the console can show the tiering is real."""
    return {
        "store": runtime.store.stats(),
        "database": runtime.db.stats(),
        "catalog": runtime.catalog_index.stats(),
        "events": runtime.events.stats(),
        "leaderboard": runtime.leaderboard.totals(),
    }


# Not "/sessions/recent": FastAPI matches in declaration order, and
# "/sessions/{session_id}" is declared above, so that path would be captured
# as a session id named "recent" and 404 instead.
@router.get("/recent-sessions")
def recent_sessions(limit: int = 20):
    """Newest-first from the store's bounded recency ring — O(k), no sort."""
    return runtime.store.recent(limit=limit)
