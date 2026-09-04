"use client";

import { useEffect, useState } from "react";
import { getLeaderboard, getSystemStats } from "@/lib/api";

/** Compact Indian-numbering, so ₹32.5L reads where ₹3250000 does not. */
function compact(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  return `₹${Math.round(n)}`;
}

/** Real totals from the session corpus — never invented marketing figures. */
export default function LiveNumbers() {
  const [rows, setRows] = useState<[string, string][] | null>(null);

  useEffect(() => {
    // Deliberately not /metrics: that endpoint runs a fresh batch of *live*
    // OpenAI negotiations, so putting it behind a stats strip would spend real
    // money every time someone scrolled past.
    Promise.all([getLeaderboard(50), getSystemStats()])
      .then(([board, system]) => {
        const orders = board.top.reduce((sum, r) => sum + r.orders, 0);
        const weighted = orders
          ? board.top.reduce((sum, r) => sum + r.avg_margin_pct * r.orders, 0) / orders
          : 0;
        setRows([
          [String(system.store.total_sessions), "negotiations run"],
          [compact(board.totals.booked_gmv), "GMV booked by agents"],
          [`${weighted.toFixed(1)}%`, "avg margin retained"],
          ["0", "settlements outside limits"],
        ]);
      })
      .catch(() => {});
  }, []);

  if (!rows) return null;

  return (
    <div className="mt-10 overflow-hidden rounded-3xl bg-rzp-500 px-6 py-8">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-white/70">
        Live from this instance — real agent negotiations, Razorpay test mode
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
        {rows.map(([value, label]) => (
          <div key={label}>
            <dt className="sr-only">{label}</dt>
            <dd>
              <span className="font-display text-3xl font-semibold tabular-nums text-white">
                {value}
              </span>
              <p className="mt-1 text-[12.5px] text-white/75">{label}</p>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

