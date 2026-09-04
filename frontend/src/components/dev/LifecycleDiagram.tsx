"use client";

import { motion, useReducedMotion } from "framer-motion";

/**
 * The order lifecycle, drawn as the mechanism rather than as a flowchart of
 * boxes.
 *
 * Two things this has to show that prose keeps failing to: that the human gate
 * sits *before* any spend, and that the shortlisted vendor negotiations happen
 * concurrently against one shared ledger. A vertical list of steps implies a
 * sequence, which is exactly the wrong mental model for the middle of it.
 */

const LANE = { buyer: 78, vendors: 176, protocol: 330 };

function Pill({
  x, y, w, label, tone = "brand", sub,
}: {
  x: number; y: number; w: number; label: string;
  tone?: "brand" | "gate" | "settle" | "muted"; sub?: string;
}) {
  const fill = {
    brand: "var(--color-rzp-50)",
    gate: "color-mix(in srgb, var(--color-lock) 10%, white)",
    settle: "color-mix(in srgb, var(--color-settle) 12%, white)",
    muted: "var(--color-mist)",
  }[tone];
  const stroke = {
    brand: "var(--color-rzp-300)",
    gate: "var(--color-lock)",
    settle: "var(--color-settle)",
    muted: "var(--color-line)",
  }[tone];

  return (
    <g>
      <rect x={x} y={y} width={w} height={sub ? 42 : 30} rx={10} fill={fill} stroke={stroke} strokeWidth={1} />
      <text x={x + w / 2} y={y + (sub ? 18 : 19)} textAnchor="middle" className="fill-ink" fontSize={11.5} fontWeight={600}>
        {label}
      </text>
      {sub && (
        <text x={x + w / 2} y={y + 32} textAnchor="middle" className="fill-muted" fontSize={9.5}>
          {sub}
        </text>
      )}
    </g>
  );
}

function Arrow({ d, dashed = false, delay = 0 }: { d: string; dashed?: boolean; delay?: number }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.path
      d={d}
      fill="none"
      stroke="var(--color-slate-ink)"
      strokeWidth={1.3}
      strokeDasharray={dashed ? "4 3" : undefined}
      markerEnd="url(#arrowhead)"
      initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
      whileInView={{ pathLength: 1, opacity: 0.8 }}
      viewport={{ once: true }}
      transition={{ duration: 0.7, delay, ease: "easeOut" }}
    />
  );
}

