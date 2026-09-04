"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { VendorState } from "./useNegotiation";
import { rupees } from "@/lib/format";

/**
 * Every shortlisted vendor bidding at once, as lanes rather than a list.
 *
 * The bar is scaled against the *worst* live offer, not the buyer's budget:
 * every vendor prices under budget, so a budget-relative bar leaves all three
 * nearly full and the competition invisible. Relative to the field, the
 * spread is the whole story.
 */

const STATUS_LABEL: Record<VendorState["status"], string> = {
  joined: "connecting",
  thinking: "thinking",
  offered: "offer on table",
  accepted: "accepted",
  walked: "buyer walked",
  failed: "no deal",
  won: "won",
};

/**
 * What the headline price actually means for this vendor.
 *
 * Without this the board reads as a straight price comparison and the winner
 * looks wrong: a vendor that never converged still has a *lowest offered*
 * price, and it is often below the price that was actually agreed. That
 * number was never a deal on the table — it was a bid the buyer declined —
 * so it has to be labelled differently from an agreed price, or the cheapest
 * row looks like the one that should have won.
 */
function priceCaption(vendor: VendorState): string {
  switch (vendor.status) {
    case "won":
      return "agreed · winning bid";
    case "accepted":
      return "agreed";
    case "walked":
      return "last bid · buyer walked";
    case "failed":
      return "last bid · never agreed";
    case "thinking":
      return "bidding…";
    default:
      return "current bid";
  }
}

const STATUS_STYLE: Record<VendorState["status"], string> = {
  joined: "text-muted bg-surface",
  thinking: "text-rzp-600 bg-rzp-50",
  offered: "text-rzp-700 bg-rzp-100",
  accepted: "text-[color:var(--color-settle)] bg-[color:var(--color-settle)]/10",
  walked: "text-[color:var(--color-walk)] bg-[color:var(--color-walk)]/10",
  failed: "text-muted bg-surface",
  won: "text-white bg-[color:var(--color-settle)]",
};

function Spark({ history, won }: { history: number[]; won: boolean }) {
  // Each vendor's own price trajectory across rounds — the shape of it
  // conceding (or refusing to) is the most legible signal that a real
  // negotiation happened rather than a single quote.
  const points = history.filter((n) => n > 0);
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 24 - ((p - min) / span) * 20 - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full" aria-hidden>
      <motion.path
        d={d}
        fill="none"
        stroke={won ? "var(--color-settle)" : "var(--color-rzp-500)"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      />
    </svg>
  );
}

