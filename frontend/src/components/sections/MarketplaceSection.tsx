"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import {
  listBusinesses,
  registerBusiness,
  searchCatalog,
  type Business,
  type CatalogHit,
} from "@/lib/api";
import { rupees } from "@/lib/format";

/**
 * The supply side, made concrete and editable.
 *
 * These are the exact vendors the console negotiates against — not an
 * illustration of them. Anyone can add a merchant with their own catalog and
 * margin floor and immediately watch it bid in the next run, which is the
 * fastest way to show that the floor is a real constraint rather than
 * decoration: set it high and the vendor prices itself out; set it low and it
 * wins on price but has almost nothing left to concede.
 */

type Draft = {
  name: string;
  margin_floor_pct: string;
  catalog: { name: string; price: string }[];
};

const EMPTY_DRAFT: Draft = {
  name: "",
  margin_floor_pct: "15",
  catalog: [{ name: "", price: "" }],
};

function VendorCard({ business, index }: { business: Business; index: number }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.45, delay: reduceMotion ? 0 : index * 0.06 }}
      className="flex flex-col rounded-2xl border border-line bg-white p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-[16px] font-bold text-ink">{business.name}</h3>
        <span
          className="shrink-0 rounded-full bg-rzp-50 px-2.5 py-1 text-[11px] font-semibold text-rzp-700"
          title="The vendor's agent may never price below this margin — enforced in code, not in a prompt."
        >
          {business.margin_floor_pct}% floor
        </span>
      </div>

      <dl className="mt-4 flex-1 space-y-1.5">
        {business.catalog.map((item) => (
          <div key={item.sku} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 truncate text-[13px] text-slate-ink">{item.name}</dt>
            {/* Both numbers, labelled. Showing one of them unlabelled is what
                made the same SKU look like two different prices between this
                card and the catalog search below it. */}
            {/* `?? item.price` is load-bearing: a backend that predates the
                cost/list_price split returns only `price`, and reading a
                missing field straight into `toLocaleString` crashed the whole
                section rather than degrading. */}
            <dd className="shrink-0 text-right">
              <span className="text-[13px] font-medium tabular-nums text-ink">
                {rupees(item.list_price ?? item.price)}
              </span>
              <span className="ml-1.5 text-[11px] tabular-nums text-muted">
                cost {rupees(item.cost ?? item.price)}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 border-t border-line/70 pt-3 font-mono text-[10.5px] text-muted">
        {business.id} · {business.catalog.length} SKUs
      </p>
    </motion.div>
  );
}

/**
 * The same catalog endpoint an AI buyer would call, wired to a search box.
 *
 * Discovery is the half of "agent-readable" that is easy to claim and hard to
 * show. An outside agent reads `/.well-known/agent-card.json` to learn what
 * this merchant sells and what it will agree to, then queries one indexed
 * endpoint across every vendor — rather than scraping a storefront or pulling
 * the whole catalog to filter client-side.
 */
function AgentCatalog() {
  const reduceMotion = useReducedMotion();
  const [query, setQuery] = useState("mechanical keyboard");
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Debounced: this is a real index lookup per keystroke otherwise.
    const timer = setTimeout(() => {
      searchCatalog(query, 5)
        .then((res) => {
          if (cancelled) return;
          setHits(res.results);
          setFailed(false);
        })
        .catch(() => !cancelled && setFailed(true));
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="rounded-3xl border border-line bg-mist/50 p-5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        What an AI buyer sees
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-ink">
        One query across every vendor above, cheapest first — the same endpoint
        an outside agent calls.
      </p>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search the catalog…"
        className="mt-3 w-full rounded-xl border border-line bg-white px-4 py-2.5 font-mono text-[13px] text-ink outline-none transition focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100"
      />
      <div className="mt-2.5 space-y-1.5">
        <AnimatePresence mode="popLayout" initial={false}>
          {hits.map((hit, i) => (
            <motion.div
              key={`${hit.business_id}-${hit.sku}`}
              layout={!reduceMotion}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0 }}
              transition={{ duration: 0.2, delay: reduceMotion ? 0 : i * 0.03 }}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white px-3.5 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-[12.5px] font-medium text-ink">{hit.name}</p>
                <p className="truncate font-mono text-[10px] text-muted">
                  {hit.business_name} · {hit.sku}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-display text-[13.5px] font-bold tabular-nums text-ink">
                  {rupees(hit.list_price)}
                </p>
                {i === 0 && hits.length > 1 && (
                  <p className="text-[9.5px] font-semibold uppercase tracking-wider text-[color:var(--color-settle)]">
                    best price
                  </p>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {hits.length === 0 && (
          <p className="py-5 text-center text-[12.5px] text-muted">
            {failed ? "Backend unreachable." : "No matching SKUs."}
          </p>
        )}
      </div>
      <div className="mt-3 space-y-1 border-t border-line/70 pt-3">
        {[
          ["/.well-known/agent-card.json", "capabilities, bounds, endpoints"],
          ["/agent/catalog/search?q=", "inverted index"],
          ["/agent/catalog/complete?prefix=", "trie completion"],
        ].map(([path, note]) => (
          <div key={path} className="flex flex-wrap items-baseline gap-x-2">
            <code className="font-mono text-[10.5px] text-ink">{path}</code>
            <span className="text-[10.5px] text-muted">{note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MarketplaceSection() {
  const reduceMotion = useReducedMotion();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    listBusinesses()
      .then(setBusinesses)
      .catch(() => setError("Backend unreachable — start the API to see live vendors."));

  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    setError(null);
    const name = draft.name.trim();
    const floor = Number(draft.margin_floor_pct);
    const catalog = draft.catalog
      .map((c) => ({ name: c.name.trim(), price: Number(c.price) }))
      .filter((c) => c.name && Number.isFinite(c.price) && c.price > 0);

    // Validated here as well as server-side: a rejection that arrives as a
    // 400 after a round trip reads as a bug, where an inline message reads as
    // a form. The server check is the real one.
    if (!name) return setError("Give the vendor a name.");
    if (!catalog.length) return setError("Add at least one item with a price above zero.");
    // Mirrors MIN/MAX_MARGIN_FLOOR_PCT in agents/businesses.py. Claiming a
    // wider range here just produced a server rejection after a round trip.
    if (!Number.isFinite(floor) || floor < 5 || floor > 40)
      return setError("Margin floor must be between 5 and 40%.");

    setBusy(true);
    try {
      await registerBusiness({ name, catalog, margin_floor_pct: floor });
      await load();
      setDraft(EMPTY_DRAFT);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message.replace(/^\/businesses failed: \d+\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const setItem = (i: number, patch: Partial<{ name: string; price: string }>) =>
    setDraft((d) => ({
      ...d,
      catalog: d.catalog.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));

  return (
    <section id="marketplace" className="scroll-mt-24 bg-white px-6 py-20">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rzp-600">
              The supply side
            </p>
            <h2 className="mt-3 max-w-xl font-display text-3xl font-extrabold leading-[1.1] tracking-tight text-ink sm:text-4xl">
              Every vendor the buyer agent bids against.
            </h2>
            <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-slate-ink">
              Each one runs its own agent with its own catalog and its own
              margin floor. Add yours and it joins the next negotiation — set
              the floor high and watch it price itself out of the deal.
            </p>
          </div>
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded-full bg-ink px-5 py-2.5 text-[13.5px] font-semibold text-white transition hover:bg-ink-600"
          >
            {open ? "Cancel" : "Add a vendor"}
          </button>
        </div>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
            >
              <div className="mt-6 rounded-3xl border border-line bg-mist/50 p-5">
                <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Vendor name
                    </label>
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="Nimbus Traders"
                      className="mt-1 w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-[13.5px] text-ink outline-none focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Margin floor %
                    </label>
                    <input
                      type="number"
                      value={draft.margin_floor_pct}
                      onChange={(e) =>
                        setDraft({ ...draft, margin_floor_pct: e.target.value })
                      }
                      className="mt-1 w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-[13.5px] tabular-nums text-ink outline-none focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100"
                    />
                  </div>
                </div>

                <p className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Catalog
                </p>
                <div className="mt-1.5 space-y-2">
                  {draft.catalog.map((item, i) => (
                    <div key={i} className="grid gap-2 sm:grid-cols-[1fr_160px_auto]">
                      <input
                        value={item.name}
                        onChange={(e) => setItem(i, { name: e.target.value })}
                        placeholder="Wireless Mouse"
                        className="rounded-xl border border-line bg-white px-3.5 py-2.5 text-[13.5px] text-ink outline-none focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100"
                      />
                      <input
                        type="number"
                        value={item.price}
                        onChange={(e) => setItem(i, { price: e.target.value })}
                        placeholder="Your unit cost"
                        className="rounded-xl border border-line bg-white px-3.5 py-2.5 text-[13.5px] tabular-nums text-ink outline-none focus:border-rzp-400 focus:ring-4 focus:ring-rzp-100"
                      />
                      <button
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            catalog: d.catalog.filter((_, j) => j !== i),
                          }))
                        }
                        disabled={draft.catalog.length === 1}
                        className="rounded-xl border border-line px-3 text-[13px] text-muted transition hover:border-[color:var(--color-walk)]/40 hover:text-[color:var(--color-walk)] disabled:opacity-30"
                        aria-label="Remove item"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        catalog: [...d.catalog, { name: "", price: "" }],
                      }))
                    }
                    className="text-[12.5px] font-medium text-rzp-600 transition hover:text-rzp-500"
                  >
                    + Add item
                  </button>
                  <button
                    onClick={submit}
                    disabled={busy}
                    className="ml-auto rounded-full bg-rzp-500 px-5 py-2.5 text-[13.5px] font-semibold text-white transition hover:bg-rzp-600 disabled:opacity-50"
                  >
                    {busy ? "Registering…" : "Register vendor"}
                  </button>
                </div>

                {error && (
                  <p className="mt-3 text-[12.5px] text-[color:var(--color-walk)]">{error}</p>
                )}
                <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
                  Enter what each item <strong>costs you</strong>; the shelf
                  price is derived from it. The margin floor (5–40%) is the
                  least this vendor will ever accept — enforced in code before
                  any offer reaches the buyer, so setting it high genuinely
                  prices you out of deals.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence initial={false}>
            {businesses.map((business, i) => (
              <VendorCard key={business.id} business={business} index={i} />
            ))}
          </AnimatePresence>
        </div>

        <div className="mt-6">
          <AgentCatalog />
        </div>

        {businesses.length === 0 && (
          <p className="mt-8 rounded-2xl border border-line bg-mist/50 p-8 text-center text-[13px] text-muted">
            {error ?? "Loading vendors…"}
          </p>
        )}
      </div>
    </section>
  );
}
