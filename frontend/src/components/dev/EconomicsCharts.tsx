"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { getEconomics, type Economics } from "@/lib/api";

/**
 * Unit economics, from measured token usage rather than an estimate.
 *
 * Every OpenAI completion's `usage` block is recorded server-side, so these
 * are what this instance actually spent. The chart palette is the validated
 * three-slot categorical set; every mark is direct-labeled, which is also
 * what discharges the aqua slot's contrast warning.
 */

const SERIES = {
  input: "#2a78d6",
  output: "#eb6834",
  cached: "#1baf7a",
} as const;

function inr(n: number, dp = 2): string {
  return `₹${n.toFixed(dp)}`;
}

/** Horizontal bars: token mix for one negotiation. Magnitude, so bars. */
function TokenMix({ economics }: { economics: Economics }) {
  const reduceMotion = useReducedMotion();
  const t = economics.totals;
  const rows = [
    { label: "Prompt tokens", value: t.prompt_tokens, color: SERIES.input, rate: economics.rates_usd_per_million.input },
    { label: "Completion tokens", value: t.completion_tokens, color: SERIES.output, rate: economics.rates_usd_per_million.output },
    { label: "Cached prompt", value: t.cached_tokens, color: SERIES.cached, rate: economics.rates_usd_per_million.cached_input },
  ];
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Token mix — measured
      </h4>
      <div className="mt-3 space-y-3">
        {rows.map((row, i) => (
          <div key={row.label}>
            <div className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="text-slate-ink">{row.label}</span>
              <span className="tabular-nums text-ink">
                {row.value.toLocaleString("en-IN")}
                <span className="ml-1.5 text-[10.5px] text-muted">
                  ${row.rate}/M
                </span>
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface">
              <motion.div
                className="h-full rounded-full"
                style={{ background: row.color }}
                initial={reduceMotion ? false : { width: 0 }}
                whileInView={{ width: `${Math.max((row.value / max) * 100, row.value > 0 ? 3 : 0)}%` }}
                viewport={{ once: true }}
                transition={{ duration: 0.7, delay: reduceMotion ? 0 : i * 0.1, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
        Prompt tokens dominate because each round re-sends the catalog and the
        negotiation history. That is also why caching matters: OpenAI bills a
        repeated prefix at half rate, and this workload is almost entirely
        repeated prefix.
      </p>
    </div>
  );
}

/**
 * The comparison that actually matters: inference cost against the margin the
 * negotiation defends. Two quantities of wildly different scale, so this is
 * deliberately NOT a dual-axis chart — it is a ratio stated once, plus a
 * to-scale bar that shows how invisible the cost is.
 */
function CostVersusMargin({ costInr }: { costInr: number }) {
  const reduceMotion = useReducedMotion();
  // A representative settled order from this instance: ~₹30,000 at ~20% margin.
  const orderValue = 30000;
  const marginPct = 20;
  const marginRupees = (orderValue * marginPct) / 100;
  const ratio = marginRupees / Math.max(costInr, 1e-9);
  const costShare = (costInr / marginRupees) * 100;

  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Inference cost vs margin defended
      </h4>

      <div className="mt-3 rounded-2xl border border-line bg-mist/60 p-4">
        <p className="font-display text-3xl font-bold tabular-nums text-ink">
          {ratio.toLocaleString("en-IN", { maximumFractionDigits: 0 })}×
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-slate-ink">
          margin defended per rupee of inference, on a representative{" "}
          {inr(orderValue, 0)} order at {marginPct}% margin.
        </p>
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-[12px]">
          <span className="text-slate-ink">Margin on the order</span>
          <span className="tabular-nums text-ink">{inr(marginRupees, 0)}</span>
        </div>
        <div className="mt-1 h-3 overflow-hidden rounded-full bg-surface">
          <motion.div
            className="h-full rounded-full"
            style={{ background: SERIES.input }}
            initial={reduceMotion ? false : { width: 0 }}
            whileInView={{ width: "100%" }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>

        <div className="mt-3 flex items-baseline justify-between text-[12px]">
          <span className="text-slate-ink">Inference to earn it</span>
          <span className="tabular-nums text-ink">{inr(costInr)}</span>
        </div>
        <div className="mt-1 h-3 overflow-hidden rounded-full bg-surface">
          {/* Rendered at a visible minimum, and labelled as such — drawing it
              truly to scale would be a 0.003px sliver, which reads as a bug
              rather than as "vanishingly small". */}
          <motion.div
            className="h-full rounded-full"
            style={{ background: SERIES.output }}
            initial={reduceMotion ? false : { width: 0 }}
            whileInView={{ width: "1.5%" }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
        <p className="mt-1.5 text-[10.5px] text-muted">
          Cost bar shown at a visible minimum. True share is {costShare.toFixed(4)}% of margin —
          too small to draw to scale.
        </p>
      </div>
    </div>
  );
}

/**
 * Monthly spend at five order volumes.
 *
 * Bars, not a line: these are five discrete scenarios, not a continuous
 * series, and the earlier line version also had to be stretched with
 * `preserveAspectRatio="none"`, which squashed its markers into ellipses and
 * fragmented the path. Heights are log-scaled because spend spans four orders
 * of magnitude — every bar is directly labelled with its true value, so the
 * log axis cannot mislead.
 */
function ScaleProjection({ costInr }: { costInr: number }) {
  const reduceMotion = useReducedMotion();
  const volumes = [1_000, 10_000, 100_000, 1_000_000, 10_000_000];
  const points = volumes.map((v) => ({ v, cost: v * costInr }));
  const maxLog = Math.log10(points[points.length - 1].cost);
  const minLog = Math.log10(points[0].cost) - 0.5;

  const fmt = (c: number) =>
    c >= 1e7 ? `₹${(c / 1e7).toFixed(1)}Cr`
      : c >= 1e5 ? `₹${(c / 1e5).toFixed(1)}L`
        : c >= 1e3 ? `₹${(c / 1e3).toFixed(0)}K`
          : `₹${c.toFixed(0)}`;

  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Monthly inference spend by order volume
      </h4>
      <div className="mt-3 rounded-2xl border border-line bg-white p-5">
        <div className="flex h-40 items-end gap-3">
          {points.map((p, i) => {
            const height = ((Math.log10(p.cost) - minLog) / (maxLog - minLog)) * 100;
            return (
              // `h-full` is required, not decorative: a percentage height
              // resolves against a definite parent height, and without it
              // these columns are auto-height so every bar computed to zero.
              <div key={p.v} className="flex h-full flex-1 flex-col items-center justify-end">
                <span className="mb-1.5 font-display text-[12.5px] font-bold tabular-nums text-ink">
                  {fmt(p.cost)}
                </span>
                <motion.div
                  className="w-full rounded-t-[4px]"
                  style={{ background: SERIES.input }}
                  initial={reduceMotion ? false : { height: 0 }}
                  whileInView={{ height: `${Math.max(height, 4)}%` }}
                  viewport={{ once: true }}
                  transition={{
                    duration: 0.7,
                    delay: reduceMotion ? 0 : i * 0.08,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-3 border-t border-line pt-2">
          {points.map((p) => (
            <p key={p.v} className="flex-1 text-center text-[10.5px] text-muted">
              {p.v >= 1e6 ? `${p.v / 1e6}M` : `${p.v / 1e3}K`} orders
            </p>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
        Bar heights are log-scaled; the labels are the true figures. Spend is
        linear in order volume — there is no fixed cost to amortise and no step
        change at scale. At 10M orders a month the inference bill is a rounding
        error against the GMV it moves.
      </p>
    </div>
  );
}

export default function EconomicsCharts() {
  const [economics, setEconomics] = useState<Economics | null>(null);

  useEffect(() => {
    getEconomics().then(setEconomics).catch(() => {});
  }, []);

  if (!economics || economics.per_negotiation.sessions_metered === 0) {
    return (
      <p className="rounded-2xl border border-line bg-mist/50 p-6 text-center text-[13px] text-muted">
        {economics
          ? "No negotiations metered yet on this instance — run one on the Try it section and these fill in."
          : "Loading measured economics…"}
      </p>
    );
  }

  const perNegotiation = economics.per_negotiation;
  const costInr = perNegotiation.avg_inr;

  return (
    <div className="space-y-8">
      {/* Hero numbers: a single headline quantity each, so no chart. */}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [inr(costInr), "per negotiation", `${perNegotiation.avg_llm_calls} model calls`],
          [perNegotiation.avg_tokens.toLocaleString("en-IN"), "tokens per negotiation", "prompt + completion"],
          [`$${economics.rates_usd_per_million.input}/M`, "input token rate", economics.model],
        ].map(([value, label, sub]) => (
          <div key={String(label)} className="rounded-2xl border border-line bg-white p-4">
            <p className="font-display text-2xl font-bold tabular-nums text-ink">{value}</p>
            <p className="mt-0.5 text-[12px] font-medium text-slate-ink">{label}</p>
            <p className="text-[10.5px] text-muted">{sub}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <TokenMix economics={economics} />
        <CostVersusMargin costInr={costInr} />
      </div>

      <ScaleProjection costInr={costInr} />
    </div>
  );
}