export default function VendorRace({
  vendors,
  winnerId,
}: {
  vendors: VendorState[];
  winnerId: string | null;
}) {
  const reduceMotion = useReducedMotion();
  const priceOf = (v: VendorState) => v.agreedPrice ?? v.bestPrice ?? v.price;
  const live = vendors.map(priceOf).filter((n): n is number => n !== null);
  const ceiling = live.length ? Math.max(...live) : 0;

  if (vendors.length === 0) return null;

  // Cheapest first once offers exist, so the leader is always at the top and
  // overtaking is visible as a row physically moving up.
  const ordered = [...vendors].sort((a, b) => {
    // Winner first regardless of price: it is the row that describes the
    // actual outcome, and burying it under a cheaper rejected bid is exactly
    // the confusion this board has to avoid.
    if (a.id === winnerId) return -1;
    if (b.id === winnerId) return 1;
    return (priceOf(a) ?? Infinity) - (priceOf(b) ?? Infinity);
  });

  return (
    <div className="space-y-2.5">
      {ordered.map((vendor) => {
        const price = priceOf(vendor);
        const won = vendor.id === winnerId;
        // Whether the winner actually beat anyone changes what "why it won"
        // can honestly claim: sole survivor, or best of several real offers.
        const rivals = vendors.filter(
          (v) => v.id !== vendor.id && (v.status === "accepted" || v.status === "won")
        ).length;
        const hasDeclined = vendors.some(
          (v) => v.status === "failed" || v.status === "walked"
        );
        const width = price && ceiling ? Math.max((price / ceiling) * 100, 8) : 0;

        // What the negotiation actually moved, goods-for-goods. Only once the
        // vendor has settled: comparing a sticker price against a cart still
        // being counter-offered would be measuring against a moving target.
        // A non-positive gap is not shown rather than dressed up as a saving.
        const settled = vendor.agreedPrice !== null;
        const gap =
          settled && vendor.listSubtotal !== null && vendor.goodsSubtotal !== null
            ? vendor.listSubtotal - vendor.goodsSubtotal
            : null;
        const saved = gap !== null && gap > 0 ? gap : null;
        const savedPct =
          saved !== null && vendor.listSubtotal
            ? ((saved / vendor.listSubtotal) * 100).toFixed(1)
            : null;

        return (
          <motion.div
            key={vendor.id}
            layout={!reduceMotion}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            className={`relative overflow-hidden rounded-2xl border p-4 transition-colors ${
              won
                ? "border-[color:var(--color-settle)]/40 bg-[color:var(--color-settle)]/[0.04]"
                : vendor.status === "failed" || vendor.status === "walked"
                  ? "border-line bg-white opacity-70"
                  : "border-line bg-white"
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="truncate font-display text-[15px] font-semibold text-ink">
                  {vendor.name}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLE[vendor.status]}`}
                >
                  {STATUS_LABEL[vendor.status]}
                </span>
                {vendor.violations > 0 && (
                  <span
                    className="shrink-0 rounded-full bg-[color:var(--color-walk)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-walk)]"
                    title="Offers rejected automatically for pricing below this vendor's own margin floor"
                  >
                    {vendor.violations} blocked
                  </span>
                )}
              </div>
              <div className="shrink-0 text-right tabular-nums">
                {/* Sticker price for the identical basket, struck through, so
                    the negotiated number has something to be measured against.
                    Only once the deal is done — mid-negotiation this would be
                    comparing against a cart still being changed. */}
                {saved !== null && (
                  <div className="text-[11px] leading-tight text-muted">
                    <s className="decoration-[color:var(--color-walk)]/60">
                      {rupees(Math.round(vendor.listSubtotal as number))}
                    </s>{" "}
                    list
                  </div>
                )}
                <AnimatePresence mode="popLayout">
                  <motion.div
                    key={price ?? "pending"}
                    initial={reduceMotion ? false : { y: -8, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={reduceMotion ? undefined : { y: 8, opacity: 0 }}
                    transition={{ duration: 0.24 }}
                    className="font-display text-lg font-bold text-ink"
                  >
                    {price !== null ? rupees(price) : "—"}
                  </motion.div>
                </AnimatePresence>
                <div className="text-[11px] leading-tight text-muted">
                  {saved !== null ? (
                    <span className="font-medium text-[color:var(--color-settle)]">
                      {rupees(Math.round(saved))} off &middot; {savedPct}%
                    </span>
                  ) : vendor.margin !== null ? (
                    `${vendor.margin}% margin`
                  ) : (
                    " "
                  )}
                </div>
              </div>
            </div>

            {won && vendor.score !== null && (
              <p className="mt-2 rounded-lg bg-[color:var(--color-settle)]/[0.08] px-2.5 py-1.5 text-[11.5px] leading-snug text-slate-ink">
                <span className="font-semibold text-ink">Why this won:</span>{" "}
                {rivals === 0
                  ? "the only vendor the buyer reached agreement with."
                  : `best combined score (${vendor.score}) across price, delivery and payment terms, weighted by your stated priorities.`}{" "}
                {hasDeclined
                  ? "Rows marked “never agreed” were bids the buyer declined, not deals you could have taken."
                  : "You can still take any of the others below."}
              </p>
            )}

            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface">
              <motion.div
                className={`h-full rounded-full ${won ? "bg-[color:var(--color-settle)]" : "bg-rzp-500"}`}
                initial={{ width: 0 }}
                animate={{ width: `${width}%` }}
                transition={{ type: "spring", stiffness: 120, damping: 24 }}
              />
            </div>

            <div className="mt-2 flex items-end justify-between gap-4">
              <div className="min-w-0 flex-1 text-[11px] leading-snug text-muted">
                {vendor.status === "thinking" ? (
                  <span className="inline-flex items-center gap-1.5">
                    <motion.span
                      className="inline-block h-1.5 w-1.5 rounded-full bg-rzp-500"
                      animate={reduceMotion ? {} : { opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 1.1, repeat: Infinity }}
                    />
                    Pricing round {vendor.round}…
                  </span>
                ) : (
                  <span className="line-clamp-2">{vendor.reasoning ?? " "}</span>
                )}
                {vendor.upsell && (
                  <span className="ml-1 font-medium text-[color:var(--color-counter)]">
                    +{vendor.upsell}
                  </span>
                )}
              </div>
              <div className="w-20 shrink-0">
                <Spark history={vendor.history} won={won} />
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
