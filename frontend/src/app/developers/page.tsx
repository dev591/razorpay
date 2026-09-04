import ArchitectureDiagram from "@/components/dev/ArchitectureDiagram";
import EconomicsCharts from "@/components/dev/EconomicsCharts";
import LifecycleDiagram from "@/components/dev/LifecycleDiagram";
import ScalabilityTable from "@/components/dev/ScalabilityTable";

export const metadata = {
  title: "Engineering notes",
  description:
    "How the agents work, why each constraint exists, what breaks at scale, and what a negotiation actually costs to run.",
};

function Section({
  eyebrow,
  title,
  lede,
  children,
  id,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line/70 py-14">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rzp-600">
        {eyebrow}
      </p>
      <h2 className="mt-3 max-w-2xl font-display text-2xl font-extrabold leading-tight tracking-tight text-ink sm:text-3xl">
        {title}
      </h2>
      {lede && (
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-ink">{lede}</p>
      )}
      <div className="mt-8">{children}</div>
    </section>
  );
}

/** A claim paired with the reason it exists. Prose hides the reasoning; this doesn't. */
function Rationale({ items }: { items: { what: string; why: string }[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.what} className="rounded-2xl border border-line bg-white p-4">
          <p className="text-[13.5px] font-semibold text-ink">{item.what}</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-ink">{item.why}</p>
        </div>
      ))}
    </div>
  );
}

