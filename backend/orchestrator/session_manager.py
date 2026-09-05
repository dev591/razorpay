import threading
import time
from typing import Any

import openai

from agents import buyer_agent, merchant_agent
from agents.businesses import BUSINESS_BY_ID, DEFAULT_BUSINESS
from integrations import razorpay_client
from orchestrator import runtime
from orchestrator.upsell_engine import decide_upsell
from protocol.audit_ledger import AuditLedger
from protocol.mandates import CartMandate, IntentMandate, PaymentMandate, new_id
from protocol.pricing import NEAR_FLOOR_BUFFER_PCT as _NEAR_FLOOR_BUFFER_PCT
from protocol.signing import hash_cart, sign
from protocol.terms import effective_margin_pct

MAX_ROUNDS = 6

# Bounded-autonomy escalation: a converged deal whose margin sits within this
# many percentage points above the business's margin_floor_pct is too close
# to the floor to auto-finalize. It gets flagged pending_seller_confirmation
# instead of going straight to payment — deals comfortably above the floor
# are unaffected and behave exactly as before.
#
# Re-exported from protocol.pricing so the offline pricing rules can respect
# the same threshold without a second copy of the number.
NEAR_FLOOR_BUFFER_PCT = _NEAR_FLOOR_BUFFER_PCT

# Tolerance for float/rounding drift when re-deriving a cart's margin from its
# stored (2dp-rounded) margin_pct. Well below any margin difference that could
# matter commercially.
MARGIN_ROUNDING_EPSILON = 0.05

_lock = threading.Lock()

# session_id -> {"final_cart": CartMandate, "merchant_ref": str} for deals
# parked awaiting seller confirmation, and intents parked awaiting buyer
# approval. Live objects because `_finalize_payment` needs a real CartMandate.
#
# This is a *cache*, not the record. A parked deal also persists its cart on
# the session, and `_rehydrate_pending` rebuilds the CartMandate from that when
# the process has restarted — verified to reproduce the identical cart hash and
# signature, because both are computed from field values alone. Treating the
# in-memory copy as the only truth stranded every parked deal permanently on
# restart, which a seller-side view makes very visible.
_pending_confirmations: dict[str, dict[str, Any]] = {}
_pending_intents: dict[str, dict[str, Any]] = {}

# session_id -> {business_id: CartMandate} for every vendor that converged in a
# marketplace broadcast, not just the one that scored highest.
#
# The scorer picks a winner, but the winner is a *recommendation*: a buyer can
# reasonably prefer the runner-up because they trust that supplier, or want
# the faster delivery, or the better credit. Keeping every converged cart
# lets `select_offer` settle any of them against the same signed intent,
# instead of forcing a whole new negotiation to buy from the second-place
# vendor. Live objects for the same reason as `_pending_confirmations` — only
# a real CartMandate can be hashed and signed.
_converged_offers: dict[str, dict[str, Any]] = {}


def remember_offer(session_id: str, business_id: str, cart: Any) -> None:
    """Records a converged cart so it stays settleable after the broadcast."""
    with _lock:
        _converged_offers.setdefault(session_id, {})[business_id] = cart


def _persist(session: dict[str, Any]) -> None:
    """Write-through to the LRU store, which owns both the disk copy and the
    buyer/seller indices. Kept under the original name so every call site
    below reads the same as before."""
    runtime.store.put(session)


def _emit(session_id: str, event_type: str, payload: dict[str, Any]) -> None:
    """Publishes a negotiation event to that session's live topic.

    Deliberately separate from the audit ledger: the ledger is the durable,
    hash-chained record of money-affecting facts, this is an ephemeral UI
    feed. Emitting must never be able to break a negotiation, hence the
    blanket guard."""
    try:
        runtime.events.publish(session_id, event_type, payload)
    except Exception:
        pass


def get_session(session_id: str) -> dict[str, Any] | None:
    return runtime.store.get(session_id)


def list_sessions() -> list[dict[str, Any]]:
    """Recent-first, bounded by the store's recency ring. The dashboard wants
    the latest activity, not an unbounded dump that grows without limit as
    the corpus does."""
    return runtime.store.recent(limit=100)


def get_business_orders(business_id: str) -> dict[str, list[dict[str, Any]]]:
    """Splits every known session into the ones where `business_id` acted as
    buyer (`session["buyer_business_id"]`) vs. the ones where it won as
    seller (`session["seller_business_id"]`, set once a deal is finalized or
    parked for confirmation — see `_finalize_or_flag`). Backs
    GET /businesses/{id}/orders.

    Served from the store's two inverted indices, so this is an O(k) lookup
    of just this business's sessions rather than the O(n) scan-and-filter
    over every known session it used to be."""
    return {
        "as_buyer": runtime.store.by_buyer(business_id),
        "as_seller": runtime.store.by_seller(business_id),
    }


