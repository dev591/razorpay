/**
 * The rules the system falls back to when the model is unreachable.
 *
 * Worth spelling out rather than summarising as "there is a fallback": the
 * interesting claim is not that one exists, it is that it produces a real
 * signed offer that still respects the floor — and that the numbers driving it
 * are the same ones the prompt was given, not a canned response.
 */

const TRIGGERS = [
  "Three retries with jittered backoff, exhausted",
  "No OPENAI_API_KEY configured in the process",
  "The chaos switch, which raises the SDK's own connection error",
];

const SELLER_RULES = [
  {
    k: "Opens 12 points above its floor",
    v: "OPENING_MARGIN_HEADROOM_PCT — the first quote is not the last one, the same way a sales desk opens.",
  },
  {
    k: "Concedes ~45% of the remaining gap each round",
    v: "CONCESSION_DECAY = 0.55, geometric rather than linear. A linear walk conceded the same amount every round, so every offline deal ran the full six and landed exactly on the floor — which then tripped the seller gate every single time.",
  },
  {
    k: "Stops short of the hard floor, on purpose",
    v: "It concedes toward margin floor + the 3pp near-floor buffer + 1pp clearance. An unattended quote should not park its own seller in the manual-review queue; conceding to the true floor is a decision for a human at the desk.",
  },
];

const BUYER_RULES = [
  ["Over budget, or past the deadline", "counter — walk on the final round"],
  ["Headroom below 10%", "accept"],
  ["Round 3+ and improvement under 3%", "accept — concessions have flattened"],
  ["Headroom under 30% with an 8%+ concession", "accept"],
  ["Final round and inside every limit", "accept rather than walk"],
  ["Otherwise", "counter for a better price"],
];

const NEVER = [
  "Price below the vendor's margin floor. An offer that breaches the seller's own limit is worse than no offer.",
  "Drop a requested basket line, or trim below a quantity the buyer named.",
  "Present itself as a model quote. Every cart carries degraded: true in the UI and the ledger, with a stated reason — and healthy carts carry degraded: false explicitly, so 'not degraded' is an assertion rather than an absence.",
];

export default function DegradedRules() {
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-line bg-white p-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          What puts it there
        </p>
        <ul className="mt-2.5 space-y-1.5">
          {TRIGGERS.map((t) => (
            <li key={t} className="text-[13.5px] leading-relaxed text-slate-ink">
              {t}
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-line/70 pt-3 text-[13px] leading-relaxed text-slate-ink">
          The switch breaks the <strong className="font-semibold text-ink">upstream</strong>,
          not the outcome: the retry budget, the backoff, the rule-based quoting and the
          labelling all execute exactly as they would in a real outage. One that jumped
          straight to the fallback would demonstrate nothing.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-white p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Seller — how it prices
          </p>
          <dl className="mt-3 space-y-3">
            {SELLER_RULES.map((r) => (
              <div key={r.k}>
                <dt className="text-[13.5px] font-semibold text-ink">{r.k}</dt>
                <dd className="mt-1 text-[12.5px] leading-relaxed text-slate-ink">{r.v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="rounded-2xl border border-line bg-white p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Buyer — when it accepts
          </p>
          <ul className="mt-3 space-y-2">
            {BUYER_RULES.map(([cond, act]) => (
              <li key={cond} className="text-[12.5px] leading-relaxed">
                <span className="text-slate-ink">{cond}</span>
                <span className="mx-1.5 text-muted">→</span>
                <span className="font-medium text-ink">{act}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-line/70 pt-3 text-[12.5px] leading-relaxed text-slate-ink">
            These are the same thresholds the prompt states. The model was being asked to
            apply them to numbers already computed in code, so running them directly loses
            very little and keeps the negotiation alive.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-[color:var(--color-walk)]/30 bg-[color:var(--color-walk)]/[0.04] p-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-walk)]">
          What it will never do
        </p>
        <ul className="mt-2.5 space-y-2">
          {NEVER.map((n) => (
            <li key={n} className="text-[13px] leading-relaxed text-slate-ink">
              {n}
            </li>
          ))}
        </ul>
      </div>

      <p className="rounded-2xl border border-rzp-200 bg-rzp-50 p-4 text-[13.5px] leading-relaxed text-slate-ink">
        <strong className="font-semibold text-ink">Measured, with the model fully dead:</strong>{" "}
        every shortlisted vendor degraded at round one, a winner was still selected, a real
        Razorpay order was created, and the margin landed at 14.99% against the winning
        vendor&apos;s 9% floor. The chain stayed valid and every cart was flagged.
      </p>
    </div>
  );
}
