/**
 * The whole system as one vertical pipeline, meant to be talked over.
 *
 * The lifecycle diagram below shows the *order* moving; this shows the
 * *machinery* it moves through — which stage costs model calls, which stage
 * blocks on a human, and which data structure does the work. Those three
 * questions are what a reviewer asks, and answering them in one picture is
 * faster than three paragraphs.
 */

type Stage = {
  n: string;
  title: string;
  detail: string;
  mechanism: string;
  cost: string;
  kind: "plain" | "gate" | "ai" | "settle";
};

const STAGES: Stage[] = [
  {
    n: "01",
    title: "Intent composed",
    detail:
      "Budget, quantity band, deadline, terms and the named basket. Validated and checked for feasibility — a basket the cheapest vendor cannot reach at its own floor is rejected here with the arithmetic.",
    mechanism: "protocol/mandates.py",
    cost: "0 model calls",
    kind: "plain",
  },
  {
    n: "02",
    title: "Intent signed, then everything stops",
    detail:
      "HMAC over budget, quantities, deadline, credit ceiling and the basket. Nothing reaches a model, a vendor or Razorpay until a human approves.",
    mechanism: "GATE 1 — blocking",
    cost: "human",
    kind: "gate",
  },
  {
    n: "03",
    title: "Field cut before anyone talks",
    detail:
      "Vendors ranked by the cheapest total they could quote without breaching their own margin floor — a bound no negotiation moves. Excluded vendors provably could not have won, and that check is written to the ledger.",
    mechanism: "shortlist.py · heap top-k",
    cost: "0 model calls",
    kind: "plain",
  },
  {
    n: "04",
    title: "Agents negotiate in parallel",
    detail:
      "One thread per shortlisted vendor, six rounds each, all against one shared ledger. Every round is two calls: the merchant proposes a cart, the buyer accepts, counters or walks.",
    mechanism: "ThreadPoolExecutor · JSON-schema output",
    cost: "~36 model calls · ₹0.64",
    kind: "ai",
  },
  {
    n: "05",
    title: "Bounds enforced in code",
    detail:
      "Over budget, past the deadline, or missing the requested basket — all rejected before the model is consulted. The model chooses how to push back, never whether a bound was breached.",
    mechanism: "buyer_agent.evaluate_cart",
    cost: "deterministic",
    kind: "plain",
  },
  {
    n: "06",
    title: "Offers scored, human decides",
    detail:
      "Price, delivery and terms, weighted by the buyer's own priorities. An offer below half the median is discounted so a gamed price cannot win. The scorer recommends; any vendor can be taken instead.",
    mechanism: "ranking.py · heapq.nlargest",
    cost: "O(n log k)",
    kind: "plain",
  },
  {
    n: "07",
    title: "Seller confirms stock",
    detail:
      "Every deal waits here. The agent negotiated against a catalog, and a catalog is a claim about stock rather than a fact.",
    mechanism: "GATE 2 — blocking",
    cost: "human",
    kind: "gate",
  },
  {
    n: "08",
    title: "Cart hash-locked, then settled",
    detail:
      "SHA-256 over line items, the upsell line and freight/ETA. Tamper with any field and verification fails. Then a real Razorpay test-mode order, routed to the winning vendor.",
    mechanism: "signing.py · Razorpay",
    cost: "settlement",
    kind: "settle",
  },
];

const TONE: Record<Stage["kind"], { chip: string; rail: string }> = {
  plain: { chip: "bg-mist text-muted", rail: "bg-line" },
  gate: {
    chip: "bg-[color:var(--color-lock)]/15 text-[color:var(--color-lock)]",
    rail: "bg-[color:var(--color-lock)]",
  },
  ai: { chip: "bg-rzp-100 text-rzp-600", rail: "bg-rzp-500" },
  settle: {
    chip: "bg-[color:var(--color-settle)]/15 text-[color:var(--color-settle)]",
    rail: "bg-[color:var(--color-settle)]",
  },
};

export default function PipelineDiagram() {
  return (
    <div>
      <ol className="relative space-y-px overflow-hidden rounded-2xl border border-line bg-line">
        {STAGES.map((s) => {
          const tone = TONE[s.kind];
          return (
            <li key={s.n} className="relative bg-white p-5 pl-6">
              {/* Colour rail: the eye can find the two blocking gates and the
                  one paid stage without reading anything. */}
              <span
                aria-hidden
                className={`absolute inset-y-0 left-0 w-[3px] ${tone.rail}`}
              />
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-[11px] font-semibold tabular-nums text-muted">
                  {s.n}
                </span>
                <h3 className="font-display text-[15.5px] font-semibold tracking-tight text-ink">
                  {s.title}
                </h3>
                <span
                  className={`ml-auto shrink-0 rounded-full px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider ${tone.chip}`}
                >
                  {s.cost}
                </span>
              </div>
              <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-slate-ink">
                {s.detail}
              </p>
              <p className="mt-2 font-mono text-[11.5px] text-muted">{s.mechanism}</p>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-[3px] rounded-full bg-[color:var(--color-lock)]" />
          blocks on a human
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-[3px] rounded-full bg-rzp-500" />
          spends model calls
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-[3px] rounded-full bg-[color:var(--color-settle)]" />
          moves money
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-[3px] rounded-full bg-line" />
          deterministic, no model
        </span>
      </div>

      <p className="mt-5 rounded-2xl border border-rzp-200 bg-rzp-50 p-4 text-[13.5px] leading-relaxed text-slate-ink">
        <strong className="font-semibold text-ink">
          Only one stage of eight spends money on inference.
        </strong>{" "}
        Two block on a human, and five are arithmetic. That ratio is the whole
        design: the model proposes, and the protocol disposes.
      </p>
    </div>
  );
}
