"use client";

import { useCallback, useEffect, useState } from "react";
import {
  acknowledgeDispatch,
  checkoutUrl,
  confirmSeller,
  rejectAsSeller,
  getBusinessOrders,
  listBusinesses,
  type Business,
  type Session,
} from "@/lib/api";
import { rupees } from "@/lib/format";

const IDENTITY_KEY = "mandate.merchant.id";

// The roster grows every time someone registers a vendor, and an unbounded
// list pushes the actual sign-in decision below the fold.
const PICKER_LIMIT = 3;
const CATALOG_PREVIEW = 3;
// A vendor that has won a lot has a very long page otherwise, and the orders
// that need acting on are the recent ones.
const ORDER_LIMIT = 3;

/** Where an order sits from the seller's point of view. */
function stage(
  s: Session
): "accept" | "awaiting_payment" | "paid" | "done" | "declined" | "other" {
  if (s.pending_seller_confirmation) return "accept";
  if (s.status === "rejected_by_seller") return "declined";
  if (s.status === "awaiting_payment") return "awaiting_payment";
  if (s.status === "settled") return s.seller_acknowledged ? "done" : "paid";
  return "other";
}

/** The same session, read from the buying side. */
function buyerStage(
  s: Session
): "waiting" | "pay" | "paid" | "declined" | "other" {
  if (s.pending_seller_confirmation) return "waiting";
  if (s.status === "rejected_by_seller") return "declined";
  if (s.status === "awaiting_payment") return "pay";
  if (s.status === "settled") return "paid";
  return "other";
}

const BUYER_STAGE_COPY: Record<string, { label: string; tone: string }> = {
  waiting: { label: "Waiting on the seller to accept", tone: "bg-lock/15 text-lock" },
  pay: { label: "Accepted — pay now", tone: "bg-counter/15 text-counter" },
  paid: { label: "Order confirmed", tone: "bg-settle/15 text-settle" },
  declined: {
    label: "Seller couldn't fulfil — pick another",
    tone: "bg-[color:var(--color-walk)]/12 text-[color:var(--color-walk)]",
  },
  other: { label: "Closed", tone: "bg-mist text-muted" },
};

const STAGE_COPY: Record<string, { label: string; tone: string }> = {
  accept: { label: "Needs your approval", tone: "bg-counter/15 text-counter" },
  awaiting_payment: { label: "Waiting on buyer payment", tone: "bg-lock/15 text-lock" },
  paid: { label: "Paid — confirm dispatch", tone: "bg-settle/15 text-settle" },
  done: { label: "Dispatched", tone: "bg-mist text-muted" },
  declined: {
    label: "You declined this",
    tone: "bg-[color:var(--color-walk)]/12 text-[color:var(--color-walk)]",
  },
  other: { label: "Closed", tone: "bg-mist text-muted" },
};