def _negotiate_with_business(
    intent: IntentMandate,
    business: dict[str, Any],
    ledger: AuditLedger,
    max_rounds: int = MAX_ROUNDS,
) -> dict[str, Any]:
    """Runs one buyer-agent <-> merchant-agent negotiation to completion against
    a single business, using real OpenAI calls each round. Shared by the
    single-merchant flow and the marketplace flow (which calls this once per
    business, concurrently, against the same ledger)."""
    topic = ledger.session_id
    # Latched per vendor-negotiation so a sustained outage logs once, not
    # once per round.
    session_degraded = False
    _emit(
        topic,
        "vendor.joined",
        {"business_id": business["id"], "business_name": business["name"]},
    )

    transcript: list[dict[str, str]] = []
    rounds: list[dict[str, Any]] = []
    counter_note: str | None = None
    previous_total: float | None = None
    previous_items: list | None = None
    final_cart = None
    status = "negotiating"

    for round_num in range(1, max_rounds + 1):
        _emit(
            topic,
            "vendor.thinking",
            {
                "business_id": business["id"],
                "business_name": business["name"],
                "round": round_num,
            },
        )
        try:
            cart = merchant_agent.propose_cart(
                intent, business, round_num, counter_note, previous_total,
                previous_items, max_rounds=max_rounds,
            )
        except openai.OpenAIError as e:
            # A stalled/failed OpenAI call must not hang or crash the whole
            # request — this business just failed to negotiate this round.
            # Critical for the marketplace flow: ThreadPoolExecutor.map()
            # would otherwise re-raise this and abort every other business's
            # negotiation too, not just this one's.
            status = "negotiation_error"
            ledger.append(
                "negotiation.error",
                {"business_id": business["id"], "round": round_num, "stage": "propose_cart", "error": str(e)},
            )
            _emit(
                topic,
                "vendor.error",
                {
                    "business_id": business["id"],
                    "business_name": business["name"],
                    "round": round_num,
                    "stage": "propose_cart",
                    "error": str(e),
                },
            )
            break

        # Deterministic floor enforcement. `margin_floor_pct` is the one hard
        # business bound in the whole protocol, and until this check it was
        # enforced only by asking an LLM nicely in a prompt — which is not
        # enforcement. Observed in a real run: a vendor with an 8.0% floor
        # proposed a cart at 7.41%. The near-floor gate caught that one by
        # luck (it escalates anything within 3pp of the floor), but a cart at
        # 4% would have sailed through the gate and straight to Razorpay.
        #
        # A violating cart is rejected outright rather than silently repriced:
        # repricing would change a number the merchant already signed, and the
        # merchant agent gets told why so it can re-propose within bounds.
        # Enforced on the margin the seller *banks*, not the one it invoices.
        # Two adjustments, both load-bearing:
        #   - measured on `goods_subtotal`, not the invoice total, because
        #     freight is a pass-through and counting it as revenue would
        #     inflate every margin by the size of the shipping line;
        #   - netted for the cost of carrying the credit period, so a cart
        #     quoted at the sticker floor on 45-day terms cannot slip through
        #     while actually banking several points less.
        realised_margin = effective_margin_pct(
            cart.goods_subtotal, cart.goods_cost_basis, cart.payment_terms
        )
        # Epsilon, not a bare `<`: margin_pct is stored rounded to 2dp, so
        # reconstructing cost from it and re-deriving the margin can land a
        # hundredth of a point under the floor on a cart that is priced
        # exactly at it. Rejecting those was pure rounding noise.
        if realised_margin < business["margin_floor_pct"] - MARGIN_ROUNDING_EPSILON:
            violation = {
                "business_id": business["id"],
                "business_name": business["name"],
                "round": round_num,
                "cart_id": cart.id,
                "margin_pct": cart.margin_pct,
                "effective_margin_pct": realised_margin,
                "payment_terms": cart.payment_terms,
                "lead_time_days": cart.lead_time_days,
                "margin_floor_pct": business["margin_floor_pct"],
                "goods_subtotal": cart.goods_subtotal,
                "shipping_cost": cart.shipping_cost,
                "total_price": cart.total_price,
            }
            ledger.append("bounds.margin_floor_violation", violation)
            _emit(topic, "bounds.violation", violation)
            transcript.append(
                {
                    "from": "system",
                    "text": (
                        f"Rejected {business['name']}'s round {round_num} offer: "
                        f"{realised_margin}% effective margin on "
                        f"{cart.payment_terms} is below its own "
                        f"{business['margin_floor_pct']}% floor."
                    ),
                }
            )
            counter_note = (
                f"Your previous offer was rejected automatically: quoted on "
                f"{cart.payment_terms}, it banks only {realised_margin}% margin after "
                f"the cost of carrying that credit — below your "
                f"{business['margin_floor_pct']}% floor. Either raise the price or "
                f"quote shorter payment terms."
            )
            previous_total = cart.total_price
            previous_items = cart.items
            continue

        # A degraded round is a real offer, just not a negotiated one. Say so
        # once per session rather than per round, and make it visible in both
        # the durable trail and the live feed.
        if cart.degraded and not session_degraded:
            session_degraded = True
            ledger.append(
                "agent.degraded_mode",
                {
                    "business_id": business["id"],
                    "business_name": business["name"],
                    "round": round_num,
                    "reason": "pricing model unreachable after retries",
                    "behaviour": "rule-based quoting from the catalog floor; margin floor still enforced",
                },
            )
            _emit(
                topic,
                "agent.degraded",
                {
                    "business_id": business["id"],
                    "business_name": business["name"],
                    "round": round_num,
                },
            )

        upsell = decide_upsell(
            cart, intent.max_spend, business["catalog"], business["margin_floor_pct"]
        )
        if upsell is not None:
            cart.upsell_item = upsell
            # The upsell line changes `total_price`, which the merchant's
            # signature covers — re-sign so the signed total matches the cart
            # that actually goes to payment.
            merchant_agent.sign_cart(cart, business["id"])
            _emit(
                topic,
                "vendor.upsell_offered",
                {
                    "business_id": business["id"],
                    "business_name": business["name"],
                    "item": upsell.name,
                    "line_total": upsell.line_total,
                },
            )

        ledger.append(
            "cart_mandate.proposed",
            {"business_id": business["id"], **cart.model_dump()},
        )
        items_desc = ", ".join(
            f"{i.qty}x {i.name} @ ₹{i.unit_price}" for i in cart.items
        )
        merchant_line = f"Proposing: {items_desc} = ₹{cart.total_price}."
        if upsell is not None:
            merchant_line += f" Also offering {upsell.name} (+₹{upsell.line_total})."
        transcript.append({"from": "merchant", "text": merchant_line})
        _emit(
            topic,
            "vendor.offer",
            {
                "business_id": business["id"],
                "business_name": business["name"],
                "round": round_num,
                "total_price": cart.total_price,
                "goods_subtotal": cart.goods_subtotal,
                "shipping_cost": cart.shipping_cost,
                "margin_pct": cart.margin_pct,
                "items": [i.model_dump() for i in cart.items],
                "upsell_item": cart.upsell_item.model_dump() if cart.upsell_item else None,
                "reasoning": cart.reasoning,
                "text": merchant_line,
            },
        )

        try:
            decision = buyer_agent.evaluate_cart(
                intent, cart, round_num, max_rounds, previous_total
            )
        except openai.OpenAIError as e:
            status = "negotiation_error"
            ledger.append(
                "negotiation.error",
                {"business_id": business["id"], "round": round_num, "stage": "evaluate_cart", "error": str(e)},
            )
            _emit(
                topic,
                "vendor.error",
                {
                    "business_id": business["id"],
                    "business_name": business["name"],
                    "round": round_num,
                    "stage": "evaluate_cart",
                    "error": str(e),
                },
            )
            break
        transcript.append({"from": "buyer", "text": decision.reasoning})
        _emit(
            topic,
            "buyer.decision",
            {
                "business_id": business["id"],
                "business_name": business["name"],
                "round": round_num,
                "action": decision.action,
                "reasoning": decision.reasoning,
                "total_price": cart.total_price,
            },
        )

        rounds.append(
            {
                "round": round_num,
                "cart": cart.model_dump(),
                "decision": decision.model_dump(),
            }
        )
        ledger.append(
            f"buyer_decision.{decision.action}",
            {
                "business_id": business["id"],
                "round": round_num,
                "cart_id": cart.id,
                **decision.model_dump(),
            },
        )

        if decision.action == "accept":
            final_cart = cart
            status = "accepted"
            ledger.append(
                "cart_mandate.accepted",
                {"business_id": business["id"], "cart_id": cart.id},
            )
            break
        if decision.action == "walk":
            status = "walked_away"
            ledger.append(
                "negotiation.walked_away",
                {"business_id": business["id"], "round": round_num},
            )
            break

        counter_note = decision.reasoning
        previous_total = cart.total_price
        previous_items = cart.items

    if final_cart is None and status == "negotiating":
        status = "max_rounds_exceeded"
        ledger.append(
            "negotiation.max_rounds_exceeded",
            {"business_id": business["id"], "rounds": max_rounds},
        )

    return {
        "cart": final_cart,
        "status": status,
        "rounds": rounds,
        "transcript": transcript,
        "degraded": session_degraded,
    }


