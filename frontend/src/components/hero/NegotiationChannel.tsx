"use client";

import { useEffect, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion";

/**
 * The hero's product surface: a looping, self-playing dramatisation of one
 * order — request, an offer, a counter, agreement, and the lock that gates
 * payment.
 *
 * It is a *scripted* replay, not a live session: the hero must be legible in
 * the first two seconds on a cold load, and a real `/sessions` call takes
 * 10-20s of OpenAI round-trips. The live version is one click away in the
 * playground.
 */

type Tone = "brand" | "counter" | "walk" | "settle" | "lock";
type Side = "buyer" | "merchant" | "system";

type Beat = {
  side: Side;
  label: string;
  text: string;
  tone: Tone;
  /** Order total after this beat, if it changed. */
  amount?: number;
};

const SCRIPT: Beat[] = [
  {
    side: "buyer",
    label: "Request",
    text: "12 kegs, up to ₹48,000, delivered within 5 days",
    tone: "brand",
  },
  {
    side: "merchant",
    label: "Offer",
    text: "12 × Cold-brew keg, plus an insulated tap",
    tone: "counter",
    amount: 51600,
  },
  {
    side: "buyer",
    label: "Counter-offer",
    text: "That\u2019s ₹3,600 over budget. Drop the tap, keep the 12.",
    tone: "walk",
  },
  {
    side: "merchant",
    label: "Revised offer",
    text: "12 × Cold-brew keg, still worth it for us",
    tone: "counter",
    amount: 47400,
  },
  {
    side: "buyer",
    label: "Agreed",
    text: "Inside every limit. Let\u2019s do it.",
    tone: "settle",
    amount: 47400,
  },
  {
    side: "system",
    label: "Order locked",
    text: "Order #9F3C frozen · payment authorised",
    tone: "lock",
    amount: 47400,
  },
];

const TONE: Record<Tone, { text: string; bg: string; ring: string; dot: string }> =
  {
    brand: {
      text: "text-rzp-600",
      bg: "bg-rzp-100",
      ring: "ring-rzp-200",
      dot: "bg-rzp-500",
    },
    counter: {
      text: "text-[#B54708]",
      bg: "bg-[#FEF0C7]",
      ring: "ring-[#FEDF89]",
      dot: "bg-counter",
    },
    walk: {
      text: "text-[#B42318]",
      bg: "bg-[#FEE4E2]",
      ring: "ring-[#FECDCA]",
      dot: "bg-walk",
    },
    settle: {
      text: "text-[#027A48]",
      bg: "bg-[#D1FADF]",
      ring: "ring-[#A6F4C5]",
      dot: "bg-settle",
    },
    lock: {
      text: "text-[#5925DC]",
      bg: "bg-[#EBE9FE]",
      ring: "ring-[#D9D6FE]",
      dot: "bg-lock",
    },
  };

const BEAT_MS = 2000;

function AgentPod({
  name,
  role,
  meta,
  accent,
  active,
  icon,
}: {
  name: string;
  role: string;
  meta: string;
  accent: string;
  active: boolean;
  icon: React.ReactNode;
}) {
  return (
    <div className="relative flex w-[8.5rem] flex-col items-center gap-2 sm:w-40">
      <div className="relative">
        {/* Radar ping only while this agent holds the turn. */}
        {active && (
          <span
            className="anim-pulse-ring absolute inset-0 rounded-2xl"
            style={{ boxShadow: `0 0 0 2px ${accent}` }}
          />
        )}
        <motion.div
          animate={{
            scale: active ? 1.06 : 1,
            boxShadow: active
              ? `0 12px 28px -10px ${accent}80`
              : "0 4px 12px -6px rgba(19,38,68,0.18)",
          }}
          transition={{ type: "spring", stiffness: 260, damping: 22 }}
          className="relative grid h-14 w-14 place-items-center rounded-2xl border border-line bg-white"
        >
          <span style={{ color: accent }}>{icon}</span>
        </motion.div>
      </div>
      <div className="text-center">
        <p className="text-[13px] font-semibold text-ink">{name}</p>
        <p className="text-[11px] text-muted">{role}</p>
        <p className="mt-1 font-mono text-[10px] tracking-tight text-slate-ink/70">
          {meta}
        </p>
      </div>
    </div>
  );
}

export default function NegotiationChannel() {
  const reduceMotion = useReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reduceMotion) return;
    const id = setInterval(() => setTick((t) => t + 1), BEAT_MS);
    return () => clearInterval(id);
  }, [reduceMotion]);

  // Under reduced motion the panel parks on the settled end state — the one
  // frame that explains the whole flow without any playback.
  const step = reduceMotion ? SCRIPT.length - 1 : tick % SCRIPT.length;
  const beat = SCRIPT[step];

  // Running order total, carried forward across beats that don't change it.
  const amount = SCRIPT.slice(0, step + 1)
    .reverse()
    .find((b) => b.amount !== undefined)?.amount;

  const amountMv = useMotionValue(0);
  const amountText = useTransform(amountMv, (v) =>
    v > 0 ? `₹${Math.round(v).toLocaleString("en-IN")}` : "—"
  );

  useEffect(() => {
    const controls = animate(amountMv, amount ?? 0, {
      duration: reduceMotion ? 0 : 0.7,
      ease: [0.22, 1, 0.36, 1],
    });
    return () => controls.stop();
  }, [amount, amountMv, reduceMotion]);

  const settled = beat.tone === "lock";

  return (
    <div className="panel panel-glow relative w-full overflow-hidden rounded-[20px]">
      {/* Header — reads as a real session console, not a marketing graphic. */}
      <div className="flex items-center justify-between border-b border-line/80 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-settle opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-settle" />
          </span>
          <span className="font-mono text-[11px] tracking-tight text-slate-ink">
            sess_8Kq2Rf· live
          </span>
        </div>
        <span className="font-mono text-[11px] text-muted">
          round {Math.min(Math.ceil((step + 1) / 2), 3)}/3
        </span>
      </div>

      <div className="px-4 pt-5 pb-4 sm:px-6">
        {/* ── Agents + channel ─────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-2">
          <AgentPod
            name="Buyer agent"
            role="Cafe Nomad"
            meta="up to ₹48,000"
            accent="#305EFF"
            active={beat.side === "buyer"}
            icon={
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path
                  d="M3 6h2l2.2 9.2a2 2 0 0 0 2 1.5h7.4a2 2 0 0 0 1.9-1.4L21 8H6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="10" cy="20" r="1.4" fill="currentColor" />
                <circle cx="17" cy="20" r="1.4" fill="currentColor" />
              </svg>
            }
          />

          <div className="relative mt-6 h-12 flex-1">
            {/* The wire */}
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-rzp-200 via-rzp-300 to-[#D9D6FE]" />
            <motion.div
              className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(90deg, rgba(48,94,255,0.65) 0 6px, transparent 6px 18px)",
              }}
              animate={reduceMotion ? undefined : { backgroundPositionX: [0, 72] }}
              transition={{ duration: 1.4, ease: "linear", repeat: Infinity }}
            />

            {/* The packet, travelling in whichever direction holds the turn. */}
            {!reduceMotion && (
              <motion.span
                key={step}
                className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full"
                style={{
                  background: beat.side === "buyer" ? "#305EFF" : "#7A5AF8",
                  boxShadow: `0 0 12px ${
                    beat.side === "buyer" ? "#305EFF" : "#7A5AF8"
                  }`,
                }}
                initial={{ left: beat.side === "buyer" ? "0%" : "100%", opacity: 0 }}
                animate={{
                  left: beat.side === "buyer" ? "100%" : "0%",
                  opacity: [0, 1, 1, 0],
                }}
                transition={{ duration: BEAT_MS / 1000, ease: "easeInOut" }}
              />
            )}

            <div className="absolute inset-x-0 top-[calc(50%+10px)] text-center">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                {settled ? "agreed" : "working it out"}
              </span>
            </div>
          </div>

          <AgentPod
            name="Merchant agent"
            role="Bluebarrel Co."
            meta="min. margin 14%"
            accent="#7A5AF8"
            active={beat.side === "merchant"}
            icon={
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
                <path
                  d="M3.5 5.5h17L21 9H3l.5-3.5Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
                <path
                  d="M10 13h4"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            }
          />
        </div>

        {/* ── The beat itself ──────────────────────────────────────────── */}
        <div className="relative mt-5 h-[74px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{
                opacity: 0,
                y: 10,
                x: beat.side === "merchant" ? 14 : beat.side === "buyer" ? -14 : 0,
              }}
              animate={{ opacity: 1, y: 0, x: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0"
            >
              <div
                className={`flex h-full flex-col justify-center gap-1.5 rounded-2xl px-4 ring-1 ${
                  TONE[beat.tone].bg
                } ${TONE[beat.tone].ring}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${TONE[beat.tone].dot}`} />
                  <span
                    className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${
                      TONE[beat.tone].text
                    }`}
                  >
                    {beat.label}
                  </span>
                </div>
                <p className="text-[13px] leading-snug text-ink-600 sm:text-sm">
                  {beat.text}
                </p>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* ── Ledger strip ─────────────────────────────────────────────── */}
        <div className="mt-4 flex items-end justify-between border-t border-line/80 pt-3.5">
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted">
              Order total
            </p>
            <motion.p className="font-display text-2xl font-semibold text-ink tabular-nums">
              {amountText}
            </motion.p>
          </div>

          <motion.div
            animate={{ opacity: settled ? 1 : 0.35, scale: settled ? 1 : 0.96 }}
            transition={{ type: "spring", stiffness: 300, damping: 24 }}
            className="flex items-center gap-2 rounded-full bg-[#D1FADF] px-3 py-1.5 ring-1 ring-[#A6F4C5]"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path
                d="M20 6 9 17l-5-5"
                stroke="#027A48"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[11px] font-semibold text-[#027A48]">
              Payment held
            </span>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
