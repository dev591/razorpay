const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

export type CartItem = {
  sku: string;
  name: string;
  qty: number;
  unit_price: number;
  /** Serialised by the backend as a `computed_field` — see the note on
   *  CartItem in protocol/mandates.py about why it isn't a plain property. */
  line_total: number;
};

export type CartMandate = {
  id: string;
  round: number;
  items: CartItem[];
  upsell_item: CartItem | null;
  lead_time_days: number;
  payment_terms: PaymentTerms;
  margin_pct: number;
  /** Goods only — the base the margin floor is measured against. */
  goods_subtotal: number;
  /** Freight, priced off the promised ETA. Its own line, not baked into unit price. */
  shipping_cost: number;
  total_units: number;
  total_price: number;
  credit_days: number;
  financing_cost: number;
  net_realisable_total: number;
  reasoning: string;
};

export type BuyerDecision = {
  action: "accept" | "counter" | "walk";
  reasoning: string;
};

export type PaymentTerms = "advance" | "net_15" | "net_30" | "net_45";

/** Days of credit each term grants — mirrors protocol/terms.py. */
export const CREDIT_DAYS: Record<PaymentTerms, number> = {
  advance: 0,
  net_15: 15,
  net_30: 30,
  net_45: 45,
};

export function describeTerms(terms: PaymentTerms | string): string {
  const days = CREDIT_DAYS[terms as PaymentTerms] ?? 0;
  return days === 0 ? "on despatch" : `${days}-day credit`;
}

export type RequestedLine = { name: string; qty: number };

export type IntentMandate = {
  id: string;
  goal: string;
  max_spend: number;
  qty_min: number;
  qty_max: number;
  ship_within_days: number;
  requested_lines: RequestedLine[];
  preferred_payment_terms: PaymentTerms;
  weight_price: number;
  weight_speed: number;
  weight_terms: number;
};

export type PaymentMandate = {
  id: string;
  cart_id: string;
  cart_hash: string;
  amount: number;
};

export type TranscriptMessage = { from: "buyer" | "merchant"; text: string };

export type Offer = {
  business_id: string;
  business_name: string;
  status: string;
  cart: CartMandate | null;
  total_price: number | null;
  rounds: { round: number; cart: CartMandate; decision: BuyerDecision }[];
};

export type Session = {
  id: string;
  status: string;
  intent: IntentMandate;
  rounds: { round: number; cart: CartMandate; decision: BuyerDecision }[];
  final_cart: CartMandate | null;
  payment_mandate: PaymentMandate | null;
  razorpay_order: { id: string; amount: number; status: string } | null;
  razorpay_checkout_key: string | null;
  razorpay_payment_id: string | null;
  transcript: TranscriptMessage[];
  offers?: Offer[];
  winner_business_id?: string | null;
  buyer_business_id?: string | null;
  seller_business_id?: string | null;
  pending_seller_confirmation?: boolean;
  seller_acknowledged?: boolean;
  margin_pct?: number | null;
  margin_floor_pct?: number | null;
  created_at?: number;
};

