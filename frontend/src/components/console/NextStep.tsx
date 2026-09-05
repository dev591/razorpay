"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getSession, listBusinesses, type Business } from "@/lib/api";

/**
 * Where to go once the agents have agreed.
 *
 * A negotiation ends with a deal that two different parties now have to act
 * on, and the console is only ever one of them. Without this the reviewer has
 * to work out on their own that the story continues on `/merchant`, and then
 * which of seven vendors to sign in as. Both ids are read back from the
 * session rather than from local form state, so a human override on the offer
 * board sends you to the vendor that actually won.
 */
export default function NextStep({
  sessionId,
  gated,
  refreshKey = 0,
}: {
  sessionId: string;
  gated: boolean;
  /** Changes when the human takes a different offer, so the card re-reads who
   *  actually won rather than pointing at the vendor the scorer recommended. */
  refreshKey?: number;
}) {
  const [buyerId, setBuyerId] = useState<string | null>(null);
  const [sellerId, setSellerId] = useState<string | null>(null);
  const [vendors, setVendors] = useState<Business[]>([]);

  useEffect(() => {
    listBusinesses().then(setVendors).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSession(sessionId)
      .then((s) => {
        if (cancelled) return;
        setSellerId(s.seller_business_id ?? null);
        // "buyer_agent" is the standalone buyer, which has no merchant page.
        const buyer = s.buyer_business_id;
        setBuyerId(buyer && buyer !== "buyer_agent" ? buyer : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, gated, refreshKey]);

  const nameOf = (id: string) => vendors.find((v) => v.id === id)?.name ?? id;

  if (!sellerId) return null;

  return (
    <div className="rounded-2xl border border-rzp-200 bg-rzp-50 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-rzp-600">
        See the other side of this deal
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-ink">
        {gated ? (
          <>
            The order is waiting on{" "}
            <strong className="font-semibold text-ink">{nameOf(sellerId)}</strong> to
            confirm they can ship it. Sign in as them to accept
            {buyerId ? ", then come back as the buyer to pay." : "."}
          </>
        ) : (
          <>
            The cart is locked and the order is created. Sign in as either party
            to carry it through.
          </>
        )}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href={`/merchant?as=${encodeURIComponent(sellerId)}`}
          className="rounded-full bg-rzp-500 px-4 py-2 text-[12.5px] font-semibold text-white transition hover:bg-rzp-600"
        >
          {gated ? "Accept as" : "Open as"} {nameOf(sellerId)} →
        </Link>
        {buyerId && (
          <Link
            href={`/merchant?as=${encodeURIComponent(buyerId)}`}
            className="rounded-full border border-rzp-300 bg-white px-4 py-2 text-[12.5px] font-semibold text-rzp-600 transition hover:border-rzp-400"
          >
            Open as {nameOf(buyerId)} (buyer) →
          </Link>
        )}
      </div>
      {!buyerId && (
        <p className="mt-2.5 text-[11.5px] text-muted">
          This run bought as a standalone agent, so there is no buyer-side page.
          Pick a vendor under &ldquo;Buying as&rdquo; to see both halves.
        </p>
      )}
    </div>
  );
}
