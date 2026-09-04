"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef } from "react";
import type { FeedItem } from "./useNegotiation";

const TONE: Record<FeedItem["tone"], { dot: string; text: string }> = {
  brand: { dot: "bg-rzp-500", text: "text-slate-ink" },
  counter: { dot: "bg-[color:var(--color-counter)]", text: "text-slate-ink" },
  walk: { dot: "bg-[color:var(--color-walk)]", text: "text-[color:var(--color-walk)]" },
  settle: { dot: "bg-[color:var(--color-settle)]", text: "text-slate-ink" },
  lock: { dot: "bg-[color:var(--color-lock)]", text: "text-slate-ink" },
  muted: { dot: "bg-line", text: "text-muted" },
};

/**
 * The negotiation as it happens, newest at the bottom.
 *
 * Auto-scroll is suppressed once the reader scrolls up: during a live run
 * this appends every second or two, and yanking the viewport back down while
 * someone is reading an earlier line is worse than letting the tail drift.
 */
export default function ActivityFeed({ items }: { items: FeedItem[] }) {
  const reduceMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }, [items.length, reduceMotion]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full max-h-[420px] space-y-0 overflow-y-auto pr-1"
    >
      <AnimatePresence initial={false}>
        {items.map((item) => {
          const tone = TONE[item.tone];
          return (
            <motion.div
              key={item.id}
              layout={!reduceMotion}
              initial={reduceMotion ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
              className="flex gap-2.5 border-b border-line/50 py-2 last:border-0"
            >
              <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
              <div className="min-w-0 flex-1">
                <span className="mr-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">
                  {item.actor}
                </span>
                <span className={`text-[12.5px] leading-snug ${tone.text}`}>{item.text}</span>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
      {items.length === 0 && (
        <p className="py-8 text-center text-[12.5px] text-muted">
          Events stream here the moment the mandate is approved.
        </p>
      )}
    </div>
  );
}
