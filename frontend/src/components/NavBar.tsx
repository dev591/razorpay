"use client";

import Link from "next/link";
import BrandMark, { RazorpayWordmark } from "@/components/BrandMark";
import { useEffect, useState } from "react";

// Every feature now lives on its own route; the landing page only explains.
const routes = [
  { label: "Try it", href: "/try" },
  { label: "Merchant", href: "/merchant" },
  { label: "Vendors", href: "/vendors" },
  { label: "Engineering", href: "/developers" },
];

export default function NavBar() {
  // Sits flush and borderless over the hero's aurora, then picks up a
  // hairline and a frosted ground once content scrolls beneath it.
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-all duration-300 ${
        scrolled
          ? "border-b border-line/70 bg-white/75 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="group flex items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-rzp-500"
        >
          <BrandMark size={22} />
          <span className="font-display text-[15px] font-semibold tracking-tight text-ink">
            Mandate
          </span>
          <span className="hidden items-center gap-1.5 sm:flex">
            <span className="h-3.5 w-px bg-line" />
            <span className="text-[11px] font-medium text-muted">for</span>
            <RazorpayWordmark height={11} />
          </span>
        </Link>

        <nav className="hidden items-center gap-7 lg:flex">
          {routes.map((route) => (
            <Link
              key={route.href}
              href={route.href}
              className="rounded-sm text-sm text-slate-ink transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-rzp-500"
            >
              {route.label}
            </Link>
          ))}
        </nav>

        <Link
          href="/try"
          className="inline-flex items-center gap-1.5 rounded-full bg-rzp-500 px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_20px_-8px_rgba(48,94,255,0.8)] transition-all hover:-translate-y-0.5 hover:bg-rzp-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rzp-500"
        >
          Try it live
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path
              d="m9 6 6 6-6 6"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      </div>
    </header>
  );
}
