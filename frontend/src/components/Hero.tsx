"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import ScrollScene from "@/components/ScrollScene";
import AuroraField from "@/components/hero/AuroraField";
import NegotiationChannel from "@/components/hero/NegotiationChannel";

// Same-origin navigations must go through next/link for client routing.
const MotionLink = motion.create(Link);

const EASE = [0.22, 1, 0.36, 1] as const;

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.12 } },
};

const rise = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } },
};

/** Per-word mask wipe — the headline builds instead of just fading in. */
function Headline({
  children,
  gradient = false,
  delay = 0,
}: {
  children: string;
  gradient?: boolean;
  delay?: number;
}) {
  const reduceMotion = useReducedMotion();
  const words = children.split(" ");
  // The tint has to land on the innermost text-bearing span, never a wrapper:
  // `background-clip: text` paints against the element's own background box,
  // and an inline wrapper around a row of inline-blocks has no usable box, so
  // a gradient set on the outside renders as nothing at all.
  const tint = gradient ? "text-brand-gradient" : "";

  if (reduceMotion) {
    return <span className={`inline-block ${tint}`}>{children}</span>;
  }

  return (
    <>
      {words.map((word, i) => (
        <span key={`${word}-${i}`} className="inline-block overflow-hidden pb-[0.08em]">
          <motion.span
            className={`inline-block ${tint}`}
            initial={{ y: "108%" }}
            animate={{ y: 0 }}
            transition={{
              duration: 0.85,
              ease: EASE,
              delay: delay + 0.1 + i * 0.055,
            }}
          >
            {word}
            {i < words.length - 1 ? " " : ""}
          </motion.span>
        </span>
      ))}
    </>
  );
}

const TRUST = [
  "Runs on Razorpay test mode",
  "Every step recorded",
  "Payment held until both agree",
];

