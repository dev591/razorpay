"use client";

import { useCallback, useRef, useState } from "react";
import {
  approveIntent,
  createIntent,
  getSession,
  rejectIntent,
  streamSession,
  type IntentSession,
  type PaymentTerms,
  type RequestedLine,
  type StreamEvent,
} from "@/lib/api";

/**
 * The console's state machine, folded from the SSE stream.
 *
 * Everything on screen is derived from events rather than polled: a
 * negotiation is 10-20s of concurrent LLM round-trips, and the whole point of
 * the stream is that the UI shows it happening instead of freezing on a
 * spinner and then dumping a finished object.
 */

export type Phase =
  | "idle"
  | "drafting"
  | "awaiting_approval"
  | "negotiating"
  | "settled"
  | "gated"
  | "provider_error"
  | "failed";

export type VendorState = {
  id: string;
  name: string;
  status: "joined" | "thinking" | "offered" | "accepted" | "walked" | "failed" | "won";
  round: number;
  price: number | null;
  bestPrice: number | null;
  // The price actually agreed, set only when this vendor converged. Distinct
  // from `bestPrice` (the lowest it ever *bid*), which for the winner is
  // usually a rejected earlier round and must never be shown as the deal.
  agreedPrice: number | null;
  /** The same basket at this vendor's sticker price, and what it actually
   *  settled at. Goods only on both sides — freight tracks the promised ETA
   *  rather than the haggling, so including it would flatter the saving. */
  listSubtotal: number | null;
  goodsSubtotal: number | null;
  margin: number | null;
  score: number | null;
  reasoning: string | null;
  lastAction: string | null;
  upsell: string | null;
  violations: number;
  history: number[];
};

export type FeedItem = {
  id: number;
  type: string;
  at: number;
  actor: string;
  text: string;
  tone: "brand" | "counter" | "walk" | "settle" | "lock" | "muted";
};

/** Vendors that never negotiated, and why. The gate runs before any model
 *  call, so this is the one place the avoided cost is visible. */
export type Shortlist = {
  considered: number;
  negotiating: number;
  eliminated: { id: string; name: string; bound: number | null; reason: string }[];
  saved: { model_calls: number; inr: number; basis: string } | null;
};

export type NegotiationState = {
  phase: Phase;
  session: IntentSession | null;
  shortlist: Shortlist | null;
  vendors: VendorState[];
  feed: FeedItem[];
  winnerId: string | null;
  /** A vendor fell back to rule-based pricing because its model was
   *  unreachable. Shown to the user — a deterministic quote served as if a
   *  model produced it would be dishonest. */
  degraded: boolean;
  lockedHash: string | null;
  orderId: string | null;
  error: string | null;
};