export default function LifecycleDiagram() {
  return (
    <figure className="overflow-x-auto">
      <svg viewBox="0 0 880 440" className="w-full min-w-[760px]" role="img"
        aria-label="Order lifecycle: a human signs an intent mandate, which is broadcast concurrently to the shortlisted vendor agents; offers are scored, the cart is hash-locked and dual-signed, and settled through Razorpay.">
        <defs>
          <marker id="arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="2.6" orient="auto">
            <path d="M0,0 L6,2.6 L0,5.2 z" fill="var(--color-slate-ink)" opacity="0.8" />
          </marker>
        </defs>

        {/* Lane labels */}
        {[
          ["Buyer side", LANE.buyer],
          ["Vendor agents (concurrent)", LANE.vendors],
          ["Protocol & settlement", LANE.protocol],
        ].map(([label, y]) => (
          <text key={String(label)} x={8} y={(y as number) - 16} fontSize={9.5} fontWeight={700}
            className="fill-muted" letterSpacing="0.1em">
            {String(label).toUpperCase()}
          </text>
        ))}
        <line x1={8} y1={LANE.vendors - 30} x2={872} y2={LANE.vendors - 30} stroke="var(--color-line)" strokeDasharray="3 4" />
        <line x1={8} y1={LANE.protocol - 30} x2={872} y2={LANE.protocol - 30} stroke="var(--color-line)" strokeDasharray="3 4" />

        {/* 1. Intent drafted */}
        <Pill x={8} y={LANE.buyer} w={132} label="Intent drafted" sub="signed, not yet spendable" />
        <path d="M144 93 h18" stroke="var(--color-slate-ink)" strokeWidth={1.3} markerEnd="url(#arrowhead)" opacity={0.8} />

        {/* 2. Human gate — the load-bearing step */}
        <Pill x={168} y={LANE.buyer} w={150} label="Human approval" tone="gate" sub="nothing spends before this" />
        <text x={243} y={LANE.buyer + 60} textAnchor="middle" fontSize={9.5} className="fill-muted">
          blocking · signed into the ledger
        </text>

        {/* 3. Broadcast fan-out */}
        <path d="M322 93 h44" stroke="var(--color-slate-ink)" strokeWidth={1.3} markerEnd="url(#arrowhead)" opacity={0.8} />
        <Pill x={372} y={LANE.buyer} w={116} label="Broadcast" sub="one intent, N vendors" />

        {/* fan-out lines into the vendor lane */}
        {[0, 1, 2].map((i) => (
          <Arrow
            key={i}
            d={`M430 ${LANE.buyer + 42} C 430 150, ${250 + i * 200} 150, ${250 + i * 200} ${LANE.vendors - 6}`}
            delay={0.2 + i * 0.08}
          />
        ))}

        {/* Vendor lanes */}
        {[
          ["TechMart", 190, "12% floor"],
          ["ByteBazaar", 390, "18% floor"],
          ["QuickSupply", 590, "8% floor"],
        ].map(([name, x, floor], i) => (
          <g key={String(name)}>
            <Pill x={x as number} y={LANE.vendors} w={120} label={String(name)} sub={String(floor)} />
            <text x={(x as number) + 60} y={LANE.vendors + 60} textAnchor="middle" fontSize={9} className="fill-muted">
              price · lead time · terms
            </text>
            <Arrow d={`M${(x as number) + 60} ${LANE.vendors + 68} V ${LANE.protocol - 8}`} delay={0.5 + i * 0.07} />
          </g>
        ))}

        {/* Deterministic guard sitting between the model and the ledger */}
        <rect x={150} y={LANE.vendors + 76} width={560} height={22} rx={6}
          fill="color-mix(in srgb, var(--color-walk) 8%, white)" stroke="var(--color-walk)" strokeWidth={0.9} strokeDasharray="3 3" />
        <text x={430} y={LANE.vendors + 91} textAnchor="middle" fontSize={10} fontWeight={600} className="fill-ink">
          deterministic margin-floor guard — rejects any cart the model prices below its own floor
        </text>

        {/* Protocol row */}
        <Pill x={110} y={LANE.protocol} w={128} label="Scored" sub="price · speed · terms" />
        <path d="M242 345 h26" stroke="var(--color-slate-ink)" strokeWidth={1.3} markerEnd="url(#arrowhead)" opacity={0.8} />
        <Pill x={274} y={LANE.protocol} w={140} label="You choose" tone="gate" sub="any offer, not just top" />
        <path d="M418 345 h26" stroke="var(--color-slate-ink)" strokeWidth={1.3} markerEnd="url(#arrowhead)" opacity={0.8} />
        <Pill x={450} y={LANE.protocol} w={140} label="Hash-locked" sub="dual-signed mandate" />
        <path d="M594 345 h26" stroke="var(--color-slate-ink)" strokeWidth={1.3} markerEnd="url(#arrowhead)" opacity={0.8} />
        <Pill x={626} y={LANE.protocol} w={150} label="Razorpay order" tone="settle" sub="test-mode, real API" />

        {/* Ledger spine */}
        <rect x={8} y={404} width={864} height={24} rx={7} fill="var(--color-mist)" stroke="var(--color-line)" />
        <text x={440} y={420} textAnchor="middle" fontSize={10.5} fontWeight={600} className="fill-slate-ink">
          every step above appends to one hash-chained audit ledger — mutate any entry and every later hash breaks
        </text>
      </svg>
    </figure>
  );
}
