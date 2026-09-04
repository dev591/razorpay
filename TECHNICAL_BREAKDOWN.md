# Mandate — Technical Breakdown

Agent-to-agent B2B purchasing on Razorpay, where every money action is bounded,
gated and provable.

Built by **Dev Chalana** for the AI Growth & Agentic Commerce track.
Repository: <https://github.com/dev591/razorpay>

**Scale of the build:** ~6,100 lines of Python across 5 layers, ~6,600 lines of
TypeScript/React across 5 routes, 30 HTTP endpoints, 5 purpose-built data
structures, 765 real negotiation sessions in the corpus at time of writing.

---

## 1. The thesis

An agent that can spend money is only useful if it can also be **stopped,
bounded, and audited**. Most agentic-commerce demos show an LLM producing a
plausible order. The hard part is not producing the order — it is being able to
say, afterwards, exactly what was agreed, why, under what limits, and prove
none of it changed.

So the design rule throughout: **the model proposes, the protocol disposes.**
Every constraint that protects money is arithmetic in code, not an instruction
in a prompt. An adversarial, hallucinating, or entirely absent model cannot
breach any of them.

Three consequences shape the whole system:

1. **Determinism beats persuasion.** Margin floors, budget ceilings, delivery
   windows, and basket contents are checked in code before a model output is
   allowed to influence anything.
2. **The record is the product.** A hash-chained append-only ledger means the
   audit trail cannot be quietly edited — including by us.
3. **Degraded is a first-class state, not a failure.** The system completes
   real orders with the LLM entirely unreachable, and labels every such cart.

---

## 2. Architecture

### 2.1 Layers and dependency direction

```
                    ┌──────────────────────────────┐
   HTTP / SSE  ───► │  api/routes.py               │  30 endpoints
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  orchestrator/               │  lifecycle, marketplace,
                    │  session_manager, marketplace│  shortlist, upsell,
                    │  shortlist, upsell, economics│  economics, runtime
                    └──────┬────────────────┬──────┘
                           │                │
              ┌────────────▼─────┐   ┌──────▼──────────────┐
              │  agents/         │   │  ds/                │
              │  buyer, merchant │   │  lru_index, catalog │
              │  fallback,       │   │  ranking, event_bus │
              │  resilience      │   │  database           │
              └────────┬─────────┘   └─────────────────────┘
                       │
              ┌────────▼──────────────────────────┐
              │  protocol/                        │  mandates, signing,
              │  the trust boundary               │  audit_ledger, pricing,
              └───────────────────────────────────┘  terms, shipping

              ┌───────────────────────────────────┐
              │  integrations/razorpay_client.py  │
              └───────────────────────────────────┘
```

**The dependency rule:** `protocol/` never imports from `agents/` or
`orchestrator/`. It is the layer that must remain trustworthy independent of
what any agent does. Where a protocol-level check genuinely needs catalog data
(budget feasibility, basket availability), the import is done **lazily inside
the function** specifically to avoid inverting that direction at module scope.

### 2.2 The trust boundary

| Zone | Trusted? | What lives there |
|---|---|---|
| `protocol/` | **Yes — the root of trust** | Mandate schemas, HMAC signing, hash chain, margin arithmetic, terms/freight math |
| `orchestrator/` | Yes | Lifecycle, gates, scoring, shortlist |
| `ds/` | Yes | Storage and indexing; no business rules |
| `agents/` | **No — treated as adversarial** | LLM prompts and parsing |
| LLM output | **No** | Every field re-validated before use |
| Frontend | **No** | Display only; every constraint re-checked server-side |

The LLM sits *inside* a box whose walls are all deterministic. It can choose
*how* to negotiate; it cannot choose whether a bound applies.

---

## 3. The protocol layer — the mandate chain

Modelled on the AP2 / agent-payments idea of a chain of signed mandates, so
each stage commits to the one before it.

```
IntentMandate  ──signed by buyer──►  CartMandate  ──signed by merchant──►  PaymentMandate
   what the human                       what the agents                       what Razorpay
   authorised                           agreed                                is allowed to charge
```

### 3.1 IntentMandate

Fields: `goal`, `max_spend`, `qty_min`/`qty_max`, `ship_within_days`,
`requested_lines[]` (the named basket), `preferred_payment_terms`, and three
priority weights (`weight_price`, `weight_speed`, `weight_terms`).

**The signature covers every bound the agent must not exceed** — budget,
quantity band, delivery deadline, credit ceiling, *and the basket*:

```python
intent.signature = sign("buyer_agent", {
    "id", "max_spend", "qty_min", "qty_max",
    "ship_within_days", "preferred_payment_terms",
    "requested_lines": [{"name", "qty"}, ...],
})
```

Signing only price and quantity would leave terms and goods unprotected — an
approved mandate could then be settled on delivery terms, credit, or a
completely different set of goods that the human never saw.

### 3.2 CartMandate

Line items, optional upsell line, lead time, payment terms, margin, reasoning.

Its derived values are **`@computed_field`, not plain `@property`**. This is a
real bug that was found and fixed: a bare property is invisible to
`model_dump()`, so every persisted cart silently omitted its own totals and
callers had to re-derive them — the leaderboard was reading zero.

Computed fields:

| Field | Definition |
|---|---|
| `line_total` | `qty × unit_price` |
| `goods_subtotal` | Σ line totals **including** the upsell line |
| `shipping_cost` | `freight_cost(units, lead_time_days)` |
| `total_price` | `goods_subtotal + shipping_cost` |
| `credit_days` | From payment terms |
| `financing_cost` | Cost to the seller of carrying the receivable |
| `goods_cost_basis` | `goods_subtotal × (1 − margin_pct/100)` |
| `net_realisable_total` | What the seller actually banks |

### 3.3 PaymentMandate and the hash lock

Before payment, the agreed cart is content-hashed:

```python
hash_cart(items_payload) = sha256(canonical_json({"items": [...]}))
```

`items_payload` includes every line item, **the upsell line**, and a synthetic
line carrying **freight and ETA**. Locking only line items would let a settled
order be re-shipped on a slower, cheaper service without the lock noticing.

Two ordering bugs were found and fixed here:
- The cart was being **signed before the upsell was attached**, so the
  signature covered a total that no longer matched.
- `total_price` was not serialised at all (§3.2).

`POST /sessions/{id}/tamper` mutates a locked cart and re-verifies, proving
rejection. It returns `expected_hash`, `tampered_hash`, `rejected: true`.

### 3.4 Signing

HMAC-SHA256 over canonical JSON (`sort_keys=True`, tight separators) so the
same logical object always hashes identically.

Per-agent secrets are **derived**, not hardcoded:

```python
secret_for(agent_ref) = HMAC(MASTER_SECRET, agent_ref, sha256)
```

This matters for the marketplace: any newly registered business automatically
gets a valid, distinct, stable signing identity without editing a dict. In
production each agent would hold a key issued at registration; this is the
demo-scale stand-in and is labelled as such in the code.

### 3.5 The audit ledger

Append-only JSONL, one file per session, SHA-256 hash-chained:

```python
entry = {seq, timestamp, event_type, payload, prev_hash}
entry["hash"] = sha256(canonical_json(entry))
```

Each entry's hash covers its own payload **plus its predecessor's hash**, so
mutating or deleting any past entry breaks every hash after it. Tampering is
mechanically detectable, not a matter of policy.

**Why JSONL and not the database:** a hash chain *is* the shape of an
append-only file. Putting it in SQLite adds a dependency and no extra
integrity — the chain, not the storage engine, is what makes it tamper-evident.

**Concurrency:** the marketplace negotiates with several vendors in parallel
threads, all appending to the *same* session ledger. Read-last-hash-then-append
must therefore be atomic, hence an internal lock. Critically, callers must
**reuse one `AuditLedger` instance per session across threads** — a second
instance would read a stale in-memory tail and corrupt the chain regardless of
the lock. This is documented at the class.