export type AuditEntry = {
  seq: number;
  timestamp: number;
  event_type: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

export type AuditResponse = { entries: AuditEntry[]; chain_valid: boolean };

export type TamperResult = {
  session_id: string;
  expected_hash: string;
  tampered_hash: string;
  rejected: boolean;
};

export type BusinessCatalogItem = {
  sku: string;
  /** The merchant's unit cost. Same value as `cost`; kept for compatibility. */
  price: number;
  name: string;
  cost: number;
  /** Shelf price. What an AI buyer sees in catalog search. */
  list_price: number;
};

export type Business = {
  id: string;
  name: string;
  margin_floor_pct: number;
  catalog: BusinessCatalogItem[];
  /** Unix seconds for a vendor registered at runtime; null for the seeded
   *  three, which are defined in code and have no registration moment. */
  registered_at: number | null;
};

export type MetricsResponse = {
  ready: boolean;
  refreshing?: boolean;
  n?: number;
  locked_or_settled?: number;
  walked_away?: number;
  avg_margin_pct?: number;
  upsell_offer_rate_pct?: number;
  tamper_catch_rate_pct?: number;
};

// Real negotiations make several live OpenAI calls and can legitimately take
// 10-20s (longer with more marketplace businesses); quick reads should never
// take that long. Without a timeout at all, an unexpected backend hang would
// leave a "negotiating..." button stuck forever with zero feedback — so
// every call fails loudly after a bound instead of silently sitting there.
const DEFAULT_TIMEOUT_MS = 15_000;
const NEGOTIATION_TIMEOUT_MS = 90_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s — the backend may be down or an OpenAI call stalled.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * FastAPI puts a human-readable reason in `detail`. Several of these are
 * validation messages the user is meant to act on ("no registered vendor
 * stocks: Helicopter"), so surface that sentence rather than a wall of raw
 * JSON with a status code in front of it.
 */
async function httpError(path: string, res: Response): Promise<Error> {
  const body = await res.text();
  try {
    const detail = JSON.parse(body)?.detail;
    if (typeof detail === "string" && detail) return new Error(detail);
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return new Error(`${path} failed: ${res.status} ${body}`);
}

async function postJSON<T>(
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const res = await fetchWithTimeout(
    `${BACKEND_URL}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    },
    timeoutMs
  );
  if (!res.ok) throw await httpError(path, res);
  return res.json();
}

async function getJSON<T>(
  path: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const res = await fetchWithTimeout(`${BACKEND_URL}${path}`, {}, timeoutMs);
  if (!res.ok) throw await httpError(path, res);
  return res.json();
}

export function startSession(params: {
  goal: string;
  max_spend: number;
  qty_min: number;
  qty_max: number;
  ship_within_days?: number;
}): Promise<Session> {
  return postJSON<Session>("/sessions", params, NEGOTIATION_TIMEOUT_MS);
}

export function runMarketplaceSession(params: {
  goal: string;
  max_spend: number;
  qty_min: number;
  qty_max: number;
  ship_within_days?: number;
  buyer_business_id?: string;
}): Promise<Session> {
  return postJSON<Session>("/marketplace/sessions", params, NEGOTIATION_TIMEOUT_MS);
}

export function getAudit(sessionId: string): Promise<AuditResponse> {
  return getJSON<AuditResponse>(`/sessions/${sessionId}/audit`);
}

export function tamperSession(sessionId: string): Promise<TamperResult> {
  return postJSON<TamperResult>(`/sessions/${sessionId}/tamper`);
}

export function acknowledgeDispatch(
  sessionId: string,
  businessId: string
): Promise<Session> {
  return postJSON<Session>(`/sessions/${sessionId}/acknowledge`, {
    business_id: businessId,
  });
}

export type ModelOutage = {
  model_unreachable: boolean;
  expires_in_seconds: number | null;
};

/** Breaks the upstream model for real — the retry budget, the rule-based
 *  fallback and the `degraded` labelling all run as they would in an outage.
 *  Self-expires so it can't be left on. */
export function setModelOutage(enabled: boolean, ttlSeconds?: number): Promise<ModelOutage> {
  return postJSON<ModelOutage>("/chaos/model-outage", { enabled, ttl_seconds: ttlSeconds });
}

export function getModelOutage(): Promise<ModelOutage> {
  return getJSON<ModelOutage>("/chaos/model-outage");
}

export function getMetrics(): Promise<MetricsResponse> {
  return getJSON<MetricsResponse>("/metrics");
}

export function listBusinesses(): Promise<Business[]> {
  return getJSON<Business[]>("/businesses");
}

export type BusinessOrders = { as_buyer: Session[]; as_seller: Session[] };

export function getBusinessOrders(businessId: string): Promise<BusinessOrders> {
  return getJSON<BusinessOrders>(
    `/businesses/${encodeURIComponent(businessId)}/orders`
  );
}

export function registerBusiness(params: {
  name: string;
  catalog: { name: string; price: number }[];
  margin_floor_pct: number;
}): Promise<Business> {
  return postJSON<Business>("/businesses", params);
}

export function checkoutUrl(sessionId: string): string {
  return `${BACKEND_URL}/sessions/${sessionId}/checkout`;
}

export function confirmPayment(
  sessionId: string,
  params: {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
  }
): Promise<Session> {
  return postJSON<Session>(`/sessions/${sessionId}/payment-callback`, params);
}

// ─── Human-gated intent lifecycle ────────────────────────────────────────
//
// Two calls, not one. `createIntent` mints and signs the mandate and stops —
// nothing reaches an LLM, a vendor or Razorpay until `approveIntent`. That
// gap is the human approval gate, and it's why these are separate here
// rather than folded into one convenience helper.

export type IntentSession = Session & {
  mode?: "marketplace" | "single";
  /** A vendor fell back to rule-based pricing during this session. */
  degraded?: boolean;
  approved_by?: string | null;
  approval_signature?: string | null;
  ranked_offers?: RankedOffer[];
};

export type RankedOffer = {
  business_id: string;
  business_name: string;
  total_price: number;
  score: number;
  low_confidence: boolean;
};

export function createIntent(params: {
  goal: string;
  max_spend: number;
  qty_min: number;
  qty_max: number;
  ship_within_days?: number;
  /** Named basket. Omit or leave empty for "anything in the quantity band". */
  requested_lines?: RequestedLine[];
  buyer_business_id?: string;
  mode?: "marketplace" | "single";
  preferred_payment_terms?: PaymentTerms;
  weight_price?: number;
  weight_speed?: number;
  weight_terms?: number;
}): Promise<IntentSession> {
  return postJSON<IntentSession>("/intents", params);
}

export function approveIntent(
  sessionId: string,
  approvedBy = "human"
): Promise<IntentSession> {
  // Returns as soon as the negotiation is *dispatched*, not when it finishes
  // — progress arrives over the event stream, so the default timeout is right.
  return postJSON<IntentSession>(`/intents/${sessionId}/approve`, {
    approved_by: approvedBy,
  });
}

export function rejectIntent(
  sessionId: string,
  reason = "rejected by human"
): Promise<IntentSession> {
  return postJSON<IntentSession>(`/intents/${sessionId}/reject`, { reason });
}

export function getSession(sessionId: string): Promise<IntentSession> {
  return getJSON<IntentSession>(`/sessions/${sessionId}`);
}

export function confirmSeller(sessionId: string): Promise<Session> {
  return postJSON<Session>(`/sessions/${sessionId}/confirm-seller`);
}

// ─── Agent-readable surface ──────────────────────────────────────────────

export type CatalogHit = {
  business_id: string;
  business_name: string;
  sku: string;
  name: string;
  list_price: number;
  margin_floor_pct: number;
};

export function searchCatalog(q: string, limit = 20): Promise<{ query: string; results: CatalogHit[] }> {
  return getJSON(`/agent/catalog/search?q=${encodeURIComponent(q)}&limit=${limit}`);
}

export function completeCatalog(prefix: string, limit = 8): Promise<{ prefix: string; results: CatalogHit[] }> {
  return getJSON(`/agent/catalog/complete?prefix=${encodeURIComponent(prefix)}&limit=${limit}`);
}

export function getAgentCard(): Promise<Record<string, unknown>> {
  return getJSON("/.well-known/agent-card.json");
}

// ─── Growth + runtime telemetry ──────────────────────────────────────────

export type LeaderboardRow = {
  rank: number;
  business_id: string;
  revenue: number;
  orders: number;
  settled_orders: number;
  units: number;
  avg_margin_pct: number;
  avg_order_value: number;
};

export type LeaderboardResponse = {
  top: LeaderboardRow[];
  totals: {
    booked_gmv: number;
    total_orders: number;
    settled_orders: number;
    vendors_ranked: number;
  };
};

export function getLeaderboard(k = 10): Promise<LeaderboardResponse> {
  return getJSON<LeaderboardResponse>(`/leaderboard?k=${k}`);
}

export type SystemStats = {
  store: {
    total_sessions: number;
    hot_resident: number;
    hot_capacity: number;
    indexed_buyers: number;
    indexed_sellers: number;
  };
  catalog: { indexed_skus: number; distinct_tokens: number; trie_nodes: number };
  events: { topics: number; subscribers: number; buffered_events: number; replay_capacity: number };
  leaderboard: { booked_gmv: number; total_orders: number; settled_orders: number; vendors_ranked: number };
};

export function getSystemStats(): Promise<SystemStats> {
  return getJSON<SystemStats>("/system/stats");
}

export function getRecentSessions(limit = 20): Promise<Session[]> {
  return getJSON<Session[]>(`/recent-sessions?limit=${limit}`);
}

// ─── Live negotiation stream ─────────────────────────────────────────────

export type StreamEvent = {
  seq: number;
  topic: string;
  type: string;
  at: number;
  payload: Record<string, unknown>;
};

/**
 * Opens the SSE stream for one session.
 *
 * The backend replays that session's buffered events on connect, so a
 * subscriber that attaches late still sees the whole negotiation rather than
 * joining blind partway through. Returns the close function.
 */
export function streamSession(
  sessionId: string,
  onEvent: (event: StreamEvent) => void,
  onError?: (err: Event) => void
): () => void {
  const source = new EventSource(`${BACKEND_URL}/sessions/${sessionId}/stream`);

  // Every event is dispatched under its own `event:` name, so there is no
  // default-typed message to listen for — `addEventListener("message")` would
  // receive nothing. Listen per known type instead.
  const types = [
    "agent.degraded",
    "intent.awaiting_approval",
    "intent.approved",
    "intent.rejected",
    "marketplace.broadcast",
    "vendor.joined",
    "vendor.thinking",
    "vendor.offer",
    "vendor.upsell_offered",
    "vendor.error",
    "buyer.decision",
    "bounds.violation",
    "marketplace.offer_received",
    "marketplace.offer_failed",
    "marketplace.offer_scored",
    "marketplace.winner_selected",
    "gate.seller_confirmation_required",
    "mandate.locked",
    "order.created",
    "payment.captured",
    "payment.capture_failed",
    "payment.provider_error",
    "session.ended",
  ];

  const handler = (e: MessageEvent) => {
    try {
      onEvent(JSON.parse(e.data) as StreamEvent);
    } catch {
      // A malformed frame should drop that frame, not tear down the stream.
    }
  };

  for (const type of types) source.addEventListener(type, handler as EventListener);
  source.onerror = (err) => onError?.(err);

  return () => {
    for (const type of types) source.removeEventListener(type, handler as EventListener);
    source.close();
  };
}

// ─── Choosing between vendors ────────────────────────────────────────────

export type ScoreBreakdown = {
  price_score: number;
  speed_score: number;
  delivery_score: number;
  convergence_score: number;
  terms_score: number;
  weights: { price: number; speed: number; terms: number };
  lead_time_days: number | null;
  payment_terms: string | null;
  rounds_used: number;
  low_confidence_discount_applied: boolean;
  discount_multiplier: number;
};

export type OfferOption = {
  business_id: string;
  business_name: string;
  total_price: number | null;
  goods_subtotal: number | null;
  /** The same goods at this vendor's sticker price, for the before/after. */
  list_subtotal: number | null;
  shipping_cost: number | null;
  lead_time_days: number | null;
  payment_terms: PaymentTerms | null;
  score: number | null;
  score_breakdown: ScoreBreakdown | null;
  low_confidence: boolean;
  is_recommended: boolean;
  is_selected: boolean;
  /** False once a payment is captured, or if the process restarted. */
  selectable: boolean;
};

export type OfferOptions = {
  session_id: string;
  status: string;
  winner_business_id: string | null;
  selected_business_id: string | null;
  options: OfferOption[];
};

export function getOffers(sessionId: string): Promise<OfferOptions> {
  return getJSON<OfferOptions>(`/sessions/${sessionId}/offers`);
}

/**
 * Settle a specific vendor's offer instead of the recommended one.
 *
 * Runs the identical hash-lock / dual-sign / Razorpay path — the scorer only
 * ranks, it does not decide.
 */
export function selectOffer(
  sessionId: string,
  businessId: string
): Promise<IntentSession> {
  return postJSON<IntentSession>(
    `/sessions/${sessionId}/select-offer/${encodeURIComponent(businessId)}`
  );
}

// ─── Measured unit economics ─────────────────────────────────────────────

export type Economics = {
  model: string;
  rates_usd_per_million: { input: number; cached_input: number; output: number };
  usd_to_inr: number;
  totals: {
    llm_calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    usd: number;
    inr: number;
  };
  calls_by_agent: Record<string, number>;
  per_negotiation: {
    sessions_metered: number;
    avg_llm_calls: number;
    avg_tokens: number;
    avg_usd: number;
    avg_inr: number;
  };
};

/** Recorded from each completion's `usage` block — measured, not estimated. */
export function getEconomics(): Promise<Economics> {
  return getJSON<Economics>("/economics");
}