export default function DevelopersPage() {
  return (
    <main className="flex-1 bg-white">
      <div className="mx-auto max-w-5xl px-6 py-14">
        <header>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rzp-600">
            Engineering notes
          </p>
          <h1 className="mt-3 max-w-3xl font-display text-4xl font-extrabold leading-[1.08] tracking-tight text-ink sm:text-5xl">
            How it works, why it is built this way, and what it costs to run.
          </h1>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-slate-ink">
            The demo shows agents agreeing on an order. This page is the part a
            reviewer actually has to interrogate: where the trust boundary sits,
            what happens when the model is wrong, what breaks at a million
            merchants, and what a negotiation costs in inference.
          </p>
          <p className="mt-4 max-w-2xl rounded-2xl border border-line bg-mist/60 p-4 text-[13px] leading-relaxed text-slate-ink">
            <strong className="font-semibold text-ink">A note on the numbers.</strong>{" "}
            Everything quantified here is measured on this instance, not
            estimated. Token counts come from each OpenAI response&apos;s{" "}
            <code className="font-mono text-[12px]">usage</code> block; GMV and
            margin come from the session corpus on disk. Where a figure is a
            projection rather than a measurement, it says so.
          </p>
        </header>

        <Section
          id="lifecycle"
          eyebrow="Workflow"
          title="One order, end to end"
          lede="A human signs an intent before anything can spend. The field is then cut to the k vendors that could actually be cheapest, those negotiate concurrently against one shared ledger, and a deterministic guard sits between every model output and the money."
        >
          <LifecycleDiagram />
          <div className="mt-8">
            <Rationale
              items={[
                {
                  what: "The approval gate blocks, and it is signed",
                  why: "An agent that mints its own mandate and starts spending is the exact failure AP2's human-signed intent exists to prevent. Creation and execution are two API calls; nothing reaches a model, a vendor or Razorpay between them. The approval itself is HMAC-signed over the spend ceiling, so it cannot be replayed against a larger intent.",
                },
                {
                  what: "Vendors negotiate concurrently, not in turn",
                  why: "Sequential rounds would make latency scale with vendor count. The broadcast fans out on a thread pool, and every thread appends to one shared AuditLedger instance — a second instance would read a stale in-memory tail and corrupt the chain, so the lock lives inside the ledger.",
                },
                {
                  what: "The upsell engine is rules, not an LLM",
                  why: "It only fires when the base cart already clears a margin headroom threshold and the addition still fits the budget. That makes it reproducible and explainable — an upsell you cannot explain to a merchant is one they will turn off.",
                },
                {
                  what: "You settle any offer, not just the winner",
                  why: "The scorer ranks; it does not decide. A buyer may reasonably prefer the runner-up for a supplier relationship the model cannot see. Every converged cart stays settleable through the identical hash-lock path, and choosing against the recommendation is recorded in the trail.",
                },
              ]}
            />
          </div>
        </Section>

        <Section
          id="agents"
          eyebrow="The agents"
          title="The model proposes. The protocol disposes."
          lede="Both agents are gpt-4o-mini with structured output. Neither is trusted with a decision that moves money — every bound they could breach is re-checked in deterministic code afterwards."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            {[
              {
                name: "Buyer agent",
                decides: ["accept / counter / walk", "which lever to push next"],
                cannot: [
                  "Exceed the signed spend ceiling — checked before the prompt is even built",
                  "Accept a lead time past the delivery deadline",
                  "Continue past the round cap",
                ],
              },
              {
                name: "Merchant agent",
                decides: ["basket composition", "price, lead time, payment terms"],
                cannot: [
                  "Price below its own margin floor — clamped per line, then re-verified on the whole cart",
                  "Quote credit beyond the 45-day MSMED ceiling",
                  "Quote a lead time it was not asked for",
                ],
              },
            ].map((agent) => (
              <div key={agent.name} className="rounded-2xl border border-line bg-white p-5">
                <h3 className="font-display text-[16px] font-bold text-ink">{agent.name}</h3>
                <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
                  Decides
                </p>
                <ul className="mt-1.5 space-y-1">
                  {agent.decides.map((d) => (
                    <li key={d} className="text-[12.5px] text-slate-ink">
                      {d}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-[10.5px] font-semibold uppercase tracking-wider text-[color:var(--color-walk)]">
                  Cannot, by construction
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {agent.cannot.map((c) => (
                    <li key={c} className="text-[12.5px] leading-snug text-slate-ink">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-[color:var(--color-walk)]/30 bg-[color:var(--color-walk)]/[0.04] p-5">
            <h3 className="font-display text-[15px] font-bold text-ink">
              Why that distrust is not theoretical
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-ink">
              Three defects found by instrumenting the guard rather than by
              reading the code — each invisible as an error, each visible only
              as &ldquo;the agents did not converge&rdquo;:
            </p>
            <ol className="mt-3 space-y-2.5">
              {[
                ["Two definitions of margin", "Pricing clamped to markup-on-cost while reporting measured margin-on-revenue. A 12% floor clamped a ₹100 item to ₹112, which measures 10.71% — under its own floor on every item, every round. 14 spurious violations per session; 1 of 3 vendors ever converging."],
                ["A discount applied to the floor", "The lead-time slack concession was subtracted from the minimum price rather than the quoted price, pushing the floor below itself. A buyer wanting long credit and a relaxed deadline could not get a deal at all: 16 violations, zero offers."],
                ["An unsigned total", "Carts were signed at construction, then the upsell line was attached afterwards — so the merchant signature covered a total that no longer matched the cart going to payment."],
              ].map(([title, body]) => (
                <li key={title} className="text-[12.5px] leading-relaxed text-slate-ink">
                  <strong className="font-semibold text-ink">{title}.</strong> {body}
                </li>
              ))}
            </ol>
            <p className="mt-3 text-[12.5px] leading-relaxed text-slate-ink">
              After the fixes: <strong className="font-semibold text-ink">0 violations, 3 of 3 vendors converging.</strong>{" "}
              The lesson is the architecture — a prompt that asks a model to
              respect a limit is not a limit.
            </p>
          </div>
        </Section>

        <Section
          id="architecture"
          eyebrow="System design"
          title="The LLM is the least trusted box"
          lede="Layered so that everything deciding whether money moves sits below the models, in code that is deterministic, testable and cheap."
        >
          <ArchitectureDiagram />
        </Section>

        <Section
          id="scale"
          eyebrow="Scalability"
          title="What this costs as N grows"
          lede="Every 'before' below was real code in this repository. The rewrite was not premature optimisation — two of these were already the bottleneck at 700 sessions on a laptop."
        >
          <ScalabilityTable />

          <h3 className="mt-10 font-display text-[17px] font-bold text-ink">
            What would break first at Razorpay&apos;s scale
          </h3>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-slate-ink">
            Being specific about the limits is more useful than claiming there
            are none. In rough order of when they bite:
          </p>
          <div className="mt-5 space-y-3">
            {[
              {
                limit: "Single-writer SQLite",
                bites: "Second instance",
                fix: "Sessions and vendors persist to one embedded SQLite file, chosen so a clean clone runs with no external service. SQLite handles one writer; a second process needs Postgres. The swap is one module — SessionStore already hides storage behind get/put/rehydrate, and the LRU, indices and leaderboard above it do not change. EventBus becomes Redis Streams or Kafka on the same reasoning.",
              },
              {
                limit: "Ledger on the local filesystem",
                bites: "First horizontal scale-out",
                fix: "The hash chain is the durability guarantee, not the file. Append-only object storage or a ledger database keeps the chain semantics; verification already recomputes every hash from scratch, so integrity is portable.",
              },
              {
                limit: "Fan-out width",
                bites: "~50+ vendors per intent",
                fix: "One thread and one LLM call per vendor per round does not survive a thousand merchants. Pre-filter candidates by the catalog index and margin feasibility, then negotiate with a shortlist — the index already answers 'who can plausibly fill this' in sub-millisecond time.",
              },
              {
                limit: "Latency of a full negotiation",
                bites: "Interactive checkout",
                fix: "10–20s is fine for procurement, wrong for a consumer flow. Cache opening quotes per (SKU, quantity band, terms), and reserve live negotiation for the rounds that actually move.",
              },
              {
                limit: "Per-merchant signing identity",
                bites: "Production, immediately",
                fix: "Every agent secret is derived from one master secret. Real deployment issues a key per merchant at onboarding and rotates it — the derivation function is the only thing that changes.",
              },
            ].map((row) => (
              <div key={row.limit} className="rounded-2xl border border-line bg-white p-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h4 className="font-display text-[14px] font-bold text-ink">{row.limit}</h4>
                  <span className="rounded-full bg-[color:var(--color-counter)]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-counter)]">
                    bites at: {row.bites}
                  </span>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-ink">{row.fix}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="economics"
          eyebrow="Unit economics"
          title="What a negotiation actually costs"
          lede="Measured from each completion's usage block on this instance — not an estimate, and not a number from a pricing page multiplied by a guess."
        >
          <EconomicsCharts />

          <div className="mt-8 rounded-2xl border border-line bg-mist/60 p-5">
            <h3 className="font-display text-[15px] font-bold text-ink">
              Where this stops being cheap
            </h3>
            <ul className="mt-2.5 space-y-2">
              {[
                "Rounds are the cost driver, not vendors. Each round re-sends the catalog and the history, so spend is roughly quadratic in rounds and linear in vendors. The round cap is a cost control as much as a safety one.",
                "Prompt caching is the biggest single lever untaken. This workload is almost entirely repeated prefix, billed at half rate when cached — the catalog and system framing are identical across rounds.",
                "A smaller model would work for the buyer agent. It picks one of three actions against numbers already computed in code; the merchant agent, which composes baskets, is where capability actually earns its cost.",
                "Failure is nearly free. A vendor that drops out mid-negotiation stops costing money immediately, and the round cap bounds the worst case — there is no runaway spend path.",
              ].map((line) => (
                <li key={line} className="text-[12.5px] leading-relaxed text-slate-ink">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <Section
          id="honesty"
          eyebrow="Scope"
          title="What this is not"
          lede="A prototype that overstates itself is worse than one that draws its own boundary."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              ["Razorpay Route attribution is simulated", "Linked account IDs are display and audit data. No real Route call, no actual fund splitting."],
              ["No authentication anywhere", "Vendor registration and every endpoint are open. Demo-scoped by design, not an oversight to discover later."],
              ["The audit ledger stays a file", "Append-only JSONL, deliberately. A hash chain is exactly the shape of an append-only file; a database adds a dependency and buys no integrity the chain does not already give."],
              ["Single-node by construction", "One SQLite file, one process. Correct for a repo-link submission that must run from a clean clone; not a multi-region deployment."],
              ["Test mode only", "Real Razorpay orders and real signature verification, but no real money moves at any point."],
            ].map(([title, body]) => (
              <div key={title} className="rounded-2xl border border-line bg-white p-4">
                <p className="text-[13px] font-semibold text-ink">{title}</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{body}</p>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </main>
  );
}