def _finalize_payment(
    session: dict[str, Any],
    ledger: AuditLedger,
    final_cart,
    merchant_ref: str,
) -> None:
    """Hash-locks the agreed cart, signs a Payment Mandate, verifies the hash
    still matches before ever touching Razorpay, and creates a real test-mode
    order. Mutates `session` in place and persists it. Shared by the
    single-merchant and marketplace flows — the only difference between them
    is which cart/merchant_ref reaches this point."""
    buyer_ref = session.get("buyer_business_id") or "buyer_agent"

    # Simulated Route attribution: which of the winning business's linked
    # accounts this payment settles to. Display/audit only — see
    # agents/businesses.py's _linked_account_id docstring. `business` can be
    # None for a merchant_ref that isn't a registered business id (shouldn't
    # happen in practice, but this is display data, not something to crash
    # payment finalization over).
    business = BUSINESS_BY_ID.get(merchant_ref)
    business_name = business["name"] if business else merchant_ref
    linked_account_id = business.get("razorpay_linked_account_id") if business else None

    items_payload = [i.model_dump() for i in final_cart.items]
    if final_cart.upsell_item is not None:
        items_payload.append(final_cart.upsell_item.model_dump())
    # Freight and ETA are part of what was agreed, so they are inside the
    # hash. Locking only line items would let a settled order be re-shipped
    # on a slower, cheaper service without the lock noticing.
    items_payload.append(
        {
            "__terms__": True,
            "lead_time_days": final_cart.lead_time_days,
            "payment_terms": final_cart.payment_terms,
            "shipping_cost": final_cart.shipping_cost,
        }
    )
    cart_hash = hash_cart(items_payload)

    payment = PaymentMandate(
        cart_id=final_cart.id,
        cart_hash=cart_hash,
        amount=final_cart.total_price,
        lead_time_days=final_cart.lead_time_days,
        payment_terms=final_cart.payment_terms,
        buyer_ref=buyer_ref,
        merchant_ref=merchant_ref,
        razorpay_linked_account_id=linked_account_id,
    )
    payment.buyer_signature = sign(
        buyer_ref, {"cart_hash": cart_hash, "amount": payment.amount}
    )
    payment.merchant_signature = sign(
        merchant_ref, {"cart_hash": cart_hash, "amount": payment.amount}
    )

    verified_hash = hash_cart(items_payload)
    if verified_hash != payment.cart_hash:
        session["status"] = "rejected_hash_mismatch"
        ledger.append(
            "payment_mandate.rejected",
            {"expected": payment.cart_hash, "got": verified_hash},
        )
        _persist(session)
        return

    ledger.append("payment_mandate.locked", payment.model_dump())
    _emit(
        session["id"],
        "mandate.locked",
        {
            "cart_hash": cart_hash,
            "amount": payment.amount,
            "merchant_ref": merchant_ref,
            "business_name": business_name,
            "buyer_signature": payment.buyer_signature,
            "merchant_signature": payment.merchant_signature,
        },
    )

    try:
        order = razorpay_client.create_order(
            amount_rupees=payment.amount, receipt=session["id"]
        )
    except razorpay_client.RazorpayCallError as e:
        # The mandate itself is valid and signed (the ledger above already
        # reflects that) — this is Razorpay being unreachable/slow/erroring,
        # not a trust problem with the cart, so unlike the hash-mismatch
        # branch above, the locked mandate is still worth exposing on the
        # session. Bounded by RazorpayCallError's REQUEST_TIMEOUT_SECONDS —
        # this always returns promptly rather than hanging the request past
        # the frontend's own timeout.
        session["final_cart"] = final_cart.model_dump()
        session["payment_mandate"] = payment.model_dump()
        session["status"] = "payment_provider_error"
        ledger.append("razorpay.order_creation_failed", {"error": str(e)})
        _persist(session)
        _emit(session["id"], "payment.provider_error", {"error": str(e)})
        return

    ledger.append(
        "razorpay.order_created", {"order_id": order["id"], "status": order["status"]}
    )
    ledger.append(
        "payment.routed_to_vendor",
        {
            "business_id": merchant_ref,
            "business_name": business_name,
            "razorpay_linked_account_id": linked_account_id,
            "order_id": order["id"],
            "amount": payment.amount,
        },
    )

    session["final_cart"] = final_cart.model_dump()
    session["payment_mandate"] = payment.model_dump()
    session["razorpay_order"] = order
    session["status"] = "awaiting_payment"
    _persist(session)
    # Booked GMV: a signed mandate with a real Razorpay order behind it.
    # Counted separately from captured revenue — see runtime.BOOKED_STATUSES.
    runtime.record_settlement(session)
    _emit(
        session["id"],
        "order.created",
        {
            "order_id": order["id"],
            "amount": payment.amount,
            "business_name": business_name,
            "razorpay_linked_account_id": linked_account_id,
            "checkout_url": f"/sessions/{session['id']}/checkout",
        },
    )


