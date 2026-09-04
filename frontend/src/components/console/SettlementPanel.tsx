"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import Link from "next/link";
import { checkoutUrl, confirmSeller, getAudit, tamperSession, type TamperResult } from "@/lib/api";
import { rupees } from "@/lib/format";

/**
 * Settlement, plus the deliberate failure.
 *
 * "One failure handled gracefully" is a judging requirement, so it can't be
 * something that merely would happen — it has to be triggerable on stage.
 * The tamper button mutates an already-locked cart and pushes it back
 * through verification; the hash mismatch is real, and so is the rejection.
 */
export default function SettlementPanel({
  sessionId,
  amount,
  cartHash,
  orderId,
  gated,
  providerError,
  onConfirmed,
}: {
  sessionId: string;
  amount: number | null;
  cartHash: string | null;
  orderId: string | null;
  gated: boolean;
  providerError: boolean;
  onConfirmed: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [tamper, setTamper] = useState<TamperResult | null>(null);
  const [chainValid, setChainValid] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const runTamper = async () => {
    setBusy("tamper");
    try {
      const result = await tamperSession(sessionId);
      setTamper(result);
      // Re-verify the chain right after: the rejection is itself appended to
      // the ledger, so the trail stays intact *and* now records the attempt.
      setChainValid((await getAudit(sessionId)).chain_valid);
    } catch {
      setTamper(null);
    } finally {
      setBusy(null);
    }
  };

  const runConfirm = async () => {
    setBusy("confirm");
    try {
      await confirmSeller(sessionId);
      onConfirmed();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {gated && (
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-[color:var(--color-lock)]/30 bg-[color:var(--color-lock)]/[0.04] p-4"
        >
          <p className="text-[13px] leading-relaxed text-slate-ink">
            <strong className="font-semibold text-ink">
              Waiting on the seller.
            </strong>{" "}
            Every deal stops here. The agent negotiated against a catalog, and a
            catalog is a claim about stock rather than a fact — so the merchant
            confirms they can actually ship before you are asked to pay.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <button
              onClick={runConfirm}
              disabled={busy !== null}
              className="rounded-full bg-[color:var(--color-lock)] px-4 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {busy === "confirm" ? "Confirming…" : "Confirm as seller"}
            </button>
            <Link
              href="/merchant"
              className="text-[12.5px] font-medium text-rzp-600 transition hover:text-rzp-500"
            >
              or accept it from the merchant view →
            </Link>
          </div>
        </motion.div>
      )}

      {cartHash && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Hash-locked cart
            </span>
            {amount !== null && (
              <span className="font-display text-lg font-bold text-ink tabular-nums">
                {rupees(amount)}
              </span>
            )}
          </div>
          <p className="mt-1.5 break-all font-mono text-[10.5px] leading-relaxed text-muted">
            {cartHash}
          </p>
          {providerError && (
            <div className="mt-2.5 rounded-xl border border-[color:var(--color-counter)]/35 bg-[color:var(--color-counter)]/[0.07] p-3">
              <p className="text-[12.5px] font-semibold text-ink">
                Razorpay was unreachable — handled, not lost.
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-slate-ink">
                Order creation timed out at the payment provider. The cart above
                is still hash-locked and dual-signed, so nothing about the
                agreement is in doubt and the failure is recorded in the ledger.
                Retrying settles the same mandate — it does not renegotiate.
              </p>
            </div>
          )}

          {orderId && (
            <p className="mt-2 text-[12px] text-slate-ink">
              Razorpay test order{" "}
              <span className="font-mono text-[11px] text-ink">{orderId}</span> created.
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {orderId && (
              <a
                href={checkoutUrl(sessionId)}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-rzp-500 px-4 py-2 text-[12.5px] font-semibold text-white transition hover:bg-rzp-600"
              >
                Pay in test mode
              </a>
            )}
            <button
              onClick={runTamper}
              disabled={busy !== null}
              className="rounded-full border border-[color:var(--color-walk)]/40 px-4 py-2 text-[12.5px] font-semibold text-[color:var(--color-walk)] transition hover:bg-[color:var(--color-walk)]/5 disabled:opacity-50"
            >
              {busy === "tamper" ? "Tampering…" : "Tamper with the cart"}
            </button>
          </div>

          <AnimatePresence>
            {tamper && (
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-3 overflow-hidden"
              >
                <div
                  className={`rounded-xl border p-3 ${
                    tamper.rejected
                      ? "border-[color:var(--color-settle)]/30 bg-[color:var(--color-settle)]/[0.06]"
                      : "border-[color:var(--color-walk)]/40 bg-[color:var(--color-walk)]/[0.06]"
                  }`}
                >
                  <p className="text-[12.5px] font-semibold text-ink">
                    {tamper.rejected
                      ? "Rejected — cart hash mismatch."
                      : "Accepted. This should never happen."}
                  </p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                    A line item&apos;s price was raised 30% after the mandate was
                    locked. The recomputed hash no longer matches the signed
                    one, so payment cannot proceed — and the attempt itself is
                    now the newest entry in the ledger.
                  </p>
                  <div className="mt-2 space-y-0.5 font-mono text-[10px] text-muted">
                    <p className="break-all">signed &nbsp;{tamper.expected_hash.slice(0, 48)}…</p>
                    <p className="break-all text-[color:var(--color-walk)]">
                      tampered {tamper.tampered_hash.slice(0, 48)}…
                    </p>
                  </div>
                  {chainValid !== null && (
                    <p className="mt-2 text-[11.5px] font-medium text-[color:var(--color-settle)]">
                      Audit chain still verifies: {String(chainValid)}
                    </p>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