const EMPTY: NegotiationState = {
  phase: "idle",
  session: null,
  shortlist: null,
  vendors: [],
  feed: [],
  winnerId: null,
  degraded: false,
  lockedHash: null,
  orderId: null,
  error: null,
};

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** Human-readable one-liner per event, for the activity feed. */
function describe(event: StreamEvent): FeedItem | null {
  const p = event.payload;
  const name = str(p.business_name, str(p.business_id, "system"));
  const base = { id: event.seq, type: event.type, at: event.at };

  switch (event.type) {
    case "intent.awaiting_approval":
      return { ...base, actor: "gate", tone: "lock", text: "Intent mandate signed — awaiting human approval. No agent may spend yet." };
    case "intent.approved":
      return { ...base, actor: "gate", tone: "settle", text: `Approved by ${str(p.approved_by, "human")} — approval signed into the ledger.` };
    case "intent.rejected":
      return { ...base, actor: "gate", tone: "walk", text: `Rejected: ${str(p.reason)}. No vendor was ever contacted.` };
    case "marketplace.broadcast": {
      const considered = num(p.considered) ?? num(p.vendor_count) ?? 0;
      const chosen = num(p.vendor_count) ?? 0;
      const cut = considered - chosen;
      return {
        ...base,
        actor: "buyer",
        tone: "brand",
        text: cut > 0
          ? `Shortlisted ${chosen} of ${considered} vendors on their floor price — ${cut} eliminated before any model call.`
          : `Broadcasting intent to ${chosen} vendors concurrently.`,
      };
    }
    case "vendor.offer":
      return { ...base, actor: name, tone: "brand", text: `Round ${num(p.round)}: offers ₹${(num(p.total_price) ?? 0).toLocaleString("en-IN")} at ${num(p.margin_pct)}% margin.` };
    case "vendor.upsell_offered":
      return { ...base, actor: name, tone: "counter", text: `Attaches upsell: ${str(p.item)} (+₹${(num(p.line_total) ?? 0).toLocaleString("en-IN")}).` };
    case "buyer.decision": {
      const action = str(p.action);
      const tone = action === "accept" ? "settle" : action === "walk" ? "walk" : "counter";
      return { ...base, actor: "buyer", tone, text: `${action.toUpperCase()} vs ${name}: ${str(p.reasoning).slice(0, 160)}` };
    }
    case "bounds.violation":
      return { ...base, actor: "bounds", tone: "walk", text: `Blocked ${name} round ${num(p.round)}: ${num(p.margin_pct)}% margin is below its own ${num(p.margin_floor_pct)}% floor.` };
    case "agent.degraded":
      return { ...base, actor: "resilience", tone: "counter", text: `${name} lost its pricing model — quoting from rules instead. Margin floor still enforced.` };
    case "marketplace.offer_scored":
      return { ...base, actor: "scoring", tone: "muted", text: `${name} scored ${num(p.score)}${p.low_confidence ? " — flagged low-confidence outlier" : ""}.` };
    case "marketplace.winner_selected":
      return { ...base, actor: "scoring", tone: "settle", text: `${str(p.winner_business_name)} wins at ₹${(num(p.total_price) ?? 0).toLocaleString("en-IN")} (score ${num(p.winner_score)}).` };
    case "gate.seller_confirmation_required":
      return {
        ...base,
        actor: "gate",
        tone: "lock",
        text: p.near_floor
          ? `Waiting on ${str(p.business_name, name)} to confirm stock — and at ${num(p.margin_pct)}% the margin is within ${num(p.near_floor_buffer_pct)}pp of its ${num(p.margin_floor_pct)}% floor, so worth a close look.`
          : `Waiting on ${str(p.business_name, name)} to confirm it can ship this before the buyer pays.`,
      };
    case "mandate.locked":
      return { ...base, actor: "protocol", tone: "lock", text: `Cart hash-locked and dual-signed at ₹${(num(p.amount) ?? 0).toLocaleString("en-IN")}.` };
    case "order.created":
      return { ...base, actor: "razorpay", tone: "settle", text: `Razorpay test order ${str(p.order_id)} created, routed to ${str(p.business_name)}.` };
    case "payment.captured":
      return { ...base, actor: "razorpay", tone: "settle", text: `Payment captured — ₹${(num(p.amount) ?? 0).toLocaleString("en-IN")} settled.` };
    case "payment.provider_error":
      return { ...base, actor: "razorpay", tone: "walk", text: `Razorpay unreachable: ${str(p.error).slice(0, 120)}. Mandate stays valid and signed.` };
    case "vendor.error":
      return { ...base, actor: name, tone: "walk", text: `Dropped out at round ${num(p.round)} (${str(p.stage)} failed) — other vendors continue.` };
    case "marketplace.offer_failed":
      return { ...base, actor: name, tone: "muted", text: `No deal: ${str(p.status).replace(/_/g, " ")}.` };
    default:
      return null;
  }
}

function upsertVendor(
  vendors: VendorState[],
  id: string,
  name: string,
  patch: Partial<VendorState>
): VendorState[] {
  const index = vendors.findIndex((v) => v.id === id);
  if (index === -1) {
    return [
      ...vendors,
      {
        id, name, status: "joined", round: 0, price: null, bestPrice: null,
        agreedPrice: null, listSubtotal: null, goodsSubtotal: null,
        margin: null, score: null, reasoning: null, lastAction: null,
        upsell: null, violations: 0, history: [], ...patch,
      },
    ];
  }
  const next = [...vendors];
  next[index] = { ...next[index], ...patch };
  return next;
}

