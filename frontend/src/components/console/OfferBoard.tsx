"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { describeTerms, getOffers, selectOffer, type OfferOption } from "@/lib/api";
import { rupees } from "@/lib/format";

/**
 * Every vendor's final offer, side by side, each one settleable.
 *
 * The scorer produces a recommendation, not a verdict. A buyer can perfectly
 * reasonably take the runner-up — because they know that supplier, or want
 * the shorter lead time, or the better credit — and forcing a fresh
 * negotiation to do that would be absurd. So each converged offer keeps a
 * live "settle this one" path through the identical hash-lock and signing
 * flow, and the override is recorded in the audit trail.
 */
export default function OfferBoard({
  sessionId,
  onSelected,
}: {
  sessionId: string;
  onSelected: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [offers, setOffers] = useState<OfferOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    getOffers(sessionId)
      .then((res) => {
        setOffers(res.options);
        setSelectedId(res.selected_business_id);
      })
      .catch(() => {});
  }, [sessionId]);

  useEffect(load, [load]);

  const choose = async (businessId: string) => {
    setBusy(businessId);
    setError(null);
    try {
      await selectOffer(sessionId, businessId);
      load();
      onSelected();
    } catch (e) {
      setError((e as Error).message.replace(/^\/sessions\/\S+ failed: \d+\s*/, ""));
    } finally {
      setBusy(null);
    }
  };

  if (offers.length === 0) return null;

  return (
    <div className="rounded-3xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-[13px] font-bold uppercase tracking-[0.14em] text-muted">
          Choose your supplier
        </h2>
        <span className="text-[11.5px] text-muted">
          Ranked by your priorities — you can take any of them.
        </span>
      </div>

      <div className="mt-3 space-y-2.5">
        {/* Best first. The API returns offers in vendor order, which buried
            the recommendation at the bottom of the list. */}
        {[...offers]
          .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
          .map((offer) => {
          const chosen = offer.business_id === selectedId;
          const breakdown = offer.score_breakdown;
          const isOpen = expanded === offer.business_id;

          return (
            <motion.div
              key={offer.business_id}
              layout={!reduceMotion}
              className={`rounded-2xl border p-4 transition-colors ${
                chosen
                  ? "border-[color:var(--color-settle)]/45 bg-[color:var(--color-settle)]/[0.05]"
                  : "border-line bg-white"
              }`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-[15px] font-semibold text-ink">
                    {offer.business_name}
                  </span>
                  {offer.is_recommended && (
                    <span className="rounded-full bg-rzp-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rzp-700">
                      recommended
                    </span>
                  )}
                  {chosen && (
                    <span className="rounded-full bg-[color:var(--color-settle)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
                      selected
                    </span>
                  )}
                  {offer.low_confidence && (
                    <span
                      className="rounded-full bg-[color:var(--color-counter)]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-counter)]"
                      title="Priced far below the other offers — discounted in scoring rather than trusted outright."
                    >
                      outlier
                    </span>
                  )}
                </div>
                <div className="text-right">
                  <span className="font-display text-lg font-bold tabular-nums text-ink">
                    {offer.total_price !== null ? rupees(offer.total_price) : "—"}
                  </span>
                  {/* Goods and freight shown separately, because freight is
                      what moves when the buyer asks for a faster date — a
                      single total hides the lever they are actually pulling. */}
                  {offer.goods_subtotal !== null && offer.shipping_cost !== null && (
                    <p className="text-[10.5px] tabular-nums text-muted">
                      {rupees(offer.goods_subtotal)} goods + {rupees(offer.shipping_cost)} freight
                    </p>
                  )}
                  {/* Goods-for-goods against the vendor's own sticker price.
                      Freight is excluded on both sides: it tracks the promised
                      ETA, not the haggling. */}
                  {offer.list_subtotal !== null &&
                    offer.goods_subtotal !== null &&
                    offer.list_subtotal > offer.goods_subtotal && (
                      <p className="text-[10.5px] tabular-nums text-muted">
                        <s className="decoration-[color:var(--color-walk)]/60">
                          {rupees(offer.list_subtotal)}
                        </s>{" "}
                        list ·{" "}
                        <span className="font-medium text-[color:var(--color-settle)]">
                          {rupees(Math.round(offer.list_subtotal - offer.goods_subtotal))} off
                        </span>
                      </p>
                    )}
                </div>
              </div>

              {/* Terms are the deal, not a footnote — same basket on 45-day
                  credit is a materially different offer. */}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-slate-ink">
                <span>
                  <span className="text-muted">Delivery</span>{" "}
                  <strong className="font-semibold">{offer.lead_time_days ?? "—"} days</strong>
                  {offer.shipping_cost !== null && (
                    <span className="text-muted"> · freight {rupees(offer.shipping_cost)}</span>
                  )}
                </span>
                <span>
                  <span className="text-muted">Payment</span>{" "}
                  <strong className="font-semibold">
                    {offer.payment_terms ? describeTerms(offer.payment_terms) : "—"}
                  </strong>
                </span>
                {offer.score !== null && (
                  <button
                    onClick={() => setExpanded(isOpen ? null : offer.business_id)}
                    className="ml-auto font-mono text-[11px] text-rzp-600 underline-offset-2 hover:underline"
                  >
                    score {offer.score} {isOpen ? "▲" : "▼"}
                  </button>
                )}
              </div>

              <AnimatePresence>
                {isOpen && breakdown && (
                  <motion.div
                    initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2.5 grid gap-x-6 gap-y-1 rounded-xl bg-mist/70 p-3 text-[11.5px] sm:grid-cols-3">
                      {[
                        ["Price fit", breakdown.price_score, breakdown.weights.price],
                        ["Delivery", breakdown.delivery_score, breakdown.weights.speed],
                        ["Terms", breakdown.terms_score, breakdown.weights.terms],
                      ].map(([label, value, weight]) => (
                        <div key={String(label)} className="flex justify-between gap-2">
                          <span className="text-muted">
                            {label}{" "}
                            <span className="text-[10px]">×{Number(weight).toFixed(2)}</span>
                          </span>
                          <span className="font-mono tabular-nums text-ink">
                            {Number(value).toFixed(3)}
                          </span>
                        </div>
                      ))}
                      <p className="col-span-full mt-1 text-[11px] leading-relaxed text-muted">
                        Converged in {breakdown.rounds_used}{" "}
                        {breakdown.rounds_used === 1 ? "round" : "rounds"}.
                        {breakdown.low_confidence_discount_applied &&
                          ` Score discounted ×${breakdown.discount_multiplier} as a pricing outlier.`}
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="mt-3">
                {chosen ? (
                  <span className="text-[12px] font-medium text-[color:var(--color-settle)]">
                    This offer is locked in — settle it below.
                  </span>
                ) : offer.selectable ? (
                  <button
                    onClick={() => choose(offer.business_id)}
                    disabled={busy !== null}
                    className="rounded-full border border-rzp-400 px-4 py-1.5 text-[12.5px] font-semibold text-rzp-700 transition hover:bg-rzp-50 disabled:opacity-50"
                  >
                    {busy === offer.business_id ? "Locking…" : "Take this one instead"}
                  </button>
                ) : (
                  <span className="text-[11.5px] text-muted">
                    No longer selectable — payment already captured, or the
                    backend restarted since this offer was made.
                  </span>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 text-[12.5px] text-[color:var(--color-walk)]">{error}</p>
      )}
    </div>
  );
}
