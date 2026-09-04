"use client";

import { motion, useReducedMotion } from "framer-motion";

/**
 * The layering, drawn to make one point: the LLM is the smallest and least
 * trusted box on the page.
 *
 * Everything that decides whether money moves — floors, hashes, signatures,
 * gates — sits in deterministic code below it. The models propose; the
 * protocol layer disposes. Any diagram that puts "AI" at the centre is
 * describing a different, worse system.
 */

type Layer = {
  name: string;
  tone: "model" | "orchestration" | "protocol" | "data" | "external";
  items: { label: string; note: string }[];
};

const LAYERS: Layer[] = [
  {
    name: "Agents — proposals only",
    tone: "model",
    items: [
      { label: "buyer_agent", note: "accept / counter / walk" },
      { label: "merchant_agent", note: "quote price, lead time, terms" },
    ],
  },
  {
    name: "Orchestration",
    tone: "orchestration",
    items: [
      { label: "session_manager", note: "rounds, gates, settlement" },
      { label: "marketplace", note: "concurrent fan-out, scoring" },
      { label: "upsell_engine", note: "rule-based, not LLM" },
      { label: "economics", note: "measured token spend" },
    ],
  },
  {
    name: "Protocol — the trust boundary",
    tone: "protocol",
    items: [
      { label: "mandates", note: "intent / cart / payment" },
      { label: "pricing + terms", note: "one margin definition" },
      { label: "signing", note: "HMAC, canonical JSON" },
      { label: "audit_ledger", note: "append-only hash chain" },
    ],
  },
  {
    name: "Data structures",
    tone: "data",
    items: [
      { label: "SessionStore", note: "LRU + inverted indices" },
      { label: "CatalogIndex", note: "trie + inverted index" },
      { label: "Leaderboard", note: "bisect sorted list" },
      { label: "EventBus", note: "ring buffer + fan-out" },
    ],
  },
  {
    name: "External",
    tone: "external",
    items: [
      { label: "Razorpay Orders", note: "real test-mode API" },
      { label: "OpenAI", note: "gpt-4o-mini, bounded timeout" },
    ],
  },
];

const TONE: Record<Layer["tone"], { bg: string; border: string; dot: string }> = {
  model: {
    bg: "bg-[color:var(--color-counter)]/[0.07]",
    border: "border-[color:var(--color-counter)]/35",
    dot: "bg-[color:var(--color-counter)]",
  },
  orchestration: { bg: "bg-rzp-50", border: "border-rzp-200", dot: "bg-rzp-500" },
  protocol: {
    bg: "bg-[color:var(--color-lock)]/[0.07]",
    border: "border-[color:var(--color-lock)]/35",
    dot: "bg-[color:var(--color-lock)]",
  },
  data: { bg: "bg-mist", border: "border-line", dot: "bg-slate-ink" },
  external: {
    bg: "bg-[color:var(--color-settle)]/[0.07]",
    border: "border-[color:var(--color-settle)]/35",
    dot: "bg-[color:var(--color-settle)]",
  },
};

export default function ArchitectureDiagram() {
  const reduceMotion = useReducedMotion();
  return (
    <div className="space-y-2.5">
      {LAYERS.map((layer, i) => {
        const tone = TONE[layer.tone];
        return (
          <motion.div
            key={layer.name}
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-40px" }}
            transition={{ duration: 0.4, delay: reduceMotion ? 0 : i * 0.07 }}
            className={`rounded-2xl border ${tone.border} ${tone.bg} p-4`}
          >
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
              <h4 className="font-display text-[12px] font-bold uppercase tracking-[0.12em] text-ink">
                {layer.name}
              </h4>
            </div>
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {layer.items.map((item) => (
                <div key={item.label} className="rounded-xl border border-line/70 bg-white/70 px-3 py-2">
                  <p className="font-mono text-[11.5px] font-medium text-ink">{item.label}</p>
                  <p className="mt-0.5 text-[10.5px] leading-snug text-muted">{item.note}</p>
                </div>
              ))}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
