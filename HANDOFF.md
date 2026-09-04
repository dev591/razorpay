# Mandate — handoff state

Built by **Dev Chalana**.

**Last updated:** end of session. Both servers were running: backend `:8000`, frontend `:3000`.

## Run it

```bash
# backend  (from /Volumes/dev/razorpay/backend)
.venv/bin/python -m uvicorn main:app --port 8000

# frontend (from /Volumes/dev/razorpay/frontend)
npx next dev -p 3000
```

Needs `backend/.env` with `OPENAI_API_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.

## Current routes

| Route | What it is |
|---|---|
| `/` | Hero + how it works + the guarantees + live numbers + CTA. **Explains only — no app.** |
| `/try` | The console: intent composer, approval gate, vendor race, offer board, settlement |
| `/vendors` | Vendor list, add-vendor, agent catalog search |
| `/developers` | Engineering notes (diagrams, scalability, unit economics) |

`/console`, `/marketplace`, `/playground`, `/dashboard` were removed.

## Done — the landing-page split

The features are off the landing page. `/` now runs `Hero` → `HowItWorks` →
`Guarantees` (which carries `LiveNumbers`) → `ClosingCTA`. Nav and footer point
at `/try` and `/vendors`; no `/#try` or `/#marketplace` anchors remain.
`next build` is clean and all four routes return 200.

New files: `sections/HowItWorks.tsx`, `sections/Guarantees.tsx`,
`sections/ClosingCTA.tsx`, `ui/NumberField.tsx`.

**Copy on the landing page is load-bearing.** Every claim in `Guarantees` and
`HowItWorks` names a real mechanism (`protocol/pricing.py`, the approval gate,
the hash lock, the fallback path). If one of those changes, the copy is wrong —
it is not marketing filler.

## Branding — real Razorpay assets

`public/razorpay-logo.png` (full lockup), `razorpay-mark.png` (icon),
`razorpay-wordmark.png` (icon-free). The source download had its transparency
flattened into a literal grey checkerboard, so the alpha was rebuilt by keying
out neutral-bright pixels. `BrandMark` renders the icon; `RazorpayWordmark`
renders the **icon-free** wordmark, because the two sit side by side in the
nav and the full lockup would show the same mark twice.

## Tab identity

`src/app/icon.png` + `apple-icon.png` + `favicon.ico` are the Razorpay mark as a
white silhouette on a #3395FF rounded tile — the two-tone mark reads as mud at
16px. Titles use a `%s — Mandate` template in `layout.tsx`, so each page sets
only its own leaf ("Try it", "Vendors", "Engineering notes").

## Also fixed

**Number inputs could not be cleared.** Budget/units/lead-time bound a number
straight to `value`, so any clearing keystroke became `Number("") === 0`, the
box re-rendered as "0", and the next digits landed after it — "035000".
`ui/NumberField.tsx` holds the raw string and lifts only a parsed number, so an
empty box stays empty while you retype; presets still overwrite it, and blur on
an empty field restores the last good value. Use it for every numeric input.

## Shortlist gate — bounds spend, not just time

`orchestrator/shortlist.py` gates the marketplace fan-out **before** it happens.
Negotiation is ~9 model calls per vendor, so broadcasting to everyone makes one
purchase cost O(vendors). `top_k_offers` in `ds/ranking.py` ranks *after* the
spend and never bounded anything — its docstring claimed otherwise; that claim
is now true of the shortlist instead.

- Key is `min_sellable_price(cost, floor) x qty_min` — a **provable** lower
  bound on any cart that vendor could sign. **Never rank on list price**: it
  orders who starts cheap, not who ends cheap.
- `verify_admissible` re-checks after the winner is known and writes
  `marketplace.shortlist_admissible` to the ledger — including when it fails.
  A shortlist that skipped a cheaper vendor is a fact the buyer is owed.
- One slot is reserved for the vendor with the fewest orders. Greedy top-k means
  the same k merchants win forever, which is an anti-feature for a merchant
  growth platform.