def _is_near_floor(margin_pct: float, margin_floor_pct: float) -> bool:
    return margin_pct <= margin_floor_pct + NEAR_FLOOR_BUFFER_PCT


def _finalize_or_flag(
    session: dict[str, Any],
    ledger: AuditLedger,
    final_cart,
    merchant_ref: str,
    business: dict[str, Any],
) -> None:
    """Seller-side gate in front of `_finalize_payment`.

    **Every** converged cart parks here for the merchant to accept. It used to
    auto-finalise anything with comfortable margin and only stop near the floor,
    which optimises for the wrong risk: the agent negotiated against a catalog,
    and a catalog is a claim about stock, not a fact. Real merchants oversell
    and under-update. Nobody is harmed by a deal waiting for a human "yes"; a
    buyer paying for forty units a vendor cannot ship is a real failure.

    The near-floor test still runs — it is the difference between "confirm you
    can ship this" and "this one is thin, look closely" — and both reasons are
    recorded. A cart whose margin is within
    NEAR_FLOOR_BUFFER_PCT of the business's floor is parked instead —
    `_pending_confirmations` holds the cart until POST .../confirm-seller
    (or forever, if no one ever confirms it) calls `_finalize_payment`."""
    # Same measure as the floor guard above: goods-only revenue, netted for
    # the credit period, so the escalation triggers on what the seller banks.
    margin_pct = effective_margin_pct(
        final_cart.goods_subtotal, final_cart.goods_cost_basis, final_cart.payment_terms
    )
    margin_floor_pct = business["margin_floor_pct"]
    session["sticker_margin_pct"] = final_cart.margin_pct
    session["goods_subtotal"] = final_cart.goods_subtotal
    session["shipping_cost"] = final_cart.shipping_cost
    session["payment_terms"] = final_cart.payment_terms
    session["lead_time_days"] = final_cart.lead_time_days
    session["margin_pct"] = margin_pct
    session["margin_floor_pct"] = margin_floor_pct
    # Set once a deal is on track to finalize (auto or pending confirmation)
    # so GET /businesses/{id}/orders can find it as a seller-side order
    # regardless of which path it takes from here.
    session["seller_business_id"] = merchant_ref

    near_floor = _is_near_floor(margin_pct, margin_floor_pct)
    session["pending_seller_confirmation"] = True
    session["status"] = "pending_seller_confirmation"
    # Expose what is actually awaiting confirmation. The live CartMandate
    # stays in `_pending_confirmations` (only that object can be signed
    # and hashed), but without its serialised form on the session a seller
    # is asked to approve a deal whose price and line items the API never
    # showed them. `_finalize_payment` overwrites this on confirmation.
    session["final_cart"] = final_cart.model_dump()
    with _lock:
        _pending_confirmations[session["id"]] = {
            "final_cart": final_cart,
            "merchant_ref": merchant_ref,
        }
    ledger.append(
        "negotiation.pending_seller_confirmation",
        {
            "cart_id": final_cart.id,
            "merchant_ref": merchant_ref,
            "margin_pct": margin_pct,
            "margin_floor_pct": margin_floor_pct,
            "near_floor_buffer_pct": NEAR_FLOOR_BUFFER_PCT,
            "near_floor": near_floor,
            "reason": (
                "margin is within the near-floor buffer — review closely"
                if near_floor
                else "seller must confirm stock before the buyer pays"
            ),
        },
    )
    _persist(session)
    _emit(
        session["id"],
        "gate.seller_confirmation_required",
        {
            "margin_pct": margin_pct,
            "margin_floor_pct": margin_floor_pct,
            "near_floor_buffer_pct": NEAR_FLOOR_BUFFER_PCT,
            "near_floor": near_floor,
            "business_name": business.get("name", merchant_ref),
        },
    )


