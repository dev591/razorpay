"use client";

import { useEffect, useState } from "react";
import { getModelOutage, setModelOutage } from "@/lib/api";

/**
 * Breaks the pricing model on purpose, so the degraded path can be watched
 * rather than taken on trust.
 *
 * It does not fake a fallback result: the upstream call genuinely fails, and
 * the retry budget, the jittered backoff, the rule-based quoting and the
 * `degraded` flag on every cart and audit entry all run exactly as they would
 * in a real outage. The margin floor is still enforced while it's on.
 *
 * The switch expires by itself — a demo control left on by accident is a
 * control that makes a working system look broken.
 */
export default function OutageToggle({ disabled = false }: { disabled?: boolean }) {
  const [broken, setBroken] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    getModelOutage()
      .then((s) => setBroken(s.model_unreachable))
      .catch(() => {});
  }, []);

  // Poll only while it's on, so the UI notices the TTL lapsing.
  useEffect(() => {
    if (!broken) return;
    const t = setInterval(() => {
      getModelOutage()
        .then((s) => setBroken(s.model_unreachable))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [broken]);

  async function toggle() {
    setPending(true);
    try {
      const next = await setModelOutage(!broken, 300);
      setBroken(next.model_unreachable);
    } catch {
      /* leave the switch where it was */
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="ml-auto flex items-center gap-2">
      {/* Status sits before the button so the button stays anchored right —
          otherwise the longer "restore it" label shifts it under the cursor. */}
      {broken && (
        <span className="hidden text-[11px] font-medium text-walk sm:inline">
          Degraded · rule-based quoting, floor still enforced
        </span>
      )}
      <button
        onClick={toggle}
        disabled={disabled || pending}
        aria-pressed={broken}
        title="Makes the pricing model genuinely unreachable. The negotiation still completes, on rule-based quoting, and says so."
        className={`rounded-full border px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-40 ${
          broken
            ? "border-walk bg-walk text-white"
            : "border-line text-slate-ink hover:border-walk hover:text-walk"
        }`}
      >
        {broken ? "Model is down — restore it" : "Break the model"}
      </button>
    </div>
  );
}
