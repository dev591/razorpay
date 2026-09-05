"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import ActivityFeed from "@/components/console/ActivityFeed";
import ApprovalGate from "@/components/console/ApprovalGate";
import SettlementPanel from "@/components/console/SettlementPanel";
import VendorRace from "@/components/console/VendorRace";
import ShortlistPanel from "@/components/console/ShortlistPanel";
import { useNegotiation } from "@/components/console/useNegotiation";
import OfferBoard from "@/components/console/OfferBoard";
import NumberField from "@/components/ui/NumberField";
import OutageToggle from "@/components/console/OutageToggle";
import NextStep from "@/components/console/NextStep";
import {
  getSystemStats,
  listBusinesses,
  type Business,
  type PaymentTerms,
  type RequestedLine,
  type SystemStats,
} from "@/lib/api";
import { rupees } from "@/lib/format";

type Preset = {
  label: string;
  goal: string;
  max_spend: number;
  qty_min: number;
  qty_max: number;
  ship_within_days: number;
  preferred_payment_terms: PaymentTerms;
  requested_lines: RequestedLine[];
};

// Each preset carries a basket. A multi-line request is the harder negotiation:
// no vendor is cheapest on every item, so they have to trade across lines
// instead of shaving one number.
const PRESETS: Preset[] = [
  { label: "Routine restock", goal: "Restock office peripherals", max_spend: 42000, qty_min: 40, qty_max: 60, ship_within_days: 7, preferred_payment_terms: "net_30",
    requested_lines: [{ name: "Wireless Mouse", qty: 25 }, { name: "USB-C Hub", qty: 15 }] },
  { label: "Urgent — new hires Monday", goal: "Bulk order for new hires starting Monday", max_spend: 95000, qty_min: 50, qty_max: 80, ship_within_days: 2, preferred_payment_terms: "net_15",
    requested_lines: [{ name: "Wireless Mouse", qty: 20 }, { name: "Mechanical Keyboard", qty: 20 }, { name: "Laptop Stand", qty: 10 }] },
  { label: "Cash-tight quarter", goal: "Warehouse replenishment", max_spend: 30000, qty_min: 25, qty_max: 45, ship_within_days: 14, preferred_payment_terms: "net_45",
    requested_lines: [{ name: "USB-C Hub", qty: 25 }] },
];

const TERMS_OPTIONS: { value: PaymentTerms; label: string }[] = [
  { value: "advance", label: "On despatch" },
  { value: "net_15", label: "15-day credit" },
  { value: "net_30", label: "30-day credit" },
  { value: "net_45", label: "45-day credit" },
];

// What the buyer optimises for. Named the way a purchaser would describe the
// situation, rather than as three raw weight sliders nobody would tune.
const PRIORITIES = [
  { id: "balanced", label: "Balanced", weight_price: 0.5, weight_speed: 0.3, weight_terms: 0.2 },
  { id: "cheapest", label: "Cheapest wins", weight_price: 0.8, weight_speed: 0.1, weight_terms: 0.1 },
  { id: "fastest", label: "Need it fast", weight_price: 0.2, weight_speed: 0.65, weight_terms: 0.15 },
  { id: "cashflow", label: "Protect cash flow", weight_price: 0.3, weight_speed: 0.15, weight_terms: 0.55 },
] as const;

const PHASE_COPY: Record<string, string> = {
  idle: "Compose an intent to begin",
  drafting: "Signing intent mandate…",
  awaiting_approval: "Blocked — awaiting human approval",
  negotiating: "Agents negotiating live",
  gated: "Waiting on the seller to confirm stock",
  settled: "Mandate locked and order created",
  provider_error: "Razorpay unreachable — signed mandate held intact",
  failed: "Ended without a deal",
};