def acknowledge_dispatch(session_id: str, business_id: str) -> dict[str, Any]:
    """The seller confirming they have the money and are shipping.

    A real recorded step, not a UI flourish: it appends to the hash chain like
    every other action, so the seller's acknowledgement is as auditable as the
    buyer's approval. Only valid once payment has actually settled — a seller
    cannot acknowledge money that has not arrived.
    """
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")
    if session.get("seller_business_id") != business_id:
        raise ValueError("this order belongs to a different vendor")
    if session.get("status") != "settled":
        raise ValueError(
            f"cannot acknowledge before payment settles (status is {session.get('status')})"
        )
    if session.get("seller_acknowledged"):
        return session

    ledger = AuditLedger(session_id)
    entry = ledger.append(
        "seller.dispatch_acknowledged",
        {
            "business_id": business_id,
            "amount": (session.get("payment_mandate") or {}).get("amount"),
            "razorpay_payment_id": session.get("razorpay_payment_id"),
        },
    )
    session["seller_acknowledged"] = True
    session["seller_acknowledged_at"] = entry["timestamp"]
    _persist(session)
    _emit(
        session_id,
        "seller.acknowledged",
        {"business_id": business_id, "business_name": session.get("seller_business_id")},
    )
    return session


def _rehydrate_pending(session: dict[str, Any]) -> dict[str, Any] | None:
    """Rebuilds a parked deal's CartMandate from what was persisted.

    The in-memory cache is gone after a restart, but the cart itself was saved
    on the session. Reconstructing it yields an identical hash and signature —
    both are functions of the field values, not of object identity — so the
    confirmation path proceeds exactly as it would have.

    Returns None for deals parked before carts were persisted at all; those are
    genuinely unrecoverable and say so rather than silently doing nothing.
    """
    raw = session.get("final_cart")
    merchant_ref = session.get("seller_business_id")
    if not raw or not merchant_ref:
        return None
    try:
        return {"final_cart": CartMandate(**raw), "merchant_ref": merchant_ref}
    except Exception:
        return None


def confirm_seller(session_id: str) -> dict[str, Any]:
    """The seller accepting a deal `_finalize_or_flag` parked — which is every
    deal. Proceeds to the same hash-lock/sign/Razorpay path, logging a distinct
    'seller.confirmed' entry first so the merchant's acceptance is visible in
    the trail as its own act rather than blurring into settlement."""
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")
    if not session.get("pending_seller_confirmation"):
        raise ValueError("session is not pending seller confirmation")

    with _lock:
        pending = _pending_confirmations.pop(session_id, None)
    _persist(session)
    if pending is None:
        pending = _rehydrate_pending(session)
    if pending is None:
        raise ValueError(
            "this deal was parked before its cart was persisted, so it can no "
            "longer be confirmed — re-run the negotiation"
        )

    ledger = AuditLedger(session_id)
    ledger.append(
        "seller.confirmed",
        {
            "cart_id": pending["final_cart"].id,
            "merchant_ref": pending["merchant_ref"],
            "margin_pct": session.get("margin_pct"),
            "margin_floor_pct": session.get("margin_floor_pct"),
        },
    )

    session["pending_seller_confirmation"] = False
    _finalize_payment(session, ledger, pending["final_cart"], pending["merchant_ref"])
    return session


def run_session(
    goal: str,
    max_spend: float,
    qty_min: int,
    qty_max: int,
    ship_within_days: int = 3,
    buyer_business_id: str | None = None,
) -> dict[str, Any]:
    """Runs one full buyer-agent <-> merchant-agent negotiation to completion
    against the default business, using real OpenAI calls for every decision,
    and — if the agents converge — a real Razorpay test-mode order. This is
    synchronous and can take a few seconds because it makes several live LLM
    calls.

    `buyer_business_id` identifies which business is acting as buyer (e.g. a
    registered business restocking from another vendor). Defaults to the
    original constant so existing single-merchant behavior/tests are
    unaffected when it's omitted.

    Raises ValueError if `buyer_business_id` is DEFAULT_BUSINESS's own id —
    this flow only ever negotiates against DEFAULT_BUSINESS, so there is no
    other seller to redirect to; rejecting is simpler than adding a seller
    selection mechanism this single-merchant path doesn't otherwise have."""

    buyer_business_id = buyer_business_id or "buyer_agent"
    if buyer_business_id == DEFAULT_BUSINESS["id"]:
        raise ValueError("a business cannot restock from itself")

    intent = buyer_agent.create_intent(
        buyer_ref=buyer_business_id,
        goal=goal,
        max_spend=max_spend,
        qty_min=qty_min,
        qty_max=qty_max,
        ship_within_days=ship_within_days,
    )

    session_id = new_id("session")
    ledger = AuditLedger(session_id)
    ledger.append("intent_mandate.created", intent.model_dump())

    session: dict[str, Any] = {
        "id": session_id,
        "status": "negotiating",
        "intent": intent.model_dump(),
        "rounds": [],
        "final_cart": None,
        "payment_mandate": None,
        "razorpay_order": None,
        "razorpay_checkout_key": razorpay_client.PUBLIC_KEY_ID,
        "razorpay_payment_id": None,
        "pending_seller_confirmation": False,
        "margin_pct": None,
        "margin_floor_pct": None,
        "buyer_business_id": buyer_business_id,
        "seller_business_id": None,
        "transcript": [
            {
                "from": "buyer",
                "text": f"Intent: {goal}, max ₹{max_spend}, {qty_min}-{qty_max} units, "
                f"ship in {ship_within_days} days.",
            }
        ],
        "created_at": time.time(),
    }
    _persist(session)
    return execute_single(session, intent, ledger)