function reduce(state: NegotiationState, event: StreamEvent): NegotiationState {
  const p = event.payload;
  const id = str(p.business_id);
  const name = str(p.business_name, id);
  let next = { ...state };

  switch (event.type) {
    case "intent.approved":
      next.phase = "negotiating";
      break;
    case "marketplace.broadcast": {
      const eliminated = Array.isArray(p.eliminated) ? p.eliminated : [];
      next.shortlist = {
        considered: num(p.considered) ?? num(p.vendor_count) ?? 0,
        negotiating: num(p.vendor_count) ?? 0,
        eliminated: eliminated.map((e: Record<string, unknown>) => ({
          id: str(e.id),
          name: str(e.name, str(e.id)),
          bound: num(e.bound),
          reason: str(e.reason),
        })),
        saved: (p.saved as Shortlist["saved"]) ?? null,
      };
      break;
    }
    case "intent.rejected":
      next.phase = "failed";
      break;
    case "vendor.joined":
      next.vendors = upsertVendor(next.vendors, id, name, { status: "joined" });
      break;
    case "vendor.thinking":
      next.vendors = upsertVendor(next.vendors, id, name, {
        status: "thinking", round: num(p.round) ?? 0,
      });
      break;
    case "vendor.offer": {
      const price = num(p.total_price);
      const existing = next.vendors.find((v) => v.id === id);
      next.vendors = upsertVendor(next.vendors, id, name, {
        status: "offered",
        round: num(p.round) ?? 0,
        price,
        // Best = lowest offered so far, which is what the buyer is actually
        // comparing across vendors.
        bestPrice:
          price === null ? existing?.bestPrice ?? null
            : Math.min(price, existing?.bestPrice ?? price),
        margin: num(p.margin_pct),
        reasoning: str(p.reasoning) || null,
        history: [...(existing?.history ?? []), price ?? 0],
      });
      break;
    }
    case "vendor.upsell_offered":
      next.vendors = upsertVendor(next.vendors, id, name, { upsell: str(p.item) });
      break;
    case "agent.degraded":
      next.degraded = true;
      break;
    case "bounds.violation": {
      const existing = next.vendors.find((v) => v.id === id);
      next.vendors = upsertVendor(next.vendors, id, name, {
        violations: (existing?.violations ?? 0) + 1,
      });
      break;
    }
    case "buyer.decision": {
      const action = str(p.action);
      next.vendors = upsertVendor(next.vendors, id, name, {
        lastAction: action,
        status: action === "accept" ? "accepted" : action === "walk" ? "walked" : "offered",
        // An accept fixes the price at the round the buyer accepted.
        ...(action === "accept" ? { agreedPrice: num(p.total_price) } : {}),
      });
      break;
    }
    case "vendor.error":
    case "marketplace.offer_failed":
      next.vendors = upsertVendor(next.vendors, id, name, { status: "failed" });
      break;
    case "marketplace.offer_scored":
      next.vendors = upsertVendor(next.vendors, id, name, {
        score: num(p.score),
        listSubtotal: num(p.list_subtotal),
        goodsSubtotal: num(p.goods_subtotal),
      });
      break;
    case "marketplace.winner_selected": {
      const winner = str(p.winner_business_id);
      next.winnerId = winner;
      const agreed = num(p.total_price);
      next.vendors = next.vendors.map((v) =>
        v.id === winner ? { ...v, status: "won", agreedPrice: agreed } : v
      );
      break;
    }
    case "mandate.locked":
      next.lockedHash = str(p.cart_hash);
      break;
    case "order.created":
      next.orderId = str(p.order_id);
      break;
    case "gate.seller_confirmation_required":
      next.phase = "gated";
      break;
    case "payment.provider_error":
      // The mandate is locked and signed; only the payment provider failed.
      // Collapsing this into "failed" would misreport a handled outage as a
      // negotiation that never reached a deal.
      next.phase = "provider_error";
      break;
    case "session.ended": {
      const status = str(p.status);
      next.phase =
        status === "awaiting_payment" || status === "settled" ? "settled"
          : status === "pending_seller_confirmation" ? "gated"
          : status === "payment_provider_error" ? "provider_error"
          : "failed";
      break;
    }
  }

  const item = describe(event);
  if (item) next.feed = [...next.feed, item];
  return next;
}

