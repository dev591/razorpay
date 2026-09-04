import FadeIn, { SectionHead } from "@/components/ui/FadeIn";
import LiveNumbers from "@/components/sections/LiveNumbers";

/**
 * The four claims a sceptic would push on, each answered with where the
 * enforcement actually lives. Every one of these is checkable in the running
 * system — none of them is a property of the prompt.
 */
const GUARANTEES = [
  {
    title: "A model can't talk past the floor",
    body: "The margin floor is arithmetic in protocol/pricing.py, not an instruction in a prompt. It's measured on goods revenue netted for the credit period — never on the freight-inclusive invoice total. Any offer below it is rejected before it reaches the buyer.",
    tag: "Deterministic guard",
  },
  {
    title: "Nothing spends without you",
    body: "POST /intents signs the intent and halts. Negotiation only begins once a human approval is recorded against it. There is no code path that reaches a payment from an unapproved intent.",
    tag: "Human gate",
  },
  {
    title: "The agreed cart can't drift",
    body: "The cart is signed after everything is attached — including the upsell — so the signature covers the total you actually saw. Tamper with any field and verification fails. The console has a button that does exactly that.",
    tag: "Hash lock",
  },
  {
    title: "The model going down isn't a failure",
    body: "Requests retry with jittered backoff, then fall back to rule-based quoting and buyer decisions. With OpenAI fully unreachable the demo still completes end to end — and every degraded cart is labelled, in the UI and in the audit trail.",
    tag: "Degraded, not broken",
  },
];

export default function Guarantees() {
  return (
    <section
      id="guarantees"
      className="scroll-mt-24 border-t border-line/70 bg-surface px-6 py-24"
    >
      <div className="mx-auto max-w-6xl">
        <SectionHead
          eyebrow="The guarantees"
          title="Four things that hold whether or not the model cooperates"
          lede="Autonomy is easy to demo and hard to trust. These are the constraints that survive an adversarial model, an unreachable provider, and a tampered payload."
        />

        <div className="mt-14 grid gap-5 lg:grid-cols-2">
          {GUARANTEES.map((g, i) => (
            <FadeIn
              key={g.title}
              delay={i * 0.06}
              className="rounded-3xl border border-line bg-white p-7"
            >
              <span className="inline-flex items-center gap-1.5 rounded-full bg-rzp-50 px-2.5 py-1 text-[10.5px] font-semibold tracking-[0.1em] text-rzp-600 uppercase">
                {g.tag}
              </span>
              <h3 className="font-display mt-4 text-[19px] font-semibold tracking-tight text-ink">
                {g.title}
              </h3>
              <p className="mt-2.5 text-[14px] leading-relaxed text-slate-ink">{g.body}</p>
            </FadeIn>
          ))}
        </div>

        <FadeIn delay={0.1}>
          <LiveNumbers />
        </FadeIn>
      </div>
    </section>
  );
}
