"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { describeTerms, type IntentMandate } from "@/lib/api";
import { rupees } from "@/lib/format";

/**
 * The human approval gate.
 *
 * This is the load-bearing moment of the whole demo: the mandate is signed
 * and sitting there, and *nothing has happened yet* — no LLM call, no vendor
 * contacted, no Razorpay order. Presenting it as a document to countersign
 * rather than a "Run" button is the point.
 */
export default function ApprovalGate({
  intent,
  onApprove,
  onReject,
  busy,
}: {
  intent: IntentMandate;
  onApprove: (approvedBy: string) => void;
  onReject: () => void;
  busy: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [approver, setApprover] = useState("ops@merchant.in");

  // Every bound the signature actually covers. Payment terms and the delivery
  // window are part of the signed mandate, so showing only budget and
  // quantity would ask someone to countersign terms they were never shown.
  const rows: [string, string][] = [
    ["Goal", intent.goal],
    ["Spend ceiling", rupees(intent.max_spend)],
    ["Quantity", `${intent.qty_min}–${intent.qty_max} units`],
    ["Deliver within", `${intent.ship_within_days} days`],
    ["Payment terms", describeTerms(intent.preferred_payment_terms)],
    ["Mandate id", intent.id],
  ];

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 14, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden rounded-3xl border border-[color:var(--color-lock)]/25 bg-white shadow-[0_1px_2px_rgba(19,38,68,0.04),0_12px_40px_-12px_rgba(122,90,248,0.25)]"
    >
      <div className="flex items-center gap-2.5 border-b border-line/70 bg-[color:var(--color-lock)]/[0.05] px-5 py-3">
        <motion.span
          className="inline-block h-2 w-2 rounded-full bg-[color:var(--color-lock)]"
          animate={reduceMotion ? {} : { scale: [1, 1.35, 1], opacity: [1, 0.55, 1] }}
          transition={{ duration: 1.8, repeat: Infinity }}
        />
        <span className="font-display text-[13px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-lock)]">
          Approval required
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted">intent_mandate</span>
      </div>

      <div className="px-5 py-4">
        <p className="text-[13px] leading-relaxed text-slate-ink">
          The buyer agent has drafted and signed an intent mandate. It has not
          contacted a vendor, called a model, or created an order. Nothing
          spends until this is countersigned.
        </p>

        <dl className="mt-4 divide-y divide-line/70 rounded-2xl border border-line/70 bg-mist/60">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                {label}
              </dt>
              <dd
                className={`text-right text-[13px] font-medium text-ink ${
                  label === "Mandate id" ? "font-mono text-[11px] text-muted" : ""
                }`}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <label className="sr-only" htmlFor="approver">
            Approver
          </label>
          <input
            id="approver"
            value={approver}
            onChange={(e) => setApprover(e.target.value)}
            className="min-w-0 flex-1 rounded-full border border-line bg-white px-4 py-2.5 text-[13px] text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100"
            placeholder="who is approving this spend"
          />
          <div className="flex gap-2">
            <button
              onClick={() => onReject()}
              disabled={busy}
              className="rounded-full border border-line px-4 py-2.5 text-[13px] font-semibold text-slate-ink transition hover:border-[color:var(--color-walk)]/50 hover:text-[color:var(--color-walk)] disabled:opacity-40"
            >
              Decline
            </button>
            <motion.button
              whileHover={reduceMotion ? {} : { scale: 1.02 }}
              whileTap={reduceMotion ? {} : { scale: 0.98 }}
              onClick={() => onApprove(approver.trim() || "human")}
              disabled={busy}
              className="rounded-full bg-rzp-500 px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_6px_20px_-6px_rgba(48,94,255,0.6)] transition hover:bg-rzp-600 disabled:opacity-50"
            >
              Approve &amp; sign
            </motion.button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