export default function Hero() {
  return (
    <ScrollScene id="hero" durationVh={210} className="bg-white" reveal={false}>
      {({ progress, scrubbed }) => {
        // The whole hero is a camera move: content travels toward the viewer
        // on Z and dissolves, so the next section is revealed by flying
        // *through* this one rather than by scrolling past it.
        const p = scrubbed ? progress : 0;
        const dolly = p * 300;
        const opacity = Math.max(0, 1 - p * 1.35);
        const blur = p > 0.45 ? (p - 0.45) * 14 : 0;

        return (
          <section className="grain relative isolate flex min-h-screen items-center overflow-hidden bg-white">
            <AuroraField className="absolute inset-0 -z-20" progress={p} />
            <div className="grid-fade absolute inset-0 -z-10" />
            {/* Paper scrim over the copy column. The aurora is deliberately
                soft, but body copy still needs a guaranteed ground rather
                than whatever the noise happens to be doing behind it. */}
            <div
              aria-hidden
              className="absolute inset-y-0 left-0 -z-10 hidden w-[62%] bg-gradient-to-r from-white via-white/85 to-transparent lg:block"
            />

            <div
              className="relative w-full"
              style={{ perspective: "1400px", perspectiveOrigin: "50% 42%" }}
            >
              <motion.div
                variants={container}
                initial="hidden"
                animate="show"
                className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 pt-20 pb-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16"
                style={{
                  transform: `translateZ(${dolly}px)`,
                  opacity,
                  filter: blur ? `blur(${blur}px)` : undefined,
                  transformStyle: "preserve-3d",
                }}
              >
                {/* ── Copy ─────────────────────────────────────────────── */}
                <div className="max-w-xl">
                  <MotionLink
                    variants={rise}
                    href="/try"
                    className="group inline-flex items-center gap-2 rounded-full border border-rzp-200 bg-white/70 py-1.5 pr-3 pl-1.5 text-xs backdrop-blur transition-colors hover:border-rzp-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rzp-500"
                  >
                    <span className="rounded-full bg-rzp-500 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
                      Live demo
                    </span>
                    <span className="font-medium text-slate-ink">
                      See a full order, start to finish
                    </span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      className="text-muted transition-transform group-hover:translate-x-0.5"
                    >
                      <path
                        d="m9 6 6 6-6 6"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </MotionLink>

                  <h1 className="font-display mt-6 text-[2.6rem] leading-[1.04] font-semibold tracking-tight text-ink sm:text-6xl lg:text-[4.1rem]">
                    <Headline>Two agents.</Headline>
                    <br />
                    <Headline delay={0.1}>One cart.</Headline>
                    <br />
                    <Headline delay={0.2} gradient>
                      Zero blind trust.
                    </Headline>
                  </h1>

                  <motion.p
                    variants={rise}
                    className="mt-6 max-w-lg text-[15px] leading-relaxed text-slate-ink sm:text-lg"
                  >
                    A buyer agent and a merchant agent work out a real order
                    between them — inside the budget, quantity and delivery
                    window you set. Once they agree, the order is frozen, and
                    Razorpay releases payment only if nothing about it changed.
                  </motion.p>

                  <motion.div
                    variants={rise}
                    className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center"
                  >
                    <Link
                      href="/try"
                      className="group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full bg-rzp-500 px-6 py-3.5 text-sm font-semibold text-white shadow-[0_10px_28px_-10px_rgba(48,94,255,0.85)] transition-all hover:-translate-y-0.5 hover:bg-rzp-600 hover:shadow-[0_16px_36px_-12px_rgba(48,94,255,0.95)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rzp-500"
                    >
                      {/* Sheen sweep on hover — the one flourish on the CTA. */}
                      <span className="pointer-events-none absolute inset-0 -translate-x-[120%] bg-gradient-to-r from-transparent via-white/35 to-transparent transition-transform duration-700 group-hover:translate-x-[220%]" />
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
                    <Link
                      href="/#how"
                      className="inline-flex items-center justify-center rounded-full border border-line bg-white/70 px-6 py-3.5 text-sm font-semibold text-ink backdrop-blur transition-all hover:-translate-y-0.5 hover:border-rzp-200 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rzp-500"
                    >
                      See how it works
                    </Link>
                  </motion.div>

                  <motion.ul
                    variants={rise}
                    className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2"
                  >
                    {TRUST.map((item) => (
                      <li
                        key={item}
                        className="flex items-center gap-1.5 text-[12px] text-muted"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M20 6 9 17l-5-5"
                            stroke="#12B76A"
                            strokeWidth="2.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        {item}
                      </li>
                    ))}
                  </motion.ul>
                </div>

                {/* ── Product surface ──────────────────────────────────── */}
                <motion.div
                  variants={rise}
                  className="relative"
                  style={{ transform: "translateZ(60px)" }}
                >
                  {/* Soft brand bloom behind the panel, so it lifts off the
                      aurora instead of floating on it. */}
                  <div
                    aria-hidden
                    className="absolute -inset-8 -z-10 rounded-[40px] opacity-70 blur-3xl"
                    style={{
                      background:
                        "radial-gradient(60% 60% at 50% 40%, rgba(48,94,255,0.22), transparent 70%)",
                    }}
                  />
                  <div className="anim-float">
                    <NegotiationChannel />
                  </div>
                </motion.div>
              </motion.div>
            </div>

            {/* Scroll cue — retires as soon as the dolly starts. */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: p > 0.04 ? 0 : 1 }}
              transition={{ duration: 0.4, delay: p > 0.04 ? 0 : 1.4 }}
              className="pointer-events-none absolute inset-x-0 bottom-7 flex justify-center"
            >
              <span className="flex items-center gap-2 text-[11px] tracking-[0.16em] text-muted uppercase">
                <span className="h-8 w-px bg-gradient-to-b from-transparent to-rzp-300" />
                Scroll to explore
                <span className="h-8 w-px bg-gradient-to-b from-transparent to-rzp-300" />
              </span>
            </motion.div>
          </section>
        );
      }}
    </ScrollScene>
  );
}
