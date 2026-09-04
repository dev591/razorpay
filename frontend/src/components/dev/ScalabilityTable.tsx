"use client";

import { motion, useReducedMotion } from "framer-motion";

/**
 * What each structure replaced, and what it costs.
 *
 * Complexity classes are the honest way to argue about scale: they say what
 * happens as N grows without pretending a laptop benchmark predicts
 * production. Every "before" here was real code in this repo, not a strawman.
 */

const ROWS = [
  {
    op: "Fetch a merchant's orders",
    before: "O(n) scan over every session",
    after: "O(k) set lookup",
    structure: "two inverted indices",
    why: "The dashboard call grew with total platform volume instead of with that merchant's own order count.",
  },
  {
    op: "Hold sessions in memory",
    before: "unbounded dict",
    after: "O(1) LRU + disk spill",
    structure: "OrderedDict",
    why: "Sessions carry full transcripts. Unbounded growth is an OOM with a delay on it.",
  },
  {
    op: "Search the catalog",
    before: "client-side filter over every SKU",
    after: "O(len(prefix)) / rarest-token",
    structure: "trie + inverted index",
    why: "An AI buyer should not pull every merchant's inventory to find one product.",
  },
  {
    op: "Pick the winning offer",
    before: "sort all offers, take first",
    after: "O(n log k) bounded heap",
    structure: "heapq.nlargest",
    why: "The broadcast is a fan-out designed to grow to every registered merchant.",
  },
  {
    op: "Rank vendors by GMV",
    before: "re-sort on every request",
    after: "O(log n) insert, O(1) read",
    structure: "bisect sorted list",
    why: "Read on every dashboard poll, written once per settlement — the trade runs that way round.",
  },
  {
    op: "Stream a negotiation",
    before: "discarded; 20s blocking call",
    after: "O(1) append, bounded replay",
    structure: "deque ring buffer",
    why: "Everything interesting happened inside a window the UI could not see.",
  },
];

export default function ScalabilityTable() {
  const reduceMotion = useReducedMotion();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            {["Operation", "Before", "After", "Structure"].map((h) => (
              <th key={h} className="pb-2 pr-4 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row, i) => (
            <motion.tr
              key={row.op}
              initial={reduceMotion ? false : { opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.35, delay: reduceMotion ? 0 : i * 0.05 }}
              className="border-b border-line/60 align-top"
            >
              <td className="py-3 pr-4">
                <p className="text-[13px] font-medium text-ink">{row.op}</p>
                <p className="mt-0.5 max-w-xs text-[11px] leading-snug text-muted">{row.why}</p>
              </td>
              <td className="py-3 pr-4 text-[12px] text-[color:var(--color-walk)]">{row.before}</td>
              <td className="py-3 pr-4 text-[12px] font-medium text-[color:var(--color-settle)]">{row.after}</td>
              <td className="py-3 pr-4 font-mono text-[11px] text-slate-ink">{row.structure}</td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