export function useNegotiation() {
  const [state, setState] = useState<NegotiationState>(EMPTY);
  const closeRef = useRef<(() => void) | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards against the same event being folded twice, which happens whenever
  // the stream reconnects and replays its buffer.
  const seenRef = useRef<Set<number>>(new Set());

  /**
   * Recovers terminal state when the stream cannot.
   *
   * EventSource reconnects on its own and the server replays its buffer, so a
   * brief drop is invisible. A backend *restart* is different: the event bus
   * is in-memory, so the reconnect replays nothing and the console would sit
   * on "negotiating" forever for a session that finished. Polling the session
   * itself is the only source of truth that survives a restart.
   */
  const startWatchdog = useCallback((sessionId: string) => {
    if (watchdogRef.current) clearInterval(watchdogRef.current);
    watchdogRef.current = setInterval(async () => {
      try {
        const session = await getSession(sessionId);
        const status = session.status;
        const terminal =
          status === "awaiting_payment" ||
          status === "settled" ||
          status === "pending_seller_confirmation" ||
          status === "payment_provider_error" ||
          status === "no_valid_offers" ||
          status === "walked_away" ||
          status === "max_rounds_exceeded" ||
          status === "negotiation_error" ||
          status === "orchestrator_error" ||
          status === "rejected_by_human";
        if (!terminal) return;

        setState((prev) => {
          // The stream already got there — leave it alone.
          if (prev.phase !== "negotiating") return prev;
          return {
            ...prev,
            session,
            degraded: prev.degraded || Boolean(session.degraded),
            phase:
              status === "awaiting_payment" || status === "settled"
                ? "settled"
                : status === "pending_seller_confirmation"
                  ? "gated"
                  : status === "payment_provider_error"
                    ? "provider_error"
                    : "failed",
          };
        });
      } catch {
        // Backend still unreachable — keep waiting rather than declaring
        // failure on a session that may well have completed.
      }
    }, 6000);
  }, []);

  const attach = useCallback((sessionId: string) => {
    closeRef.current?.();
    closeRef.current = streamSession(
      sessionId,
      (event) => {
        if (seenRef.current.has(event.seq)) return;
        seenRef.current.add(event.seq);
        setState((prev) => reduce(prev, event));
        if (event.type === "session.ended") {
          if (watchdogRef.current) {
            clearInterval(watchdogRef.current);
            watchdogRef.current = null;
          }
          // Refresh once at the end for the fields the stream doesn't carry
          // (full cart, payment mandate, checkout key).
          getSession(sessionId)
            .then((session) => setState((prev) => ({ ...prev, session })))
            .catch(() => {});
        }
      },
      () => {}
    );
  }, []);

  const draft = useCallback(
    async (params: {
      goal: string;
      max_spend: number;
      qty_min: number;
      qty_max: number;
      ship_within_days?: number;
      requested_lines?: RequestedLine[];
      buyer_business_id?: string;
      preferred_payment_terms?: PaymentTerms;
      weight_price?: number;
      weight_speed?: number;
      weight_terms?: number;
    }) => {
      closeRef.current?.();
      seenRef.current = new Set();
      setState({ ...EMPTY, phase: "drafting" });
      try {
        const session = await createIntent({ ...params, mode: "marketplace" });
        setState((prev) => ({ ...prev, phase: "awaiting_approval", session }));
        attach(session.id);
        return session;
      } catch (e) {
        setState((prev) => ({ ...prev, phase: "failed", error: (e as Error).message }));
        return null;
      }
    },
    [attach]
  );

  const approve = useCallback(async (approvedBy: string) => {
    const id = state.session?.id;
    if (!id) return;
    setState((prev) => ({ ...prev, phase: "negotiating" }));
    try {
      const session = await approveIntent(id, approvedBy);
      setState((prev) => ({ ...prev, session }));
      startWatchdog(id);
    } catch (e) {
      setState((prev) => ({ ...prev, phase: "failed", error: (e as Error).message }));
    }
  }, [state.session?.id, startWatchdog]);

  const reject = useCallback(async () => {
    const id = state.session?.id;
    if (!id) return;
    try {
      await rejectIntent(id, "declined at the approval gate");
    } catch {
      // The stream carries the authoritative outcome either way.
    }
  }, [state.session?.id]);

  const reset = useCallback(() => {
    closeRef.current?.();
    closeRef.current = null;
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
    seenRef.current = new Set();
    setState(EMPTY);
  }, []);

  return { state, draft, approve, reject, reset };
}