- **`SHORTLIST_K = 3`, and the gate is live.** It was originally set to 8 so it
  never engaged at demo scale; that hid the whole point. With 6 vendors it now
  reports `considered 6 -> negotiating 3, eliminated 3` with each vendor's floor
  bound and reason, and the saved spend (`~36 model calls · ₹0.63`, measured
  from `economics.cost_per_vendor()` once any session has been metered).
- **`EXPLORE_SLOTS = 0` by default**, so the shortlist is exactly "the k
  cheapest achievable" and a reader comparing bounds to the selection sees them
  agree. Exploration is implemented and tested — turn it up to stop the same k
  merchants winning every auction, which matters for the merchant-growth half of
  the brief.
- Surfaced in the console by `ShortlistPanel`.

## Multi-item baskets

`IntentMandate.requested_lines` — a list of `{name, qty}`. Empty keeps the old
"anything in the quantity band" behaviour, so every existing caller is
unaffected.

- **It is inside the signature.** Signing budget/qty/terms but not the goods
  would let an approved mandate settle against a different basket.
- **Matched on item name, case-folded, never SKU.** Each vendor sells the same
  goods under its own SKU code, so SKU equality fails for every vendor but one.
- **`buyer_agent.basket_shortfall` is the enforcement**, sitting with the budget
  and lead-time checks. The merchant prompt states the requirement; nothing
  depends on the model obeying it. The upsell line is excluded deliberately —
  an extra the merchant attached cannot count toward what the buyer asked for.
- **The fallback honours it too** (`agents/fallback.py`): requested lines drive
  selection, and the budget trim will not cut below a named quantity.
- **`check_basket_affordable`** rejects an unaffordable basket up front with the
  arithmetic. The old `check_budget_feasible` (qty_min x cheapest item) is far
  too weak once goods are named — 20 keyboards cost what 80 mice do.
- **The shortlist bound tightens** to the basket's own floor total; a vendor
  missing any line is `cannot_fill_basket`, not merely expensive.

UI is free-text rows with `+ Add item` (matching the add-vendor catalog editor),
deliberately not a dropdown. Blank rows are dropped on submit rather than
blocking the button. `httpError` in `lib/api.ts` now unwraps FastAPI's `detail`,
because these validation messages are ones the user is meant to act on.

## Merchant view — `/merchant`

Credential-free identity switch (pick a vendor; kept in `localStorage`). Shows
everything that vendor won, with the seller-side action for each stage:

| Stage | Action |
|---|---|
| `pending_seller_confirmation` | **Accept this order** -> `confirm-seller` |
| `awaiting_payment` | link to the buyer's Razorpay checkout |
| `settled`, not acknowledged | **Payment received — confirm dispatch** |
| acknowledged | shows the payment id |

`POST /sessions/{id}/acknowledge` is a **real recorded action**, not a UI
flourish — it appends `seller.dispatch_acknowledged` to the hash chain. Guarded:
wrong vendor is rejected, and acknowledging before `settled` is rejected.
Polls every 3s rather than streaming, because this page has to survive being
left open across a backend restart.

**Every deal now parks for the seller**, not just near-floor ones. The old
behaviour optimised the wrong risk: the agent negotiates against a catalog, and
a catalog is a claim about stock, not a fact. `_finalize_or_flag` no longer
branches; `near_floor` is still computed and recorded as the *reason*, so the
trail distinguishes "confirm you can ship this" from "this one is thin".
Verified with a synthetic 45% margin cart (far outside the 3pp buffer): it
parks. The audit event is now `seller.confirmed`, renamed from
`seller_confirmed_edge_case` — it is no longer an edge case.

The buyer console's gated panel says so and links to `/merchant`.

## Bug fixed: parked deals died on restart

`_pending_confirmations` is in-memory, and `confirm_seller` treated it as the
only truth — so every deal parked before a restart was **permanently
unconfirmable** ("no pending cart found"). 274 sessions were stuck this way; the
merchant view is what made it visible.