def execute_single(
    session: dict[str, Any], intent: IntentMandate, ledger: AuditLedger
) -> dict[str, Any]:
    """Runs the single-merchant negotiation against an *already created*
    session. Split out of `run_session` so the approval-gated flow can run the
    same negotiation on a session that was created (and human-approved) in an
    earlier request, rather than creating a second one."""
    session["status"] = "negotiating"
    _persist(session)

    result = _negotiate_with_business(intent, DEFAULT_BUSINESS, ledger)
    session["degraded"] = bool(result.get("degraded"))
    session["rounds"] = result["rounds"]
    session["transcript"].extend(result["transcript"])

    if result["cart"] is None:
        session["status"] = result["status"]
        _persist(session)
        _emit(session["id"], "session.ended", {"status": result["status"]})
        return session

    _finalize_or_flag(
        session, ledger, result["cart"], merchant_ref=DEFAULT_BUSINESS["id"], business=DEFAULT_BUSINESS
    )
    _emit(session["id"], "session.ended", {"status": session["status"]})
    return session


def confirm_payment(session_id: str, payment_id: str, order_id: str, signature: str) -> dict[str, Any]:
    """Called after the buyer completes real Razorpay Checkout with a test card.
    Verifies the signature, captures the payment for real, and logs it."""
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")

    ledger = AuditLedger(session_id)

    if not razorpay_client.verify_checkout_signature(order_id, payment_id, signature):
        session["status"] = "payment_signature_invalid"
        ledger.append("razorpay.signature_invalid", {"payment_id": payment_id})
        _persist(session)
        return session

    amount = session["payment_mandate"]["amount"]
    try:
        capture = razorpay_client.capture_payment(payment_id, amount)
    except razorpay_client.RazorpayCallError as e:
        # The signature already verified above — this is Razorpay being
        # unreachable/slow/erroring on the capture call itself, not a trust
        # problem. Same pattern as _finalize_payment's create_order guard:
        # bounded by RazorpayCallError's REQUEST_TIMEOUT_SECONDS, so this
        # always returns promptly instead of hanging past the frontend's own
        # timeout, and the caller gets a clear status instead of a bare 500.
        session["status"] = "payment_capture_failed"
        ledger.append("razorpay.payment_capture_failed", {"payment_id": payment_id, "error": str(e)})
        _persist(session)
        _emit(session_id, "payment.capture_failed", {"payment_id": payment_id})
        return session

    ledger.append(
        "razorpay.payment_captured",
        {"payment_id": payment_id, "amount": amount, "status": capture.get("status")},
    )

    session["status"] = "settled"
    session["razorpay_payment_id"] = payment_id
    _persist(session)
    # Revenue only counts once Razorpay has actually captured — this is the
    # single place a settlement reaches the leaderboard.
    runtime.record_settlement(session)
    _emit(
        session_id,
        "payment.captured",
        {"payment_id": payment_id, "amount": amount, "status": session["status"]},
    )
    return session


def simulate_tamper(session_id: str) -> dict[str, Any]:
    """Demo path: mutate the agreed cart amount after it was locked and try to
    push it through payment verification. Must be rejected — this is the
    'one failure handled gracefully' requirement, exercised for real."""
    session = get_session(session_id)
    if session is None or session.get("payment_mandate") is None:
        raise ValueError("session has no locked payment mandate to tamper with")

    ledger = AuditLedger(session_id)
    real_hash = session["payment_mandate"]["cart_hash"]

    # Rebuild the exact payload that was hashed at lock time, then change one
    # price. Hashing only the items would also mismatch simply because the
    # terms block was missing — the demo has to show the *price change* being
    # caught, not an artefact of reconstructing the payload differently.
    cart = session["final_cart"]
    tampered_items = [dict(i) for i in cart["items"]]
    if cart.get("upsell_item"):
        tampered_items.append(dict(cart["upsell_item"]))
    tampered_items.append(
        {
            "__terms__": True,
            "lead_time_days": cart.get("lead_time_days"),
            "payment_terms": cart.get("payment_terms"),
            "shipping_cost": cart.get("shipping_cost"),
        }
    )
    tampered_items[0]["unit_price"] = round(tampered_items[0]["unit_price"] * 1.3, 2)
    tampered_hash = hash_cart(tampered_items)

    accepted = tampered_hash == real_hash
    ledger.append(
        "payment_mandate.tamper_attempt",
        {
            "expected_hash": real_hash,
            "tampered_hash": tampered_hash,
            "accepted": accepted,
        },
    )
    if not accepted:
        ledger.append(
            "payment_mandate.rejected",
            {
                "reason": "cart_hash mismatch",
                "expected": real_hash,
                "got": tampered_hash,
            },
        )
    _persist(session)
    return {
        "session_id": session_id,
        "expected_hash": real_hash,
        "tampered_hash": tampered_hash,
        "rejected": not accepted,
    }


# ─── Buyer-side approval gate ─────────────────────────────────────────────
#
# The mandate chain is only as bounded as its root. Before this, the buyer
# agent was autonomous from the moment a request arrived: it minted its own
# Intent Mandate and started spending against `max_spend` with no human in
# the loop at any point. Signing an intent the human never saw is exactly the
# failure mode AP2's human-signed intent mandate exists to prevent.
#
# So intent creation and intent execution are now two separate calls. The
# first mints and signs the mandate and stops. Nothing reaches an LLM, a
# vendor, or Razorpay until a human approves it — and the approval itself is
# signed and hash-chained into the audit ledger, so "who authorised this
# spend" is answerable from the trail rather than assumed.