export default function NegotiationConsole({ embedded = false }: { embedded?: boolean }) {
  const reduceMotion = useReducedMotion();
  const { state, draft, approve, reject, reset } = useNegotiation();
  const [form, setForm] = useState<Preset>(PRESETS[0]);
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>(PRIORITIES[0]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  // Who is doing the buying. Default is the standalone buyer agent; picking a
  // registered vendor makes this a restock — that vendor is excluded from the
  // seller side, and the deal shows up on its own merchant page as a purchase.
  const [buyerId, setBuyerId] = useState<string>("");
  // Bumped when the human takes a different offer, so anything reading the
  // session back from the server re-reads it — the winner has changed.
  const [selectionNonce, setSelectionNonce] = useState(0);
  const [vendors, setVendors] = useState<Business[]>([]);

  useEffect(() => {
    listBusinesses().then(setVendors).catch(() => {});
  }, []);

  const setLine = (i: number, patch: Partial<RequestedLine>) =>
    setForm((f) => ({
      ...f,
      requested_lines: f.requested_lines.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    }));

  const addLine = () =>
    setForm((f) => ({ ...f, requested_lines: [...f.requested_lines, { name: "", qty: 10 }] }));

  const removeLine = (i: number) =>
    setForm((f) => ({ ...f, requested_lines: f.requested_lines.filter((_, j) => j !== i) }));

  // Blank rows are the natural state of a half-filled form, not an error —
  // drop them on submit rather than blocking the button.
  const basket = form.requested_lines.filter((l) => l.name.trim() !== "" && l.qty > 0);
  const basketUnits = basket.reduce((n, l) => n + l.qty, 0);

  useEffect(() => {
    getSystemStats().then(setStats).catch(() => {});
  }, [state.phase]);

  const busy = state.phase === "drafting" || state.phase === "negotiating";
  const intent = state.session?.intent ?? null;
  const amount = state.session?.payment_mandate?.amount ?? null;

  return (
    <div className="bg-mist/50">
      {/* Live status bar — always visible, so the phase is never ambiguous. */}
      <div
        className={`${embedded ? "" : "sticky top-16 z-30"} border-b border-line/70 bg-white/80 backdrop-blur-xl`}
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
          <span className="flex items-center gap-2">
            <motion.span
              className={`inline-block h-2 w-2 rounded-full ${
                state.phase === "negotiating"
                  ? "bg-rzp-500"
                  : state.phase === "settled"
                    ? "bg-[color:var(--color-settle)]"
                    : state.phase === "awaiting_approval" || state.phase === "gated"
                      ? "bg-[color:var(--color-lock)]"
                      : state.phase === "provider_error"
                        ? "bg-[color:var(--color-counter)]"
                        : "bg-line"
              }`}
              animate={
                reduceMotion || !busy ? {} : { scale: [1, 1.4, 1], opacity: [1, 0.5, 1] }
              }
              transition={{ duration: 1.4, repeat: Infinity }}
            />
            <span className="font-display text-[13px] font-semibold text-ink">
              {PHASE_COPY[state.phase]}
            </span>
          </span>
          {stats && (
            <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
              <span>{stats.store.total_sessions} sessions</span>
              <span>
                LRU {stats.store.hot_resident}/{stats.store.hot_capacity}
              </span>
              <span>{stats.catalog.indexed_skus} SKUs indexed</span>
              <span>{rupees(Math.round(stats.leaderboard.booked_gmv))} booked</span>
            </span>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-7">
          {embedded && (
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rzp-600">
              Watch it happen
            </p>
          )}
          <h2 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
            Set your terms. Let them fight over it.
          </h2>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-slate-ink">
            {/* Never a fixed count: anyone can add a vendor on /vendors, and a
                hardcoded "three" goes wrong the moment they do. */}
            Every merchant agent bids against the others on price, delivery and
            payment terms at once. Every price is a real model call, every
            settlement a real Razorpay test-mode order — and you pick the winner,
            not the algorithm.
          </p>
        </header>

        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          {/* ── left: compose → approve → race ─────────────────────────── */}
          <div className="space-y-5">
            <div className="rounded-3xl border border-line bg-white p-5">
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => setForm(preset)}
                    disabled={busy}
                    className={`rounded-full border px-3.5 py-1.5 text-[12.5px] font-medium transition disabled:opacity-40 ${
                      form.label === preset.label
                        ? "border-rzp-500 bg-rzp-50 text-rzp-700"
                        : "border-line text-slate-ink hover:border-rzp-300"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Buying as
                  </label>
                  <select
                    value={buyerId}
                    disabled={busy}
                    onChange={(e) => setBuyerId(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-[13.5px] text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100 disabled:bg-mist"
                  >
                    <option value="">A standalone buyer agent</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} — restocking
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                    {buyerId
                      ? "A restock: this vendor cannot bid against itself, and the order shows on its own merchant page as a purchase."
                      : "Pick a vendor to run this as a merchant-to-merchant restock."}
                  </p>
                </div>

                <div className="sm:col-span-2">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Why you're buying
                  </label>
                  <input
                    value={form.goal}
                    disabled={busy}
                    onChange={(e) => setForm({ ...form, goal: e.target.value })}
                    className="mt-1 w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-[13.5px] text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100 disabled:bg-mist"
                  />
                </div>

                {/* The basket. Every named line has to appear in the winning
                    cart, enforced in code by the buyer agent — so a vendor
                    can't win by quietly substituting whatever it's cheapest
                    at, and no vendor is cheapest on all of them. */}
                <div className="sm:col-span-2">
                  <div className="flex items-baseline justify-between">
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      What to buy
                    </label>
                    <span className="text-[11px] text-muted">
                      {basket.length === 0
                        ? "anything within the quantity band"
                        : `${basket.length} line${basket.length > 1 ? "s" : ""} · ${basketUnits} units`}
                    </span>
                  </div>
                  <div className="mt-1.5 space-y-2">
                    {form.requested_lines.map((line, i) => (
                      <div key={i} className="grid grid-cols-[1fr_92px_auto] gap-2">
                        <input
                          value={line.name}
                          disabled={busy}
                          onChange={(e) => setLine(i, { name: e.target.value })}
                          placeholder="Wireless Mouse"
                          className="rounded-xl border border-line bg-white px-3.5 py-2.5 text-[13.5px] text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100 disabled:bg-mist"
                        />
                        <NumberField
                          value={line.qty}
                          min={1}
                          disabled={busy}
                          onValueChange={(n) => setLine(i, { qty: n })}
                          className="w-full min-w-0 rounded-xl border border-line bg-white px-3 py-2.5 text-[13.5px] tabular-nums text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100 disabled:bg-mist"
                        />
                        <button
                          onClick={() => removeLine(i)}
                          disabled={busy}
                          aria-label={`Remove ${line.name || "item"}`}
                          className="rounded-xl border border-line px-3 text-[13px] text-muted transition hover:border-walk hover:text-walk disabled:opacity-40"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={addLine}
                    disabled={busy}
                    className="mt-2 text-[12.5px] font-medium text-rzp-600 transition hover:text-rzp-500 disabled:opacity-40"
                  >
                    + Add item
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:col-span-2 lg:grid-cols-4">
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Budget ₹
                    </label>
                    <NumberField
                      value={form.max_spend}
                      min={0}
                      disabled={busy}
                      onValueChange={(n) => setForm({ ...form, max_spend: n })}
                      className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[13.5px] tabular-nums text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100 disabled:bg-mist"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Units
                    </label>
                    <div className="mt-1 flex items-center gap-1">
                      <NumberField
                        value={form.qty_min}
                        min={0}
                        disabled={busy}
                        onValueChange={(n) => setForm({ ...form, qty_min: n })}
                        className="w-full min-w-0 rounded-xl border border-line bg-white px-2 py-2.5 text-[13.5px] tabular-nums text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100 disabled:bg-mist"
                      />
                      <span className="text-[12px] text-muted">–</span>
                      <NumberField
                        value={form.qty_max}
                        min={0}
                        disabled={busy}
                        onValueChange={(n) => setForm({ ...form, qty_max: n })}
                        className="w-full min-w-0 rounded-xl border border-line bg-white px-2 py-2.5 text-[13.5px] tabular-nums text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100 disabled:bg-mist"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Need it in
                    </label>
                    <div className="mt-1 flex items-center gap-1.5">
                      <NumberField
                        value={form.ship_within_days}
                        min={1}
                        disabled={busy}
                        onValueChange={(n) => setForm({ ...form, ship_within_days: n })}
                        className="w-full min-w-0 rounded-xl border border-line bg-white px-3 py-2.5 text-[13.5px] tabular-nums text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100 disabled:bg-mist"
                      />
                      <span className="shrink-0 text-[12px] text-muted">days</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Payment
                    </label>
                    <select
                      value={form.preferred_payment_terms}
                      disabled={busy}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          preferred_payment_terms: e.target.value as PaymentTerms,
                        })
                      }
                      className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[13.5px] text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100 disabled:bg-mist"
                    >
                      {TERMS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              <div className="mt-4">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  What matters most
                </label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {PRIORITIES.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setPriority(p)}
                      disabled={busy}
                      className={`rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition disabled:opacity-40 ${
                        priority.id === p.id
                          ? "border-ink bg-ink text-white"
                          : "border-line text-slate-ink hover:border-rzp-300"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2.5">
                <motion.button
                  whileHover={reduceMotion || busy ? {} : { scale: 1.015 }}
                  whileTap={reduceMotion || busy ? {} : { scale: 0.985 }}
                  onClick={() =>
                    draft({
                      ...form,
                      requested_lines: basket,
                      buyer_business_id: buyerId || undefined,
                      weight_price: priority.weight_price,
                      weight_speed: priority.weight_speed,
                      weight_terms: priority.weight_terms,
                    })
                  }
                  disabled={busy}
                  className="rounded-full bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-white shadow-[0_6px_20px_-8px_rgba(19,38,68,0.6)] transition hover:bg-ink-600 disabled:opacity-50"
                >
                  {state.phase === "drafting" ? "Signing…" : "Draft intent mandate"}
                </motion.button>
                {state.session && (
                  <button
                    onClick={reset}
                    disabled={busy}
                    className="text-[12.5px] font-medium text-muted transition hover:text-ink disabled:opacity-40"
                  >
                    Start over
                  </button>
                )}
                {state.session && (
                  <span className="font-mono text-[10.5px] text-muted">
                    {state.session.id}
                  </span>
                )}
                <OutageToggle disabled={busy} />
              </div>
            </div>

            <AnimatePresence mode="wait">
              {state.phase === "awaiting_approval" && intent && (
                <ApprovalGate
                  key="gate"
                  intent={intent}
                  busy={false}
                  onApprove={approve}
                  onReject={reject}
                />
              )}
            </AnimatePresence>

            {state.degraded && (
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl border border-[color:var(--color-counter)]/40 bg-[color:var(--color-counter)]/[0.06] p-4"
              >
                <p className="text-[13px] font-semibold text-ink">
                  Running on rule-based pricing
                </p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-slate-ink">
                  At least one vendor could not reach its pricing model after
                  retries, so it quoted from its catalog rules instead. The
                  offers below are real, signed and still floor-enforced —
                  just not negotiated by a model. This is recorded in the
                  audit trail.
                </p>
              </motion.div>
            )}

            {state.vendors.length > 0 && (
              <div>
                <h2 className="mb-2.5 font-display text-[13px] font-bold uppercase tracking-[0.14em] text-muted">
                  Vendors bidding
                </h2>
                <VendorRace vendors={state.vendors} winnerId={state.winnerId} />
              </div>
            )}

            {state.shortlist && <ShortlistPanel shortlist={state.shortlist} />}

            {state.session &&
              (state.phase === "settled" ||
                state.phase === "gated" ||
                state.phase === "provider_error") && (
                <OfferBoard
                  sessionId={state.session.id}
                  onSelected={() => {
                    setSelectionNonce((n) => n + 1);
                    getSystemStats().then(setStats).catch(() => {});
                  }}
                />
              )}

            {state.session && (state.lockedHash || state.phase === "gated") && (
              <div className="space-y-3">
                <NextStep
                  sessionId={state.session.id}
                  gated={state.phase === "gated"}
                  refreshKey={selectionNonce}
                />
                <SettlementPanel
                  sessionId={state.session.id}
                  amount={amount}
                  cartHash={state.lockedHash}
                  orderId={state.orderId}
                  gated={state.phase === "gated"}
                  providerError={state.phase === "provider_error"}
                  onConfirmed={() => {}}
                />
              </div>
            )}

            {state.error && (
              <p className="rounded-2xl border border-[color:var(--color-walk)]/30 bg-[color:var(--color-walk)]/[0.05] p-4 text-[13px] text-[color:var(--color-walk)]">
                {state.error}
              </p>
            )}
          </div>

          {/* ── right: the trail ───────────────────────────────────────── */}
          <aside className="lg:sticky lg:top-32 lg:self-start">
            <div className="rounded-3xl border border-line bg-white p-5">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-display text-[13px] font-bold uppercase tracking-[0.14em] text-muted">
                  Live trail
                </h2>
                <span className="font-mono text-[10.5px] text-muted">
                  {state.feed.length} events
                </span>
              </div>
              <ActivityFeed items={state.feed} />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
