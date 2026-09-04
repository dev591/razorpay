"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Section-level entrance. Unlike the GSAP `Reveal`, this never parks the
 * element at `opacity: 0` in the DOM — under reduced motion it renders
 * plainly, so content can't get stranded invisible if the trigger never fires.
 */
export default function FadeIn({
  children,
  className,
  delay = 0,
  y = 24,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  as?: "div" | "li" | "section";
}) {
  const reduceMotion = useReducedMotion();
  const Tag = motion[as];

  if (reduceMotion) {
    const Plain = as;
    return <Plain className={className}>{children}</Plain>;
  }

  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, ease: EASE, delay }}
    >
      {children}
    </Tag>
  );
}

/** Shared eyebrow + heading + lede block, so every section opens the same way. */
export function SectionHead({
  eyebrow,
  title,
  lede,
  align = "center",
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: string;
  align?: "center" | "left";
}) {
  const centered = align === "center";
  return (
    <div className={centered ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      <FadeIn>
        <span className="inline-flex items-center gap-2 rounded-full border border-rzp-200 bg-rzp-50 px-3 py-1 text-[11px] font-semibold tracking-[0.12em] text-rzp-600 uppercase">
          {eyebrow}
        </span>
      </FadeIn>
      <FadeIn delay={0.06}>
        <h2 className="font-display mt-5 text-3xl leading-[1.1] font-semibold tracking-tight text-ink sm:text-[2.75rem]">
          {title}
        </h2>
      </FadeIn>
      {lede && (
        <FadeIn delay={0.12}>
          <p
            className={`mt-4 text-base leading-relaxed text-slate-ink sm:text-lg ${
              centered ? "mx-auto" : ""
            }`}
          >
            {lede}
          </p>
        </FadeIn>
      )}
    </div>
  );
}