def create_intent_session(
    goal: str,
    max_spend: float,
    qty_min: int,
    qty_max: int,
    ship_within_days: int = 3,
    requested_lines: list[dict] | None = None,
    buyer_business_id: str | None = None,
    mode: str = "marketplace",
    preferred_payment_terms: str = "net_30",
    weight_price: float = 0.5,
    weight_speed: float = 0.3,
    weight_terms: float = 0.2,
) -> dict[str, Any]:
    """Phase one: mint and sign the Intent Mandate, park it, and return.

    No negotiation starts here. The session lands in
    `awaiting_buyer_approval` and stays there until `approve_intent` — or
    forever, if nobody approves it.
    """
    if mode not in ("marketplace", "single"):
        raise ValueError("mode must be 'marketplace' or 'single'")

    buyer_business_id = buyer_business_id or "buyer_agent"
    if mode == "single" and buyer_business_id == DEFAULT_BUSINESS["id"]:
        raise ValueError("a business cannot restock from itself")

    intent = buyer_agent.create_intent(
        buyer_ref=buyer_business_id,
        goal=goal,
        max_spend=max_spend,
        qty_min=qty_min,
        qty_max=qty_max,
        ship_within_days=ship_within_days,
        requested_lines=requested_lines,
        preferred_payment_terms=preferred_payment_terms,
        weight_price=weight_price,
        weight_speed=weight_speed,
        weight_terms=weight_terms,
    )

    session_id = new_id("session")
    ledger = AuditLedger(session_id)
    ledger.append("intent_mandate.created", intent.model_dump())
    ledger.append(
        "intent_mandate.awaiting_buyer_approval",
        {
            "intent_id": intent.id,
            "max_spend": intent.max_spend,
            "reason": "human approval required before any agent may spend",
        },
    )

    session: dict[str, Any] = {
        "id": session_id,
        "status": "awaiting_buyer_approval",
        "mode": mode,
        "intent": intent.model_dump(),
        "rounds": [],
        "offers": [],
        "final_cart": None,
        "payment_mandate": None,
        "razorpay_order": None,
        "razorpay_checkout_key": razorpay_client.PUBLIC_KEY_ID,
        "razorpay_payment_id": None,
        "winner_business_id": None,
        "pending_seller_confirmation": False,
        "approved_by": None,
        "approved_at": None,
        "approval_signature": None,
        "margin_pct": None,
        "margin_floor_pct": None,
        "buyer_business_id": buyer_business_id,
        "seller_business_id": None,
        "transcript": [
            {
                "from": "buyer",
                "text": f"Intent drafted: {goal}, max ₹{max_spend}, {qty_min}-{qty_max} units, "
                f"ship in {ship_within_days} days. Awaiting human approval.",
            }
        ],
        "created_at": time.time(),
    }

    with _lock:
        _pending_intents[session_id] = {"intent": intent, "mode": mode}
    _persist(session)
    _emit(
        session_id,
        "intent.awaiting_approval",
        {"intent": intent.model_dump(), "mode": mode},
    )
    return session


def approve_intent(session_id: str, approved_by: str = "human") -> dict[str, Any]:
    """Phase two: record a signed human approval, then start the negotiation
    on a background thread.

    Returns immediately rather than blocking for the 10-20s of real LLM
    round-trips — callers watch `GET /sessions/{id}/stream` for progress.
    """
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")
    if session.get("status") != "awaiting_buyer_approval":
        raise ValueError(
            f"session is not awaiting approval (status: {session.get('status')})"
        )

    with _lock:
        pending = _pending_intents.pop(session_id, None)
    if pending is None:
        raise ValueError(
            "no pending intent for this session (process may have restarted)"
        )

    intent: IntentMandate = pending["intent"]
    approved_at = time.time()
    # Signed over the exact spend ceiling being authorised, so the approval
    # cannot later be replayed against a different (larger) intent.
    approval_signature = sign(
        intent.buyer_ref,
        {
            "intent_id": intent.id,
            "max_spend": intent.max_spend,
            "approved_by": approved_by,
            "approved_at": approved_at,
        },
    )

    ledger = AuditLedger(session_id)
    ledger.append(
        "intent_mandate.approved_by_human",
        {
            "intent_id": intent.id,
            "approved_by": approved_by,
            "approved_at": approved_at,
            "max_spend": intent.max_spend,
            "approval_signature": approval_signature,
        },
    )

    session["approved_by"] = approved_by
    session["approved_at"] = approved_at
    session["approval_signature"] = approval_signature
    session["status"] = "negotiating"
    _persist(session)
    _emit(
        session_id,
        "intent.approved",
        {"approved_by": approved_by, "approval_signature": approval_signature},
    )

    def run() -> None:
        try:
            if pending["mode"] == "marketplace":
                # Imported here, not at module scope: `marketplace` imports
                # this module, so a top-level import would be circular.
                from orchestrator import marketplace

                marketplace.execute_marketplace(session, intent, ledger)
            else:
                execute_single(session, intent, ledger)
        except Exception as e:
            # A background thread has no caller to raise into — record the
            # failure on the session and the stream instead of dying silently.
            session["status"] = "orchestrator_error"
            session["error"] = str(e)
            _persist(session)
            ledger.append("orchestrator.error", {"error": str(e)})
            _emit(session_id, "session.ended", {"status": "orchestrator_error", "error": str(e)})

    threading.Thread(target=run, daemon=True, name=f"negotiate-{session_id}").start()
    return session


def reject_intent(session_id: str, reason: str = "rejected by human") -> dict[str, Any]:
    """The other half of the gate. An intent the human declines never reaches
    an agent, and the refusal is recorded in the chain rather than the
    session just being dropped."""
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")
    if session.get("status") != "awaiting_buyer_approval":
        raise ValueError(
            f"session is not awaiting approval (status: {session.get('status')})"
        )

    with _lock:
        _pending_intents.pop(session_id, None)

    ledger = AuditLedger(session_id)
    ledger.append("intent_mandate.rejected_by_human", {"reason": reason})
    session["status"] = "rejected_by_human"
    session["rejection_reason"] = reason
    _persist(session)
    _emit(session_id, "intent.rejected", {"reason": reason})
    return session