export default function MerchantConsole() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [orders, setOrders] = useState<Session[] | null>(null);
  // Deals where this vendor is the *buyer* — restocks it started on /try.
  const [purchases, setPurchases] = useState<Session[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showAllOrders, setShowAllOrders] = useState(false);

  // Newest registration first; the seeded three have no registration moment
  // and sort to the back, since they are the ones a returning visitor already
  // knows about.
  const sorted = [...businesses].sort(
    (a, b) => (b.registered_at ?? 0) - (a.registered_at ?? 0)
  );
  const visible = showAll ? sorted : sorted.slice(0, PICKER_LIMIT);

  useEffect(() => {
    listBusinesses().then(setBusinesses).catch(() => {});

    // `?as=<business_id>` signs straight in. The console links here that way
    // once a deal is done, so following a negotiation to its other side is one
    // click rather than "now go and find the right vendor in a list".
    const asParam = new URLSearchParams(window.location.search).get("as");
    if (asParam) {
      setMe(asParam);
      try {
        localStorage.setItem(IDENTITY_KEY, asParam);
      } catch {
        /* identity just won't persist */
      }
      // Drop the param so a refresh doesn't keep forcing an identity the user
      // may since have switched away from.
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    try {
      setMe(localStorage.getItem(IDENTITY_KEY));
    } catch {
      /* private window: just start signed out */
    }
  }, []);

  const refresh = useCallback(async (id: string) => {
    try {
      const res = await getBusinessOrders(id);
      // Newest first — a merchant cares about what just landed.
      const byRecency = (a: Session, b: Session) =>
        (b.created_at ?? 0) - (a.created_at ?? 0);
      setOrders([...res.as_seller].sort(byRecency));
      setPurchases([...res.as_buyer].sort(byRecency));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Poll while signed in, so an order the buyer just paid for appears without a
  // reload. A dashboard is the one place polling beats a stream: it has to
  // survive being left open across a backend restart.
  useEffect(() => {
    if (!me) return;
    refresh(me);
    const t = setInterval(() => refresh(me), 3000);
    return () => clearInterval(t);
  }, [me, refresh]);

  function signIn(id: string) {
    setOrders(null);
    setPurchases(null);
    setShowAllOrders(false);
    setMe(id);
    try {
      localStorage.setItem(IDENTITY_KEY, id);
    } catch {
      /* fine — identity just won't persist */
    }
  }

  function signOut() {
    setMe(null);
    setOrders(null);
    setPurchases(null);
    try {
      localStorage.removeItem(IDENTITY_KEY);
    } catch {
      /* nothing to clear */
    }
  }

  async function act(fn: () => Promise<unknown>, key: string, id: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const meName = businesses.find((b) => b.id === me)?.name ?? me;

  // Orders arrive newest-first. Cap the visible set, but say how many of the
  // hidden ones are actually waiting on this merchant — collapsing a list is
  // only safe if it cannot hide work.
  const visibleOrders = showAllOrders ? (orders ?? []) : (orders ?? []).slice(0, ORDER_LIMIT);
  const hiddenNeedingAction = (orders ?? [])
    .slice(ORDER_LIMIT)
    .filter((s) => stage(s) === "accept" || stage(s) === "paid").length;

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-20">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rzp-600">
          Merchant view
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink">
          Sign in as a merchant
        </h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-slate-ink">
          No password — the point is to let you stand on the other side of a deal
          you just negotiated. Pick the vendor whose orders you want to see.
        </p>

        <div className="mt-7 flex items-baseline justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {showAll ? `All ${sorted.length} vendors` : "Most recent"}
          </p>
          {sorted.length > PICKER_LIMIT && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="text-[12.5px] font-medium text-rzp-600 transition hover:text-rzp-500"
            >
              {showAll
                ? "Show fewer"
                : `View all ${sorted.length} →`}
            </button>
          )}
        </div>

        <div className="mt-2 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
          {visible.map((b, i) => {
            // Newest first, so the vendor someone just created on /vendors is
            // the first thing they see here — that is almost always the one
            // they came to sign in as.
            const isNewest = i === 0 && !showAll && b.registered_at !== null;
            return (
              <button
                key={b.id}
                onClick={() => signIn(b.id)}
                className={`p-5 text-left transition ${
                  isNewest ? "bg-rzp-50 hover:bg-rzp-100" : "bg-white hover:bg-rzp-50"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-display text-[15px] font-semibold text-ink">
                    {b.name}
                  </p>
                  {isNewest && (
                    <span className="shrink-0 rounded-full bg-rzp-500 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-white">
                      Just added
                    </span>
                  )}
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-muted">{b.id}</p>

                {/* The catalog is what tells you which vendor this is — two
                    vendors with similar names are told apart by what they
                    stock and at what price. */}
                <ul className="mt-2.5 space-y-0.5">
                  {b.catalog.slice(0, CATALOG_PREVIEW).map((item) => (
                    <li
                      key={item.sku}
                      className="flex justify-between gap-3 text-[12px] text-slate-ink"
                    >
                      <span className="truncate">{item.name}</span>
                      <span className="shrink-0 font-mono tabular-nums text-muted">
                        {rupees(item.list_price)}
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="mt-2.5 text-[11.5px] text-muted">
                  {b.catalog.length} SKU{b.catalog.length === 1 ? "" : "s"}
                  {b.catalog.length > CATALOG_PREVIEW &&
                    ` · +${b.catalog.length - CATALOG_PREVIEW} more`}
                  {" · "}
                  {b.margin_floor_pct}% floor
                </p>
              </button>
            );
          })}
          {/* The grid paints its gaps with the border colour, so an odd count
              would leave the trailing cell showing as a grey block. */}
          {visible.length % 2 === 1 && (
            <div className="hidden bg-white sm:block" aria-hidden />
          )}
        </div>

        {businesses.length === 0 && (
          <p className="mt-6 text-[13px] text-muted">
            No vendors registered yet — add one on the Vendors page.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-14">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rzp-600">
            Merchant view
          </p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-ink">
            {meName}
          </h1>
        </div>
        <button
          onClick={signOut}
          className="rounded-full border border-line px-4 py-2 text-[13px] font-medium text-slate-ink transition hover:border-rzp-300 hover:text-ink"
        >
          Switch merchant
        </button>
      </div>

      {error && (
        <p className="mt-5 rounded-xl border border-walk/40 bg-walk/5 px-4 py-3 text-[13px] text-walk">
          {error}
        </p>
      )}

      {orders === null && <p className="mt-8 text-[13.5px] text-muted">Loading orders…</p>}

      {purchases && purchases.length > 0 && (
        <section className="mt-8">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Buying — {purchases.length} restock
            {purchases.length === 1 ? "" : "s"} you started
          </p>
          <div className="mt-3 space-y-4">
            {purchases.slice(0, ORDER_LIMIT).map((s) => {
              const st = buyerStage(s);
              const copy = BUYER_STAGE_COPY[st];
              const cart = s.final_cart;
              const amount = s.payment_mandate?.amount ?? cart?.total_price ?? null;
              const seller = s.seller_business_id;
              return (
                <div key={s.id} className="rounded-2xl border border-line bg-mist/40 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${copy.tone}`}
                    >
                      {copy.label}
                    </span>
                    <span className="font-mono text-[10.5px] text-muted">{s.id}</span>
                  </div>
                  <p className="mt-3 text-[14.5px] text-ink">{s.intent.goal}</p>
                  {seller && (
                    <p className="mt-1 text-[12.5px] text-slate-ink">
                      from <span className="font-medium text-ink">{seller}</span>
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-3">
                    <span className="font-display text-[19px] font-semibold text-ink">
                      {rupees(amount)}
                    </span>
                    {st === "pay" && (
                      <a
                        href={checkoutUrl(s.id)}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded-full bg-rzp-500 px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-rzp-600"
                      >
                        Pay now
                      </a>
                    )}
                    {st === "waiting" && (
                      <span className="text-[12.5px] text-muted">
                        Nothing is charged until they confirm they can ship it.
                      </span>
                    )}
                    {st === "declined" && (
                      <span className="text-[12.5px] text-muted">
                        Nothing was charged. The other vendors&apos; offers are
                        still settleable on Try it.
                      </span>
                    )}
                    {st === "paid" && (
                      <span className="text-[12.5px] font-medium text-settle">
                        Paid · {s.razorpay_payment_id ?? "settled"}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {purchases.length > ORDER_LIMIT && (
            <p className="mt-2 text-[12px] text-muted">
              +{purchases.length - ORDER_LIMIT} older restock
              {purchases.length - ORDER_LIMIT === 1 ? "" : "s"}
            </p>
          )}
        </section>
      )}

      {orders?.length === 0 && (
        <div className="mt-8 rounded-2xl border border-dashed border-line p-8 text-center">
          <p className="text-[14px] font-medium text-ink">
            {purchases && purchases.length > 0
              ? "Nothing sold yet"
              : "Nothing won yet"}
          </p>
          <p className="mt-1.5 text-[13px] text-slate-ink">
            Run a negotiation on Try it. If this vendor wins, the order lands here
            for you to approve.
          </p>
        </div>
      )}

      {orders && orders.length > 0 && (
        <div className="mt-8 flex items-baseline justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Selling ·{" "}
            {showAllOrders
              ? `all ${orders.length}`
              : `latest ${Math.min(ORDER_LIMIT, orders.length)} of ${orders.length}`}
          </p>
          {orders.length > ORDER_LIMIT && (
            <button
              onClick={() => setShowAllOrders((v) => !v)}
              className="text-[12.5px] font-medium text-rzp-600 transition hover:text-rzp-500"
            >
              {showAllOrders
                ? "Show fewer"
                : hiddenNeedingAction > 0
                  ? `View all ${orders.length} · ${hiddenNeedingAction} more need you →`
                  : `View all ${orders.length} →`}
            </button>
          )}
        </div>
      )}

      <div className="mt-3 space-y-4">
        {visibleOrders.map((s, orderIndex) => {
          const st = stage(s);
          const copy = STAGE_COPY[st];
          const cart = s.final_cart;
          const amount = s.payment_mandate?.amount ?? cart?.total_price ?? null;
          const isNewest = orderIndex === 0 && !showAllOrders;
          return (
            <div
              key={s.id}
              className={`rounded-2xl border bg-white p-5 ${
                isNewest ? "border-rzp-300 ring-1 ring-rzp-100" : "border-line"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${copy.tone}`}
                >
                  {copy.label}
                </span>
                <span className="flex items-center gap-2 font-mono text-[10.5px] text-muted">
                  {isNewest && (
                    <span className="rounded-full bg-rzp-500 px-2 py-0.5 font-sans text-[9.5px] font-semibold uppercase tracking-wider text-white">
                      Latest
                    </span>
                  )}
                  {s.id}
                </span>
              </div>

              <p className="mt-3 text-[14.5px] text-ink">{s.intent.goal}</p>

              {cart && (
                <ul className="mt-3 space-y-1 border-t border-line/70 pt-3">
                  {cart.items.map((i) => (
                    <li
                      key={i.sku}
                      className="flex justify-between text-[13px] text-slate-ink"
                    >
                      <span>
                        {i.qty} × {i.name}
                      </span>
                      <span className="font-mono tabular-nums">{rupees(i.line_total)}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-3">
                <div className="text-[13px] text-slate-ink">
                  <span className="font-display text-[19px] font-semibold text-ink">
                    {rupees(amount)}
                  </span>
                  {s.margin_pct !== null && s.margin_pct !== undefined && (
                    <span className="ml-2 text-muted">
                      {s.margin_pct}% margin
                      {s.margin_floor_pct !== null &&
                        s.margin_floor_pct !== undefined &&
                        ` · your floor ${s.margin_floor_pct}%`}
                    </span>
                  )}
                </div>

                {st === "accept" && (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Declining is the reason a merchant is asked at all: it
                        may genuinely be out of stock, and "accept" alone gives
                        it no way to say so. */}
                    <button
                      onClick={() => act(() => rejectAsSeller(s.id, me), s.id, me)}
                      disabled={busy === s.id}
                      className="rounded-full border border-line px-4 py-2.5 text-[13px] font-medium text-muted transition hover:border-[color:var(--color-walk)] hover:text-[color:var(--color-walk)] disabled:opacity-40"
                    >
                      Can&apos;t fulfil
                    </button>
                    <button
                      onClick={() => act(() => confirmSeller(s.id), s.id, me)}
                      disabled={busy === s.id}
                      className="rounded-full bg-ink px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-ink-600 disabled:opacity-50"
                    >
                      {busy === s.id ? "Accepting…" : "Accept this order"}
                    </button>
                  </div>
                )}

                {st === "declined" && (
                  <span className="text-[12.5px] text-muted">
                    Recorded in the trail. The buyer can still take another
                    vendor&apos;s offer.
                  </span>
                )}

                {st === "awaiting_payment" && (
                  <a
                    href={checkoutUrl(s.id)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded-full border border-line px-5 py-2.5 text-[13px] font-semibold text-slate-ink transition hover:border-rzp-300 hover:text-ink"
                  >
                    Open the buyer&apos;s payment page
                  </a>
                )}

                {st === "paid" && (
                  <button
                    onClick={() => act(() => acknowledgeDispatch(s.id, me), s.id, me)}
                    disabled={busy === s.id}
                    className="rounded-full bg-settle px-5 py-2.5 text-[13px] font-semibold text-white transition hover:brightness-95 disabled:opacity-50"
                  >
                    {busy === s.id ? "Confirming…" : "Payment received — confirm dispatch"}
                  </button>
                )}

                {st === "done" && (
                  <span className="text-[12.5px] font-medium text-settle">
                    Confirmed · {s.razorpay_payment_id ?? "paid"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