`_rehydrate_pending` now rebuilds the `CartMandate` from the cart already
persisted on the session. Verified on real rows: the rebuilt cart reproduces the
**identical cart hash and signature**, because both are functions of field
values, not object identity. The old comment claiming JSON "cannot round-trip"
a CartMandate was wrong.

Deals parked before carts were persisted at all (256 of them) stay unrecoverable
and now say so plainly instead of blaming a restart.

**`_pending_intents` and `_converged_offers` have the same fragility** and are
not fixed — approving an intent or selecting a runner-up offer across a restart
still fails. Same rehydration approach would work.

## Failure injection — the judged "one failure handled gracefully"

`POST /chaos/model-outage {"enabled": true}` / the **Break the model** button in
the console. Breaks `call_with_retry` itself, so the retry budget, backoff,
rule-based quoting and `degraded` labelling all run for real — it does **not**
short-circuit to the fallback, which would demonstrate nothing. Self-expires
after 5 minutes so it can't be left on.

Verified with the model fully dead: 5 vendors degraded at round 1, winner
selected, real Razorpay order created, margin 14% against an 8% floor, chain
valid, every cart flagged.

## Clean clone now actually works

`backend/requirements.txt` added (there was none — this alone blocked a clone).
Verified: fresh venv, `pip install -r requirements.txt`, `uvicorn main:app`
boots and serves. `README.md` written and its instructions tested as written.

## Before/after price on every vendor card

`list_price_subtotal(cart, business)` in `orchestrator/marketplace.py` prices the
**identical basket** — same SKUs, same quantities, upsell line included — at the
vendor's `list_price`. Shown struck through above the negotiated total on every
vendor card and on the offer board, with the rupee and percent saved.

Three rules that keep it honest, and they matter:

- **Goods only, both sides.** Freight tracks the promised ETA, not the
  haggling; folding it in would flatter the saving.
- **Upsell included in both.** `goods_subtotal` carries the upsell, so a
  baseline without it would invent a saving that never happened.
- **Only once the vendor has settled** (`agreedPrice !== null`), and only when
  the gap is positive. A missing `list_price` returns None and renders nothing —
  an unknown baseline must never read as zero.

## Checkout confirmation

The Razorpay checkout page used to print "Payment captured" off a bare
`.then()` — **including when the signature failed to verify**, because
`payment-callback` answers 200 for every outcome and puts the result in the
session's `status`. It now branches on that status: `settled` shows the amount,
payment id, order id and that the merchant confirms dispatch next;
`payment_signature_invalid` and `payment_capture_failed` each say what actually
happened and that the mandate is intact. `rzp.on('payment.failed')` is handled
too.

## Also still open

- `src/components/sections/ConsoleSection.tsx` is now unreferenced — it was the
  landing page's inline console. Delete it if the embedded treatment isn't wanted.

- **Still no deployment.** The biggest remaining risk to judging: a repo link
  means the judge must supply an OpenAI key *and* Razorpay test keys. A short
  screen recording would defuse most of it.
- **The revenue half is still under-told.** The brief leads with "grow the
  merchant's revenue"; the site argues buyer-side safety. `upsell_engine.py` and
  the retained-margin figure are never framed as money made.
- Both trees are **uncommitted**. `backend/` is not a git repo at all;
  `frontend/` has only the initial CNA commit.

## What was built this session

### Backend

- **`ds/` package** — `lru_index.py` (LRU session store + inverted indices),
  `catalog_index.py` (trie + inverted index), `ranking.py` (heap top-k +
  bisect leaderboard), `event_bus.py` (ring buffer + SSE fan-out),
  `database.py` (SQLite).
- **SQLite persistence** (`backend/data/acp.db`). 730+ sessions migrated from
  the old JSON files (originals left in place). Fixes two bugs: vendors
  vanishing on restart, and non-atomic session writes that could silently
  lose a session on Ctrl-C.
- **Human approval gate** — `POST /intents` mints and signs an intent and
  stops; `POST /intents/{id}/approve` records a signed approval and starts the
  negotiation on a background thread. Nothing spends before approval.