def reject_as_seller(
    session_id: str, business_id: str, reason: str = "declined by the seller"
) -> dict[str, Any]:
    """The seller declining a deal it cannot fill.

    The other half of gate two. A gate that can only say yes is not a gate —
    and the reason a merchant is asked at all is that it might genuinely be out
    of stock, which "accept" alone gives it no way to say.

    The buyer is not left stranded: every converged cart is still held, so the
    runner-up can be settled against the same signed intent without a fresh
    negotiation. Recorded in the chain like every other refusal, rather than
    the session simply going quiet.
    """
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")
    if session.get("seller_business_id") != business_id:
        raise ValueError("this order belongs to a different vendor")
    if not session.get("pending_seller_confirmation"):
        raise ValueError(
            f"session is not awaiting seller confirmation (status: {session.get('status')})"
        )

    with _lock:
        _pending_confirmations.pop(session_id, None)

    ledger = AuditLedger(session_id)
    ledger.append(
        "seller.rejected",
        {
            "business_id": business_id,
            "reason": reason,
            "cart_total": (session.get("final_cart") or {}).get("total_price"),
        },
    )

    session["pending_seller_confirmation"] = False
    session["status"] = "rejected_by_seller"
    session["rejection_reason"] = reason
    # `seller_business_id` deliberately stays put. Clearing it dropped the
    # order out of this vendor's queue entirely, so a merchant that declined
    # something saw it simply disappear — with no record of the decision it had
    # just made. It stays visible as "you declined this" until the buyer takes
    # another vendor's offer, at which point `select_offer` reassigns it.
    _persist(session)
    _emit(
        session_id,
        "gate.seller_rejected",
        {"business_id": business_id, "reason": reason},
    )
    return session


# ─── Choosing a different vendor ──────────────────────────────────────────


def get_offer_options(session_id: str) -> dict[str, Any]:
    """Every vendor whose offer could still be settled for this session.

    `selectable` is false once a payment has actually been captured — at that
    point the money has moved and switching vendors is a refund problem, not
    a checkout one.
    """
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")

    with _lock:
        available = set(_converged_offers.get(session_id, {}))

    settled = session.get("status") == "settled"
    options = []
    for offer in session.get("offers", []):
        if offer.get("cart") is None:
            continue
        options.append(
            {
                "business_id": offer["business_id"],
                "business_name": offer["business_name"],
                "total_price": offer.get("total_price"),
                "goods_subtotal": offer.get("goods_subtotal"),
                "list_subtotal": offer.get("list_subtotal"),
                "shipping_cost": offer.get("shipping_cost"),
                "lead_time_days": offer.get("lead_time_days"),
                "payment_terms": offer.get("payment_terms"),
                "score": offer.get("score"),
                "score_breakdown": offer.get("score_breakdown"),
                "low_confidence": offer.get("low_confidence", False),
                "is_recommended": offer["business_id"] == session.get("winner_business_id"),
                "is_selected": offer["business_id"] == session.get("seller_business_id"),
                # Offers survive only in memory, so a restart makes them
                # unselectable even though the session still lists them.
                "selectable": (not settled) and offer["business_id"] in available,
            }
        )
    return {
        "session_id": session_id,
        "status": session.get("status"),
        "winner_business_id": session.get("winner_business_id"),
        "selected_business_id": session.get("seller_business_id"),
        "options": options,
    }


def select_offer(session_id: str, business_id: str) -> dict[str, Any]:
    """Settle a specific vendor's offer, overriding the scorer's pick.

    The scorer ranks; the human decides. This runs the chosen cart through the
    exact same hash-lock / dual-sign / Razorpay path the auto-selected winner
    takes — the only difference is which cart enters it, and an audit entry
    recording that a human overrode the recommendation and why that is
    traceable later.
    """
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")
    if session.get("status") == "settled":
        raise ValueError(
            "payment already captured for this session; switching vendors now "
            "would need a refund, not a re-selection"
        )

    with _lock:
        cart = _converged_offers.get(session_id, {}).get(business_id)
    if cart is None:
        raise ValueError(
            f"no settleable offer from {business_id} on this session "
            "(it may not have converged, or the process restarted)"
        )

    business = BUSINESS_BY_ID.get(business_id)
    if business is None:
        raise ValueError(f"unknown business {business_id}")

    ledger = AuditLedger(session_id)
    previous = session.get("seller_business_id")
    ledger.append(
        "marketplace.offer_selected_by_human",
        {
            "business_id": business_id,
            "business_name": business["name"],
            "previous_selection": previous,
            "recommended_business_id": session.get("winner_business_id"),
            "overrode_recommendation": business_id != session.get("winner_business_id"),
            "total_price": cart.total_price,
            "lead_time_days": cart.lead_time_days,
            "payment_terms": cart.payment_terms,
        },
    )

    # Re-selecting supersedes any order created for a previous choice. The old
    # Razorpay order is left unpaid rather than cancelled — it simply expires —
    # but the session must stop pointing at it, or the checkout page would
    # charge for a vendor the buyer just moved away from.
    if previous and previous != business_id and session.get("razorpay_order"):
        ledger.append(
            "razorpay.order_superseded",
            {
                "previous_business_id": previous,
                "superseded_order_id": session["razorpay_order"].get("id"),
            },
        )
        session["razorpay_order"] = None
        session["payment_mandate"] = None

    session["pending_seller_confirmation"] = False
    with _lock:
        _pending_confirmations.pop(session_id, None)

    _emit(
        session_id,
        "marketplace.offer_selected",
        {
            "business_id": business_id,
            "business_name": business["name"],
            "total_price": cart.total_price,
        },
    )
    _finalize_or_flag(session, ledger, cart, merchant_ref=business_id, business=business)
    return session
