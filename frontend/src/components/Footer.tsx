import Link from "next/link";
import BrandMark, { RazorpayWordmark } from "@/components/BrandMark";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Try it", href: "/try" },
      { label: "Merchant view", href: "/merchant" },
      { label: "Vendors", href: "/vendors" },
      { label: "Engineering notes", href: "/developers" },
    ],
  },
  {
    heading: "For AI buyers",
    links: [
      { label: "Agent card", href: "http://localhost:8000/.well-known/agent-card.json" },
      { label: "Catalog search", href: "http://localhost:8000/agent/catalog/search?q=keyboard" },
      { label: "Razorpay Docs", href: "https://razorpay.com/docs/" },
    ],
  },
  {
    heading: "Built with",
    links: [
      { label: "Razorpay Payments", href: "https://razorpay.com/" },
      { label: "Next.js", href: "https://nextjs.org/" },
      { label: "React Three Fiber", href: "https://r3f.docs.pmnd.rs/" },
    ],
  },
];

function isExternal(href: string) {
  return href.startsWith("http");
}

export default function Footer() {
  return (
    <footer className="border-t border-line/70 bg-surface">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-[1.6fr_repeat(3,1fr)]">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2.5">
              <BrandMark size={24} />
              <span className="font-display text-[15px] font-semibold tracking-tight text-ink">
                Mandate
              </span>
            </div>
            <p className="mt-4 max-w-xs text-[14px] leading-relaxed text-slate-ink">
              A working demonstration of agent-to-agent purchasing with real
              limits, a verifiable record, and settlement on Razorpay.
            </p>
            <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-[11px] font-medium text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-settle" />
              Test mode · no real funds move
            </p>
          </div>

          {COLUMNS.map((col) => (
            <nav key={col.heading} aria-label={col.heading}>
              <h2 className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
                {col.heading}
              </h2>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    {isExternal(link.href) ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[14px] text-slate-ink transition-colors hover:text-rzp-600"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-[14px] text-slate-ink transition-colors hover:text-rzp-600"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-line pt-7 text-[13px] text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} Mandate — built by{" "}
            <span className="font-medium text-slate-ink">Dev Chalana</span>.
          </p>
          <p>
            Not affiliated with{" "}
            {/* Inline-flex, no gap: a flex gap would put a space before the
                full stop that follows. */}
            <span className="inline-flex translate-y-px items-center align-middle">
              <RazorpayWordmark height={11} />
            </span>
            . Built on their publicly documented test-mode APIs.
          </p>
        </div>
      </div>
    </footer>
  );
}