- **Multi-dimensional negotiation** — price, lead time, payment terms,
  quantity. `protocol/terms.py` (credit costs the seller ~18% APR, MSMED caps
  credit at 45 days), `protocol/shipping.py` (freight priced off the promised
  ETA, its own line, excluded from margin).
- **Deterministic guards** — margin floor enforced in code on *goods* revenue
  netted for the credit period, never on the invoice total.
- **Resilience** — `agents/resilience.py` (retry with jittered backoff),
  `agents/fallback.py` (rule-based quoting and buyer decisions when the model
  is unreachable). Verified: with OpenAI fully dead the demo still completes
  end to end. Every degraded cart is flagged in the UI and the audit trail.
- **Choose any vendor** — `GET /sessions/{id}/offers`,
  `POST /sessions/{id}/select-offer/{business_id}`. The scorer recommends; the
  human decides. Overrides are recorded in the ledger.
- **Agent-readable surface** — `/.well-known/agent-card.json`,
  `/agent/catalog/search`, `/agent/catalog/complete`.
- **Measured economics** — `orchestrator/economics.py` records every
  completion's `usage`. Real figure: **₹0.55 per negotiation**, 32 model calls,
  31,282 tokens.
- **SSE streaming** — `/sessions/{id}/stream`, `/stream` firehose.

### Frontend

- **`/try`** — intent composer (budget, units, ETA, payment terms, priority),
  approval gate, live vendor race, offer board with per-vendor settlement,
  hash-locked cart, tamper button, live trail.
- **`/developers`** — lifecycle diagram, architecture, scalability table with
  complexity classes, measured unit-economics charts, "what this is not".
- Watchdog polls the session if the stream dies (survives a backend restart).
- Branding: **Mandate**, real Razorpay mark, "for Razorpay" in the header,
  "Not affiliated with Razorpay" disclaimer kept in the footer.

## Bugs found and fixed (worth knowing — they came from testing, not reading)

1. **Two definitions of margin.** Pricing clamped to markup-on-cost while
   reporting measured margin-on-revenue. 14 spurious floor violations per
   session; only 1 of 3 vendors ever converged. After: 0 violations, 3 of 3.
2. **Lead-time discount applied to the floor**, pushing the minimum below the
   floor itself. 16 violations, zero offers, for any long-credit request.
3. **`total_price` never serialised** — it was a plain `@property`, invisible
   to `model_dump()`, so every persisted cart lacked its own total.
4. **Cart signed before the upsell was attached**, so the signature covered a
   total that no longer matched.
5. **Convergence speed weighted as half of "speed"**, letting the most
   expensive vendor win for caving fastest. Demoted to a 3% tiebreaker.
6. **Non-atomic session writes** (fixed by SQLite).
7. Frontend: invisible bars (percentage height, no definite parent), a
   duplicate React key, a stretched line chart fragmenting into pieces.

## Key invariants — do not break

- **Never inline a margin formula.** Use `protocol/pricing.py`
  (`min_sellable_price`, `margin_pct`) and `protocol/terms.py`.
- **`NEAR_FLOOR_BUFFER_PCT` lives in `protocol/pricing.py`** and is imported
  by both the orchestrator and the offline fallback. A second copy is how
  bug #1 happened.
- **Margin is measured on `goods_subtotal`**, never the freight-inclusive
  invoice total.
- **The audit ledger stays JSONL.** A hash chain is the shape of an
  append-only file; a database adds a dependency and no extra integrity.
- After any pricing change, run a session and assert
  `bounds.margin_floor_violation` is **0** in the audit trail.

## Decisions made and why

- **SQLite, not Supabase** — the submission is a repo link, so a clean clone
  must run with no external service or credentials.
- **No deployment** — the console holds a 40–70s SSE stream, which serverless
  hosts buffer or time out, and the backend assumes one long-lived process.
  A public URL would need a persistent container (Railway/Render).
- **Name "Mandate"** — ties to the Intent/Cart/Payment mandate chain and AP2.