A typical session writes **50–75 entries**. Independent verification (recomputing
every hash from genesis, without trusting the server's own `chain_valid` flag)
is a documented one-liner in the README.

---

## 4. The commercial model

This is the part most demos skip, and it is where the interesting bugs lived.

### 4.1 One definition of margin

There were previously **two**, silently compared against each other:

- pricing clamped to **markup on cost**: `cost × (1 + floor/100)`
- reporting measured **margin on revenue**: `(revenue − cost) / revenue`

A 12% floor clamped a ₹100-cost item to ₹112, which reports as `12/112` =
**10.71%** — under its own floor, for every item, on every round. The clamp was
correct and the measurement was correct; *comparing them* was not.

**Impact: 14 spurious floor violations per session; only 1 of 3 vendors ever
converged. After the fix: 0 violations, 3 of 3 converging.**

`margin_floor_pct` is named *margin*, so margin-on-revenue wins. Inverting it:

```
margin = (price − cost) / price   ⟹   price = cost / (1 − margin)
```

**Invariant, enforced by convention and documented:** never inline a margin
formula. Use `min_sellable_price()` / `margin_pct()` from `protocol/pricing.py`.
`NEAR_FLOOR_BUFFER_PCT` has exactly one home and is imported by both the
orchestrator and the offline fallback — a second copy is precisely how the two
definitions drifted apart the first time.

### 4.2 Payment terms as a priced lever

A rupee collected in 45 days is not a rupee. A seller quoting the same sticker
price on `advance` and on `net_45` is quietly earning several points less
margin, and a floor checked against sticker price would not notice.

| Constant | Value | Rationale |
|---|---|---|
| `WORKING_CAPITAL_APR` | 18.0% | Indian SMB working-capital lines run in the high teens |
| `MSMED_MAX_CREDIT_DAYS` | 45 | **Legal ceiling**, not a tuning knob — MSMED Act / s.43B(h) |
| `ADVANCE_DISCOUNT_PCT` | 2.0% | The classic "2/10" cash discount |
| `CREDIT_DAYS` | advance 0 / net_15 / net_30 / net_45 | — |

```python
financing_cost(amount, terms) = amount × (APR/100) × (days/365)
net_realisable(amount, terms) = amount − financing_cost(...)
effective_margin_pct(rev, cost, terms) = (net_realisable − cost) / net_realisable × 100
```

**The floor is enforced on net realisable revenue** — what the seller actually
banks — so a seller cannot "hold the floor" on paper while conceding real
margin through the terms instead.

Inverting for the minimum sellable price at given terms:

```
denominator = (1 − floor/100) × (1 − APR/100 × days/365)
min_price   = cost / denominator
```

### 4.3 Lead time

| Constant | Value |
|---|---|
| `STANDARD_LEAD_DAYS` | 7 |
| `EXPEDITE_PREMIUM_PCT_PER_DAY` | 0.9 (cap 12.0) |
| `SLACK_DISCOUNT_PCT_PER_DAY` | 0.35 (cap 5.0) |

**Bug found and fixed:** the lead-time discount was being applied *to the
floor*, pushing the minimum below the floor itself — **16 violations and zero
offers for any long-credit request.**

### 4.4 Freight as its own line

Previously the cost of fast delivery was folded into unit price as an "expedite
premium". No real quote works that way — and burying it corrupted the margin
story, because a rush charge is not gross margin on goods.

| Constant | Value |
|---|---|
| `BASE_FREIGHT_PER_UNIT` | ₹11.0 |
| `MIN_FREIGHT` | ₹240.0 |
| ETA multipliers | 1d 2.60× · 2d 2.00× · 3d 1.60× · 4d 1.35× · 5d 1.18× · 6d 1.07× · 7d 1.00× |
| Long-window discount | 0.02/day, floor 0.85× |

```python
freight = max(units × BASE × eta_multiplier(days), MIN_FREIGHT)
```

**Freight is a pass-through: added to the invoice, excluded from the margin the
floor is enforced against.** A merchant does not earn margin on someone else's
diesel. Steep at the short end because next-day is a dedicated vehicle, not a
slot on a shared one.

### 4.5 The upsell engine

**Rule-based, not LLM** — deliberately, so the decision is explainable and
reproducible. Only offers an upsell when:

- the base cart's margin already clears `UPSELL_MARGIN_HEADROOM_PCT` (20%), and
- the extra still fits inside the buyer's remaining budget, and
- the SKU is not already in the cart.

This maps directly to the brief's "Upsell & cross-sell agent" direction.

---

## 5. The negotiation engine

### 5.1 Round structure

`MAX_ROUNDS = 6` per vendor. Each round: merchant proposes → buyer evaluates →
accept / counter / walk. All vendors run **concurrently** against one shared
ledger.

### 5.2 Hard constraints — checked in code, before the model

`buyer_agent.evaluate_cart()` rejects outright, without consulting the LLM:

| Constraint | Failure mode prevented |
|---|---|
| `cart.total_price > intent.max_spend` | Overspend |
| `cart.lead_time_days > intent.ship_within_days` | A cart arriving after it is useful is a *different* deal, not a cheaper one |
| `basket_shortfall(intent, cart)` non-empty | Vendor substituting whatever it is cheapest at for what was actually asked for |

The model decides *how* to push back — the counter's wording and strategy — but
never *whether* a bound was breached.

**`basket_shortfall` matches on item name, case-folded, never SKU.** Each vendor
sells the same goods under its own SKU code, so SKU equality would fail for
every vendor but one. The **upsell line is deliberately excluded** from
satisfying the basket: an extra the merchant attached cannot count toward what
the buyer asked for.

### 5.3 Structured output

Merchant proposals use OpenAI **JSON-schema structured output**, with the SKU
list injected as an enum — the model cannot name a SKU the vendor does not
stock. Prompts explicitly tell the merchant that its `items` array is what
actually gets charged, not its prose, because models get arithmetic in
sentences wrong.

### 5.4 Model configuration

| Setting | Value |
|---|---|
| Model | `gpt-4o-mini` |
| Per-request timeout | 30s |

The timeout is load-bearing: the marketplace blocks on *all* vendors finishing
(`ThreadPoolExecutor.map`), so without it one stalled call would hang the entire
request — and the UI — for the SDK's 10-minute default.

---

## 6. Multi-vendor marketplace

### 6.1 The shortlist gate — bounding spend, not just time

Negotiation costs ~9 model calls per vendor, so broadcasting to every merchant
makes one purchase **O(vendors)**. At 100k merchants that is ~900k model calls
for a single restock. **This is a spend problem before it is a latency problem.**

The gate therefore runs **before** the fan-out, not after it. (Ranking offers
afterwards with a heap sorts the survivors of an expense already incurred.)

Two properties make it defensible rather than a guess:

**1. The key is a provable lower bound.**

```python
floor_bound(vendor) = Σ over requested lines: min_sellable_price(cost, floor) × qty
                      + cheapest_floor_price × (qty_min − covered)
```

`min_sellable_price` is the cheapest unit price a vendor can quote without
breaching its own margin floor. **No amount of negotiation moves it.** So if an
excluded vendor's bound exceeds the winning price, that vendor *could not* have
won. `verify_admissible()` re-checks this after the winner is known and writes
`marketplace.shortlist_admissible` to the ledger **every time, including when
it fails** — a shortlist that skipped a cheaper vendor is exactly the fact an
audit trail owes the buyer.

**List price is the wrong key**: it ranks who *starts* cheap, not who *ends*
cheap. A vendor listing ₹950 with an 8% floor beats one listing ₹880 with an
18% floor.

With a named basket the bound tightens to that basket's own floor total, and a
vendor missing any requested line is excluded as `cannot_fill_basket` — a
stronger statement than merely being expensive.

**2. It reports what it saved.** `economics.cost_per_vendor()` derives real
per-vendor cost from metered history, so the console shows e.g. *"Shortlisted 3
of 7 · saved ~36 model calls · ₹0.63 (measured)"*.

| Constant | Value | Note |
|---|---|---|
| `SHORTLIST_K` | 3 | Per-purchase spend cap; cost becomes **O(1) in marketplace size** |
| `SHORTLIST_MIN_VENDORS` | 3 | Gate is a no-op at or below this |
| `EXPLORE_SLOTS` | 0 | See below |

**The exploration trade-off (important):** a purely greedy shortlist means the
same *k* merchants win every auction and nobody else ever transacts — for a
platform whose stated purpose is *growing merchant revenue*, that is an
anti-feature. The exploration slot (reserved for the vendor with the fewest
orders) is implemented and unit-tested but **defaults to 0**, so the shortlist
is exactly "the k cheapest achievable" and a reader comparing bounds to the
selection sees them agree. This is a deliberate, reversible one-constant choice.

### 6.2 Scoring

Multi-attribute, weighted by the buyer's own stated priorities:

```
score = (w_price·price_score + w_speed·delivery_score + w_terms·terms_score) / Σw
      + 0.03 · convergence_score          # tiebreaker only
```

| Component | Definition |
|---|---|
| `price_score` | `clamp01(1 − total_price / max_spend)` |
| `delivery_score` | `clamp01((ship_within − lead_time + 1) / ship_within)` |
| `terms_score` | `clamp01(offered_credit_days / preferred_credit_days)` |
| `convergence_score` | `clamp01(1 − (rounds − 1)/(MAX_ROUNDS − 1))` |

Default weights 0.5 / 0.3 / 0.2, overridden per intent.

**Bug found and fixed:** convergence speed was weighted as *half of "speed"*,
which let the most expensive vendor win purely for caving fastest. How quickly a
vendor caved is a property of the *negotiation*, not of the deal the buyer ends
up with — the buyer's speed preference is about **delivery**. Demoted to a 3%
tiebreaker.

**Outlier defence:** an offer below `LOW_CONFIDENCE_MEDIAN_RATIO` (0.5) of the
median across converged offers is flagged and its score discounted in proportion
to how extreme it is (floor `LOW_CONFIDENCE_MIN_DISCOUNT` = 0.1), so a gamed
near-zero price cannot win on raw cheapness. Requires ≥2 offers to have a median.

### 6.3 The human decides

The scorer produces a **recommendation**, not a verdict. `GET
/sessions/{id}/offers` returns every converged cart; `POST
/sessions/{id}/select-offer/{business_id}` settles any of them against the same
signed intent. Overrides are written to the ledger as
`marketplace.offer_selected_by_human`, alongside the recommendation they
replaced.

Every converged cart is retained (`_converged_offers`) precisely so choosing the
runner-up does not require a fresh negotiation.

---

## 7. The two gates

```
POST /intents                  →  awaiting_buyer_approval    ← BLOCKING
POST /intents/{id}/approve     →  negotiating
                               →  pending_seller_confirmation ← BLOCKING
POST /sessions/{id}/confirm-seller
                               →  awaiting_payment
Razorpay checkout              →  settled
POST /sessions/{id}/acknowledge → seller.dispatch_acknowledged
```

### Gate 1 — buyer approval

`POST /intents` mints and signs the intent and **halts**. Nothing reaches an
LLM, a vendor, or Razorpay. Negotiation begins only when a human approval is
recorded against the intent hash. **There is no code path from an unapproved
intent to a payment.**

### Gate 2 — seller confirmation (unconditional)

**Every** converged cart parks for the merchant to accept. This was originally
conditional on the margin being near the floor; that optimises the wrong risk.
The agent negotiated against a **catalog**, and a catalog is a *claim about
stock*, not a fact — real merchants oversell and under-update. Nobody is harmed
by a deal waiting for a human "yes"; a buyer paying for forty units a vendor
cannot ship is a real failure.

The near-floor test still runs, recorded as the *reason*, distinguishing
"confirm you can ship this" from "this one is thin, look closely"
(`NEAR_FLOOR_BUFFER_PCT` = 3.0pp).

**Restart durability (bug found and fixed):** `confirm_seller` originally read
only an in-memory dict, so **every deal parked before a process restart was
permanently unconfirmable** — 274 sessions were stuck. `_rehydrate_pending()`
now rebuilds the `CartMandate` from the cart persisted on the session. Verified
against real rows: the rebuilt cart reproduces the **identical hash and
signature**, because both are functions of field values, not object identity.
(The prior code comment asserting JSON "cannot round-trip" a CartMandate was
simply wrong.)

---

## 8. Data structures

Five purpose-built structures, each chosen for a specific complexity property.

### 8.1 `SessionStore` — LRU over a disk-backed corpus

`OrderedDict` capped at `max_hot = 512`, plus two inverted indices and a
recency deque.

| Operation | Complexity | Replaced |
|---|---|---|
| get / put / evict | **O(1)** | unbounded `dict` |
| `by_buyer(id)` / `by_seller(id)` | **O(k)** set lookup | O(n) scan-and-filter |
| recent activity | **O(1)** append, O(k) read | O(n log n) sort by `created_at` per poll |

Eviction drops only the in-memory copy; SQLite remains authoritative, so a miss
falls through to disk rather than losing data. Guarded by a **re-entrant** lock,
because `put()` can trigger `_evict()`, which touches the same state.

### 8.2 `CatalogIndex` — trie + inverted index

This is what makes the catalog *agent-readable at scale*. An AI buyer should not
have to pull `GET /businesses` and grep client-side — that is O(businesses ×
SKUs) over the wire on every query.

| Structure | Purpose | Complexity |
|---|---|---|
| Trie | Prefix completion (`"mech"` → *Mechanical Keyboard*) | **O(len(prefix) + matches)** — independent of catalog size |
| Inverted index `token → set[(business_id, sku)]` | Term lookup; multi-token queries intersect posting sets | Scales with the **rarest token's** posting list |
| `heapq.nsmallest` | Cheapest-first top-k | **O(n log k)**, never sorts the full match set |

`_TrieNode` uses `__slots__`. Cost is the merchant's input and **never leaves
the building** — only `list_price` is exposed to agents.

### 8.3 `ranking.py` — two different problems, two structures

- **`top_k_offers`** — one-shot selection over an in-memory batch.
  `heapq.nlargest` keeps a k-sized heap in one pass: **O(n log k)** versus
  O(n log n) to sort everything just to read the top.
- **`Leaderboard`** — *incrementally maintained* ranking. A settled order
  changes a vendor's cumulative revenue and the top-k must stay correct. A heap
  cannot do this (no efficient decrease-key on an arbitrary element), so it
  keeps a `bisect.insort` sorted list keyed on revenue: **O(log n)** to find the
  insertion point, O(n) memmove to splice, **O(1)** to read the top k. Read on
  every dashboard poll, written once per settlement — the trade is the right way
  round.

The stale tuple is removed before re-inserting, keeping the list a true ordering
rather than an append-only log with duplicates.

`booked GMV` (signed mandates with real orders behind them) is tracked
separately from `settled` (money actually captured) — the dashboard must never
present booked GMV as revenue.

### 8.4 `EventBus` — ring buffer + fan-out

Solves a concrete problem: `POST /sessions` blocked for 10–20s of real OpenAI
round-trips and returned everything at once. Every interesting event already
happened inside that window and was thrown away.

- **Ring buffer per topic** — `deque(maxlen=200)`. Bounded by construction, so a
  long-running process cannot leak memory through the event log, and a client
  connecting mid-negotiation gets replayed the last N events instead of joining
  blind.
- **Fan-out queues** — one `queue.Queue(500)` per subscriber, so a slow consumer
  applies backpressure **to itself alone**. Publishing never blocks: a full
  queue drops that subscriber's oldest event rather than stalling the
  negotiation thread doing the publishing.
- **Firehose topic** (`"*"`) mirrors everything, so the console shows
  cross-session activity without one connection per session.

### 8.5 `Database` — embedded SQLite

Store of record. Columns indexed for the access patterns that matter
(`status`, `buyer_business_id`, `seller_business_id`, `created_at`).

---

## 9. Concurrency model

| Component | Mechanism | Rationale |
|---|---|---|
| Vendor negotiations | `ThreadPoolExecutor`, one worker per shortlisted vendor | Each is I/O-bound on OpenAI; ~6× wall-clock saving over serial |
| Approval → negotiation | Background thread | `POST /approve` returns immediately; progress streams over SSE |
| `AuditLedger` | Internal `Lock`; **one instance per session shared across threads** | Read-last-hash-then-append must be atomic |
| `SessionStore` | `RLock` | `put()` re-enters via `_evict()` |
| `EventBus` | `RLock` + per-subscriber queues | Publisher never blocks on a consumer |
| `Leaderboard` | `RLock` | Concurrent settlements |
| `_ModelOutage` | `Lock` | Chaos switch toggled from HTTP while negotiations run |

**The subtle one:** because the pool blocks on *all* vendors
(`ThreadPoolExecutor.map`), a single hung OpenAI call would hang the whole
request. That is why `OPENAI_TIMEOUT_SECONDS = 30` exists — one slow call
becomes a handled per-vendor failure, not an apparent frontend freeze.

---

## 10. Resilience

### 10.1 Retry policy

Two ideas kept deliberately separate:

- **Transient vs terminal.** A dropped socket, 429, or 5xx is worth retrying.
  A malformed request or auth failure is not — those propagate immediately
  rather than burning the clock.
- **Bounded, jittered backoff.** `MAX_ATTEMPTS = 3`, base 0.6s, cap 4.0s, **full
  jitter**. Jitter matters specifically because all vendor threads fail
  *simultaneously* on a network blip; without it they would retry in lockstep and
  hammer the same recovering endpoint.

Observed in testing on a flaky connection: all three vendor agents failed at
round one with a bare `Connection error`, the session ended `no_valid_offers`,
and a whole negotiation was lost to a sub-second blip. Correct failure handling
and a useless outcome.

### 10.2 Rule-based fallback

When retries are exhausted, `propose_cart_offline()` builds a valid cart with no
model at all: fills the quantity band (or the named basket) from the vendor's
catalog, prices at a round-appropriate target margin, then walks price toward
the floor if over budget, and only then trims quantity — **never below a
quantity the buyer explicitly named**, and **never below the floor**. An offer
that breaches the vendor's own limit is worse than no offer.

The buyer agent has an equivalent offline decision path.

**Every degraded cart is flagged** — `degraded: true` on the cart, in the UI,
and in the audit trail as `agent.degraded_mode` with an explicit reason and
stated behaviour. Healthy carts carry `degraded: false` **explicitly**, so "not
degraded" is a positive assertion rather than an absence.

### 10.3 Deliberate failure injection

`POST /chaos/model-outage {"enabled": true}` (and a **Break the model** button in
the console) makes the model genuinely unreachable.

**It breaks the upstream, not the outcome.** `call_with_retry` raises the same
`APIConnectionError` the SDK raises, so the retry budget, backoff, rule-based
quoting and degraded labelling all execute exactly as in a real outage. A switch
that jumped straight to the fallback would demonstrate nothing.

Self-expires after 300s — a demo control that can be left on by accident is a
control that eventually makes a working system look broken.

**Verified result with the model fully dead:** 5 vendors degraded at round 1,
winner selected, **real Razorpay order created**, margin 14.99% against a 9%
floor, chain valid, every cart flagged.

### 10.4 Failure-mode matrix

| Failure | Detection | Response | State |
|---|---|---|---|
| OpenAI unreachable | `APIConnectionError` after 3 tries | Rule-based quote | `degraded: true`, order still completes |
| OpenAI malformed/auth | Terminal exception class | Propagate immediately | Vendor drops out; others continue |
| Razorpay order create fails | `RazorpayCallError` (30s bound) | Mandate held intact | `payment_provider_error` |
| Razorpay capture fails | `RazorpayCallError` | Mandate held intact | `payment_capture_failed` |
| Bad checkout signature | HMAC verify | Refuse capture | `payment_signature_invalid` |
| Tampered cart | Hash mismatch | Refuse settlement | `rejected_hash_mismatch` |
| No vendor converges | Empty valid set | Clean end | `no_valid_offers` |
| Budget infeasible | Pre-flight check | **Reject before any model call**, with arithmetic | 400 + explanation |
| Basket unstocked | Pre-flight check | Reject with the missing items named | 400 + explanation |
| Process restart mid-deal | Missing in-memory cache | Rehydrate cart from persisted session | Confirmable |
| SSE stream dies | Frontend watchdog | Poll session state | Recovers across a backend restart |

---

## 11. Payments

Razorpay **test mode**. `create_order` → hosted Checkout → `payment-callback`
→ HMAC signature verification → `capture_payment`.

The client wraps every call with its own retry (3 attempts) and a **30s
timeout** on each, bounded so a slow provider becomes a clean status rather than
a hung request.

**The confirmation page (bug found and fixed):** it previously printed "Payment
captured" from a bare `.then()` — **including when signature verification
failed**, because `payment-callback` returns HTTP 200 for *every* outcome and
puts the result in the session's `status`. A buyer whose payment was rejected
would have been told it succeeded. It now branches on `status` and renders
distinct screens for `settled`, `payment_signature_invalid`, and
`payment_capture_failed`, plus a handler for `rzp.on('payment.failed')`.

**Route attribution is simulated and labelled as such.** Linked-account ids are
derived deterministically (`acc_` + sha256 prefix) so payout intent is *explicit*
in the payment mandate and audit trail rather than implicit — but settlement
goes through the single real test account. A real linked account would be issued
by Razorpay at KYC time.

---

## 12. Input validation

All at the API boundary, before anything reaches an LLM or Razorpay:

| Guard | Limit |
|---|---|
| `MAX_SPEND_CAP` | ₹10,000,000 |
| `MAX_QUANTITY` | 100,000 |
| `MAX_SHIP_WINDOW_DAYS` | 365 |
| `MAX_REQUESTED_LINES` | 6 |
| `MAX_MARGIN_FLOOR_PCT` | 95% (above this there is no finite price solution) |
| Quantity band | `qty_min ≤ qty_max`, both positive |
| Payment terms | Enum + MSMED 45-day ceiling |
| Duplicate basket lines | Rejected by case-folded name |

Two are **feasibility**, not merely well-formedness:

- `check_budget_feasible` — a budget that cannot buy `qty_min` of the cheapest
  thing on offer is a request no vendor can fill.
- `check_basket_affordable` — once goods are *named*, the generic check is far
  too weak: twenty keyboards cost what eighty mice do. Rejects with the
  arithmetic: *"budget of ₹42,000 cannot buy 20x Wireless Mouse, 20x Mechanical
  Keyboard: the cheapest vendor can only reach ₹55,652.20 at its own margin
  floor."*

Rejecting up front with the actual shortfall is both cheaper and a far better
answer than six rounds of model calls ending in "no vendor responded".

---

## 13. Agent-readable surface

Makes the merchant transactable by an AI buyer with no UI:

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/agent-card.json` | Capabilities, 7 endpoints, 4 stated guarantees, catalog stats |
| `GET /agent/catalog/search?q=` | Cross-vendor term search, cheapest first |
| `GET /agent/catalog/complete?prefix=` | Trie-backed prefix completion |
| `POST /intents` → `/approve` | The gated lifecycle |
| `GET /sessions/{id}/stream` | Per-session SSE |
| `GET /sessions/{id}/audit` | The chain |

---

## 14. Frontend

Next.js 16 (App Router, Turbopack), React 19, Tailwind v4, framer-motion, GSAP
ScrollTrigger, React Three Fiber.

| Route | Role |
|---|---|
| `/` | Explains only — hero, lifecycle, guarantees, live numbers, CTA |
| `/try` | Buyer console |
| `/merchant` | Seller console (credential-free identity switch) |
| `/vendors` | Vendor registry + add-vendor + agent catalog search |
| `/developers` | Engineering notes, complexity table, measured economics |

**State model:** the console's state machine is *folded from the SSE event
stream* rather than polled. A negotiation is 10–20s of concurrent LLM
round-trips; the whole point is showing it happen rather than freezing on a
spinner and dumping a finished object. Duplicate events are guarded by a seen-set
because the server replays its buffer on reconnect.

**Watchdog:** `EventSource` reconnects on its own and the server replays, so a
brief drop is invisible. A backend *restart* is different — the bus is empty —
so a poll-based watchdog recovers terminal state.

**Merchant console polls (3s) rather than streams**, deliberately: a dashboard
left open for an hour must survive a backend restart.

**Frontend bugs found and fixed:** invisible bars (percentage height with no
definite parent), a duplicate React key, a stretched line chart fragmenting into
pieces, and number inputs that could not be cleared — binding a number directly
to `value` turned every clearing keystroke into `Number("") === 0`, so the field
re-rendered as "0" and the next digits read "035000".

---

## 15. Observability and unit economics

`orchestrator/economics.py` records **every completion's `usage` block** —
measured, never estimated.

- `GET /economics` — totals, calls by agent, per-negotiation averages
- `cost_per_vendor()` — real per-vendor cost, used by the shortlist to state
  what it saved

**Measured:** ~₹0.6–0.8 per multi-vendor negotiation; ~9 model calls per vendor;
30–45k tokens per session. Shown live on the landing page and the engineering
page.

**Known limitation:** these counters live in memory and reset on restart
(sessions themselves persist via SQLite). Both surfaces handle the empty state
explicitly rather than rendering a blank gap.

---

## 16. Scalability

### 16.1 Complexity summary

| Operation | Complexity | Notes |
|---|---|---|
| Session get/put | O(1) | LRU, 512 hot |
| Sessions by business | O(k) | Inverted index |
| Recent activity | O(1) / O(k) | Bounded deque |
| Catalog prefix search | O(len(prefix) + matches) | Trie — **independent of catalog size** |
| Catalog term search | O(rarest posting list) | Inverted index |
| Top-k offers | O(n log k) | Bounded heap |
| Leaderboard write | O(log n) + memmove | `bisect.insort` |
| Leaderboard read | O(1) | Tail slice |
| Event publish | O(subscribers) | Never blocks |
| **Negotiation cost** | **O(1) in marketplace size** | Shortlist gate — the important one |

### 16.2 What breaks, and at what N

| N (merchants) | Bottleneck | Mitigation |
|---|---|---|
| ~10² | None | Current design holds |
| ~10³ | `BUSINESSES` in-memory list; shortlist scans all vendors to compute bounds | Move registry to SQLite; pre-compute bounds into the catalog index |
| ~10⁴ | Single-process assumption; in-memory `_pending_confirmations`, `_converged_offers` | Externalise to Redis/DB; horizontal scale behind a load balancer |
| ~10⁵ | Bound computation O(vendors) per intent; SSE fan-out in-process | Two-stage retrieval (inverted index → candidates → top-k); move the bus to Redis pub/sub or NATS |
| ~10⁶ | SQLite write concurrency; single-node ledger | Postgres; shard ledgers by session; object storage for cold audit |

**The honest ordering:** sorting is microseconds at any of these scales. The wall
is always the **model calls**, which is why the shortlist gate — not the heap —
is the line that matters, and why it is framed as a spend bound rather than a
speed optimisation.

### 16.3 What is *not* solved

- No horizontal scaling: one long-lived process is assumed throughout.
- Three in-memory caches (`_pending_confirmations`, `_pending_intents`,
  `_converged_offers`) are restart-fragile. **Only the first is fixed**
  (§7); approving an intent or selecting a runner-up across a restart still
  fails, and the same rehydration approach would work.
- No auth, no rate limiting, no multi-tenancy.
- No idempotency keys on payment endpoints.

---

## 17. Security posture

**Implemented:** HMAC-signed mandates with derived per-agent keys; hash-chained
tamper-evident ledger; content-hash lock over items *and* freight/ETA; Razorpay
checkout signature verification; structured output with SKU enums so the model
cannot invent products; all bounds re-validated server-side; input caps against
absurd or gamed values; cost data never exposed to agents; secrets in `.env`,
git-ignored, verified absent from the published tree by content scan.

**Explicitly not production-grade, and labelled as such in code:** a single
master signing secret (real deployments issue per-agent keys at registration);
no authentication or authorisation on any endpoint; no rate limiting; the
merchant identity switch is deliberately credential-free for demonstration;
Route attribution is simulated.

---

## 18. Verification performed

- **Chain verification** — every hash recomputed from genesis independently,
  *not* trusting the server's own `chain_valid` flag. Valid across every session
  tested.
- **Floor invariant** — `bounds.margin_floor_violation` = 0 across sessions
  after the margin fixes (was 14/session).
- **Tamper** — mutation produces a different hash and is rejected.
- **Degraded end-to-end** — model fully dead; order still completes with a real
  Razorpay order; floor still enforced; every cart flagged.
- **Shortlist** — unit tests for bound arithmetic, k enforcement,
  cheapest-present, admissibility in both directions, exploration targeting,
  determinism per seed, empty-catalog handling.
- **Basket** — validation, shortfall detection, substitution rejection,
  fallback compliance under a tight budget.
- **Gate unconditionality** — synthetic 45% margin cart (far outside the 3pp
  buffer) confirmed to park.
- **Restart durability** — a previously stuck parked deal confirmed after a
  restart, producing a real order.
- **Clean-clone install** — fresh venv, `pip install -r requirements.txt`,
  `uvicorn main:app` boots and serves.
- **Full UI pass** — vendor creation, multi-item negotiation, human override,
  merchant acceptance, tamper, degraded run, all five routes: **zero console
  errors, zero backend tracebacks, zero 5xx**.

---

## 19. Case studies — bugs found by testing, not by reading

These are included because they demonstrate where the real difficulty lay.

1. **Two definitions of margin** (§4.1) — 14 spurious violations/session; 1 of 3
   vendors converging. → 0 violations, 3 of 3.
2. **Lead-time discount applied to the floor** — pushed the minimum below the
   floor itself; 16 violations, zero offers on long-credit requests.
3. **`total_price` never serialised** — a plain `@property` is invisible to
   `model_dump()`; every persisted cart lacked its own total.
4. **Cart signed before the upsell was attached** — the signature covered a total
   that no longer matched.
5. **Convergence weighted as half of "speed"** — the most expensive vendor could
   win for caving fastest.
6. **Non-atomic session writes** — could silently lose a session on Ctrl-C; fixed
   by SQLite.
7. **Parked deals died on restart** — 274 sessions permanently unconfirmable.
8. **Checkout reported success on a failed signature** — HTTP 200 for every
   outcome; the result is in the body.
9. **Number inputs could not be cleared** — `Number("") === 0` re-rendered "0".
10. **Frontend rendering** — invisible bars, duplicate React key, fragmenting
    line chart.

---

## 20. Deliberate design decisions

| Decision | Reasoning |
|---|---|
| **SQLite, not a hosted DB** | The submission is a repo link; a clean clone must run with no external service or credentials |
| **Audit ledger stays JSONL** | A hash chain *is* an append-only file; a DB adds a dependency and no extra integrity |
| **Upsell is rule-based, not LLM** | It must be explainable and reproducible |
| **Rule-based fallback, not a cached response** | Degraded must still respect the floor |
| **Chaos switch breaks the upstream** | Short-circuiting to the fallback would demonstrate nothing |
| **`EXPLORE_SLOTS = 0` by default** | Verifiability now; exploration is one constant away |
| **Seller gate unconditional** | Catalogs are claims about stock, not facts |
| **Freight excluded from margin** | A merchant does not earn margin on diesel |
| **Floor on net realisable revenue** | Otherwise terms become a hidden margin leak |
| **No deployment** | The console holds a 40–70s SSE stream that serverless hosts buffer or time out; a public URL needs a persistent container |

---

## 21. Honest gaps

Stated plainly, because a reviewer will find them anyway:

1. **The revenue-growth half is under-told.** The brief leads with *"grow the
   merchant's revenue"*; the build argues buyer-side safety. The upsell engine
   and retained-margin figures exist but are never framed as *money made*. This
   is a framing gap, not a build gap.
2. **No public deployment.** A judge must supply an OpenAI key *and* Razorpay
   test keys. This is the largest practical risk to evaluation.
3. **The `settled → confirm dispatch` transition is guard-tested but never
   exercised live** — no session in the corpus has been paid through Razorpay
   checkout.
4. **Two of three in-memory caches remain restart-fragile** (§16.3).
5. **Economics counters reset on restart** (§15).
6. **A clean clone starts at zero sessions**, so live counters read 0 until a
   negotiation runs — deliberate, since every number is measured rather than
   seeded, but it does make first load look emptier than a populated instance.

---

## 22. Mapping to the brief

> *Every money action explainable, bounded and gated. Show the audit trail and
> one failure handled gracefully.*

| Requirement | Where |
|---|---|
| Transactable by an AI buyer end to end | Intent → shortlist → negotiate → seller accept → Razorpay order → payment → dispatch |
| Agent-readable catalog *(named direction)* | Agent card, trie + inverted index, cross-vendor search |
| Upsell & cross-sell agent *(named direction)* | `upsell_engine.py`, rule-based |
| **Gated** | Two blocking human gates |
| **Bounded** | Margin floor, basket, budget, MSMED cap — all arithmetic |
| **Explainable** | Hash-chained ledger, independently verifiable |
| **Audit trail shown** | `/audit`, live trail, README verifier |
| **One failure handled gracefully** | Chaos switch → real outage → real fallback → floor holds |
