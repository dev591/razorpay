import Link from "next/link";
import FadeIn, { SectionHead } from "@/components/ui/FadeIn";

/**
 * The lifecycle, in the order the backend actually runs it. Each step names
 * the mechanism rather than the benefit — the benefit is what the console
 * shows, and a landing page that only asserts it is the weaker version.
 */
const STEPS = [
  {
    n: "01",
    title: "You state an intent",
    body: "Budget, quantity range, delivery window, payment terms and what you're optimising for. It's minted as a signed intent mandate — and then everything stops.",
  },
  {
    n: "02",
    title: "You approve it",
    body: "Nothing spends before a human signs off. Approval is recorded against the intent hash, and only that starts the negotiation.",
  },
  {
    n: "03",
    title: "Agents negotiate on four axes",
    body: "Price, lead time, payment terms and quantity, in parallel against every merchant. Sellers cost credit at ~18% APR; MSMED caps it at 45 days.",
  },
  {
    n: "04",
    title: "You pick the winner",
    body: "The scorer recommends, you decide. Take any vendor on the board — the override is written to the ledger alongside the recommendation it replaced.",
  },
  {
    n: "05",
    title: "The cart is hash-locked",
    body: "Line items, totals and terms are frozen under one hash. Change a rupee after the fact and the signature stops matching. There's a button to try it.",
  },
  {
    n: "06",
    title: "Razorpay settles it",
    body: "Payment is released against the locked cart in test mode. Freight is its own line, and never counted inside the margin.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-24 border-t border-line/70 bg-white px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <SectionHead
          eyebrow="How it works"
          title="Six steps, and a human gate before any of them spends"
          lede="An agent that can buy is only useful if it can also be stopped, bounded and audited. That's the whole shape of the system."
        />

        <ol className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((step, i) => (
            <FadeIn as="li" key={step.n} delay={i * 0.05} className="bg-white p-7">
              <span className="font-display text-[13px] font-semibold tabular-nums text-rzp-500">
                {step.n}
              </span>
              <h3 className="font-display mt-3 text-[17px] font-semibold tracking-tight text-ink">
                {step.title}
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-slate-ink">{step.body}</p>
            </FadeIn>
          ))}
        </ol>

        <FadeIn delay={0.1} className="mt-10 text-center">
          <Link
            href="/try"
            className="inline-flex items-center gap-2 rounded-full bg-rzp-500 px-6 py-3.5 text-sm font-semibold text-white shadow-[0_10px_28px_-10px_rgba(48,94,255,0.85)] transition-all hover:-translate-y-0.5 hover:bg-rzp-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rzp-500"
          >
            Run one yourself
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path
                d="m9 6 6 6-6 6"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <p className="mt-3 text-[12.5px] text-muted">
            About 40–70 seconds end to end, against live merchants.
          </p>
        </FadeIn>
      </div>
    </section>
  );
}
