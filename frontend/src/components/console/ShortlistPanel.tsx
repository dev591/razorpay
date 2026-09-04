"use client";

import type { Shortlist } from "@/components/console/useNegotiation";
import { rupees } from "@/lib/format";

const REASON_COPY: Record<string, string> = {
  above_price_bound: "floor price above the shortlist cut",
  cannot_fill_basket: "does not stock every requested item",
};

/**
 * Who was refused a negotiation, and what refusing them saved.
 *
 * This is the only place the avoided cost is visible: the gate runs before any
 * model call, so by the time offers exist the money is already spent. The
 * bound shown is the cheapest total each vendor could reach at its own margin
 * floor — not a guess, so "could not have won" is a claim rather than a hope.
 */
export default function ShortlistPanel({ shortlist }: { shortlist: Shortlist }) {
  if (!shortlist.eliminated.length) return null;

  return (
    <div className="rounded-2xl border border-line bg-mist p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Shortlisted {shortlist.negotiating} of {shortlist.considered}
        </p>
        {shortlist.saved && (
          <p className="text-[11.5px] font-medium text-settle">
            Saved ~{shortlist.saved.model_calls} model calls ·{" "}
            {rupees(shortlist.saved.inr)}
            <span className="text-muted"> ({shortlist.saved.basis})</span>
          </p>
        )}
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-slate-ink">
        Negotiation costs real model calls per vendor, so the field is cut{" "}
        <em>before</em> anyone talks. Each vendor is ranked by the cheapest total
        it could reach at its own margin floor — a bound no amount of haggling
        moves.
      </p>
      <ul className="mt-3 space-y-1.5">
        {shortlist.eliminated.map((v) => (
          <li
            key={v.id}
            className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-line/70 pt-1.5 text-[12.5px]"
          >
            <span className="font-medium text-ink">{v.name}</span>
            <span className="text-muted">
              {REASON_COPY[v.reason] ?? v.reason.replace(/_/g, " ")}
              {v.bound !== null && (
                <span className="ml-1.5 font-mono tabular-nums text-slate-ink">
                  floor {rupees(Math.round(v.bound))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
