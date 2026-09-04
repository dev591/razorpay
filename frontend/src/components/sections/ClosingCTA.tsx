"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import FadeIn from "@/components/ui/FadeIn";
import { getEconomics } from "@/lib/api";

const DOORS = [
  {
    href: "/try",
    title: "Try it",
    body: "Compose an intent, approve it, and watch every merchant agent bid in real time.",
  },
  {
    href: "/vendors",
    title: "Vendors",
    body: "Add a merchant with your own catalog and margin floor. It bids in the next run.",
  },
  {
    href: "/developers",
    title: "Engineering",
    body: "Lifecycle, architecture, complexity classes and the measured unit economics.",
  },
];

export default function ClosingCTA() {
  // Read live rather than hardcoded. The figure moves the moment someone adds
  // a vendor — more merchants means more rounds — and a stale number printed
  // next to "measured, not estimated" is worse than no number at all.
  const [economics, setEconomics] = useState<[string, string][] | null>(null);
  // Distinguishes "nothing metered yet" from "still loading" — the counters
  // live in memory, so a restart or a clean clone genuinely has no data, and
  // an empty gap under a headline about cost reads as broken rather than new.
  const [metered, setMetered] = useState<boolean | null>(null);

  useEffect(() => {
    getEconomics()
      .then((e) => {
        const per = e.per_negotiation;
        setMetered(per.sessions_metered > 0);
        if (!per.sessions_metered) return;
        setEconomics([
          [`₹${per.avg_inr.toFixed(2)}`, "model cost per negotiation"],
          [per.avg_llm_calls.toFixed(0), "model calls"],
          [Math.round(per.avg_tokens).toLocaleString("en-IN"), "tokens"],
        ]);
      })
      .catch(() => setMetered(false));
  }, []);

  return (
    <section className="border-t border-line/70 bg-white px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <FadeIn className="overflow-hidden rounded-[32px] bg-navy-900 px-8 py-14 text-center sm:px-14">
          <h2 className="font-display mx-auto max-w-2xl text-3xl leading-[1.1] font-semibold tracking-tight text-white sm:text-[2.5rem]">
            The cheapest part of an autonomous purchase is the thinking.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-white/70">
            A full multi-vendor negotiation costs about a rupee in model calls.
            What it costs to get wrong is everything else — which is why the
            limits are code and the record is append-only.
          </p>

          {metered === false && (
            <p className="mt-9 text-[13px] text-white/55">
              This instance hasn&apos;t metered a negotiation yet — the counters
              are measured live, never seeded. Run one and the real figure
              appears here.
            </p>
          )}

          <dl className="flex flex-wrap items-center justify-center gap-x-12 gap-y-6 empty:hidden [&:not(:empty)]:mt-9">
            {(economics ?? []).map(([value, label]) => (
              <div key={label}>
                <dt className="sr-only">{label}</dt>
                <dd>
                  <span className="font-display text-3xl font-semibold tabular-nums text-white">
                    {value}
                  </span>
                  <p className="mt-1 text-[12.5px] text-white/60">{label}</p>
                </dd>
              </div>
            ))}
          </dl>

          <Link
            href="/try"
            className="mt-10 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3.5 text-sm font-semibold text-navy-900 transition-all hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            Watch it happen
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
        </FadeIn>

        <div className="mt-6 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-3">
          {DOORS.map((door, i) => (
            <FadeIn key={door.href} delay={i * 0.06} className="bg-white">
              <Link
                href={door.href}
                className="group block h-full p-7 transition-colors hover:bg-rzp-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rzp-500"
              >
                <h3 className="font-display flex items-center gap-1.5 text-[17px] font-semibold tracking-tight text-ink">
                  {door.title}
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="text-rzp-500 transition-transform group-hover:translate-x-0.5"
                  >
                    <path
                      d="m9 6 6 6-6 6"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </h3>
                <p className="mt-2 text-[14px] leading-relaxed text-slate-ink">{door.body}</p>
              </Link>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
