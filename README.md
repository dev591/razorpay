# Mandate

**Agent-to-agent purchasing on Razorpay, where every money action is bounded, gated and provable.**

A buyer agent and a set of merchant agents negotiate a real order — price, lead
time, payment terms and quantity — inside limits a human set. Nothing spends
before a human approves it. The agreed cart is hash-locked. Settlement runs
through Razorpay test mode. Every step lands in an append-only, hash-chained
ledger you can verify yourself.

Built by **Dev Chalana** for the **AI Growth & Agentic Commerce** track.

---

## Run it

Two processes. You need Python 3.11+ and Node 20+.

```bash
# ── backend ───────────────────────────────────────────────────────────
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then fill in the three keys below
.venv/bin/python -m uvicorn main:app --port 8000

# ── frontend (second terminal) ────────────────────────────────────────
cd frontend
npm install
npx next dev -p 3000
```

Open <http://localhost:3000>.

`backend/.env` needs three values:

| Key | Where it comes from |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com — the agents run on `gpt-4o-mini` |
| `RAZORPAY_KEY_ID` | Razorpay dashboard → test mode |
| `RAZORPAY_KEY_SECRET` | same |

No database to provision, no external service. Storage is embedded SQLite
(`backend/data/acp.db`), created on first boot. **A clean clone starts with zero
sessions**, so the live counters on the landing page read 0 until you run one —
those numbers are measured, never seeded.

---

### Starting fresh

Every counter is measured, never seeded, so a clean clone begins at zero
sessions. To put an instance that has been demoed back to that state — keeping
the registered vendors — stop the server and run:

```bash
cd backend && .venv/bin/python reset_demo.py
```

## The 90-second tour

1. **`/try`** — name what you need. Each preset opens with a multi-line basket
   ("25x Wireless Mouse, 15x USB-C Hub"); **+ Add item** for more. Hit **Draft
   intent mandate** — it signs the intent and *stops*. Nothing has spent.
2. **Approve it.** The field is cut to the vendors that could actually be
   cheapest — the rest are eliminated with their floor price and the saved
   spend shown — then those negotiate live, in parallel.
3. **Pick a winner.** The scorer recommends; you can override, and the override
   is written to the ledger next to the recommendation it replaced.
4. **Follow the links the console gives you.** Once the agents agree it offers
   *"Accept as ‹winner›"* and, if you bought as a vendor, *"Open as ‹buyer›"* —
   each signs you straight into `/merchant` as that party. Accept as the seller,
   pay as the buyer, then confirm dispatch as the seller. Both sides of the same
   deal, both recorded.
5. **Press "Tamper with the cart."** One rupee changes, the signature stops
   matching, settlement is refused.
6. **Press "Break the model."** Run another negotiation with the model genuinely
   unreachable. It still completes — see below.
7. **`/developers`** — architecture, complexity classes, measured economics.

---

## How the bar is met

> *Every money action explainable, bounded and gated. Show the audit trail and
> one failure handled gracefully.*

### Gated — twice

`POST /intents` mints and signs an intent mandate and halts at
`awaiting_buyer_approval`. Negotiation only begins once
`POST /intents/{id}/approve` records a human approval against the intent hash.

**Every** converged deal then stops again at `pending_seller_confirmation`
until the merchant accepts it. The agent negotiated against a catalog, and a
catalog is a claim about stock rather than a fact — merchants oversell and
under-update. Nobody is harmed by a deal waiting for a human "yes"; a buyer
paying for forty units a vendor cannot ship is a real failure. The near-floor
test still runs and is recorded, as the difference between "confirm you can
ship this" and "this one is thin, look closely".

There is no code path from an unapproved intent to a payment, and none from an
unaccepted deal to a charge.

### The basket is a signed bound, not a hint

A buyer names specific goods and quantities, and that basket is part of what the
human signs — so an approved mandate cannot be settled against a different set
of goods. `buyer_agent.basket_shortfall` rejects any cart that under-delivers a
requested line, in code, before the model is consulted; the merchant prompt
states the requirement, but nothing depends on the model honouring it. The
offline fallback fills the basket too, and will trim price before quantity and
never below a quantity the buyer named — degraded means "priced by rule", never
"quietly sold something else".

This is also what makes the negotiation hard. No vendor is cheapest on every
line, so they have to trade across the basket instead of shaving one number, and
a vendor that cannot stock a requested item is excluded outright rather than
being merely expensive.

Infeasible baskets are rejected before any model call, with the arithmetic:

```
budget of ₹42,000.00 cannot buy 20x Wireless Mouse, 20x Mechanical Keyboard:
the cheapest vendor can only reach ₹55,652.20 at its own margin floor
```

### Bounded — in code, not in a prompt

The margin floor is arithmetic in `protocol/pricing.py`, not an instruction a
model can be talked out of. It is measured on **goods revenue netted for the
credit period**, never the freight-inclusive invoice total. Credit costs the
seller ~18% APR and MSMED caps it at 45 days (`protocol/terms.py`). Budgets are
checked for feasibility before a single model call is made.

### Explainable — a chain you can verify without trusting us

Every event is appended to `data/audit/{session_id}.jsonl` with a SHA-256 hash
covering its own payload plus its predecessor's hash. Mutating any past entry
breaks every hash after it.

```bash
curl -s localhost:8000/sessions/<id>/audit | python3 - <<'PY'
import json, sys, hashlib
d = json.load(sys.stdin); prev = "0" * 64
for x in d["entries"]:
    assert x["prev_hash"] == prev
    body = {k: x[k] for k in ("seq","timestamp","event_type","payload","prev_hash")}
    assert hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",",":")).encode()).hexdigest() == x["hash"]
    prev = x["hash"]
print("chain valid:", len(d["entries"]), "entries")
PY
```

A typical session writes ~75 entries: intent, approval, every proposal and
counter, offers, scoring, winner, the locked payment mandate, the Razorpay
order, and the vendor payout attribution.

### One failure, handled gracefully — and you can trigger it

`POST /chaos/model-outage {"enabled": true}` (or the **Break the model** button
in the console) makes the pricing model genuinely unreachable. It does *not*
fake a fallback result — the upstream call fails for real, so the retry budget,
the jittered backoff, the rule-based quoting and the `degraded` labelling all
run as they would in an outage. The switch self-expires after 5 minutes.

A real run with the model fully dead:

```
agent.degraded_mode  x5   "pricing model unreachable after retries"
                          "rule-based quoting from the catalog floor;
                           margin floor still enforced"
5 offers received -> winner selected -> cart locked
razorpay.order_created   order_TXy1UIG7uk5clH
margin 14.0%  (floor 8.0%)   chain_valid: true
```

The order still completes, the floor still holds, and every affected cart is
flagged `degraded: true` in the UI and the ledger. Healthy runs carry
`degraded: false` explicitly, so "not degraded" is an assertion rather than an
absence.

---

## Making the merchant sellable to an AI buyer

An outside agent can transact without ever seeing the UI:

```bash
curl localhost:8000/.well-known/agent-card.json      # capabilities, endpoints
curl "localhost:8000/agent/catalog/search?q=keyboard" # cheapest first, across vendors
curl "localhost:8000/agent/catalog/complete?prefix=mech"   # trie-backed completion
```

Add a merchant at `/vendors` with its own catalog and margin floor, and it bids
in the next negotiation.

---

## Scale: bounding spend, not just time

Negotiation costs ~9 model calls per vendor, so broadcasting to every merchant
makes one purchase cost O(vendors) — at 100k merchants, ~900k model calls for a
single restock. That is a spend problem before it is a latency problem.

`orchestrator/shortlist.py` gates the fan-out **before** it happens:

- **The key is a provable lower bound.** `min_sellable_price` is the cheapest
  unit price a vendor can quote without breaching its own floor. No negotiation
  moves it, so `qty_min x cheapest floor price` bounds any cart that vendor
  could ever sign. If an excluded vendor's bound exceeds the winning price, it
  *could not* have won — and `marketplace.shortlist_admissible` records that
  check in the ledger every time, including when it fails.
  List price is the wrong key: it ranks who *starts* cheap, not who *ends* cheap.
  With a named basket the bound tightens to that basket's own floor total, and a
  vendor missing any requested line is dropped as `cannot_fill_basket` — a
  stronger statement than being expensive.
- **One slot is held for exploration.** A purely greedy shortlist means the same
  k merchants win every auction and nobody else ever transacts — an anti-feature
  for a platform meant to grow merchant revenue. The reserved slot goes to the
  vendor with the fewest orders so far.
- **It is a no-op on a small marketplace.** Below the threshold every vendor
  negotiates and `strategy` reads `"all"`, so the demo shows every agent racing
  while the bound is still recorded for each.

Ranking the *offers* afterwards (`ds/ranking.py`, `heapq.nlargest`, O(n log k))
sorts survivors of an expense already incurred. The shortlist is the line that
bounds the expense.

---

## Layout

```
backend/
  agents/        buyer + merchant agents, retry policy, offline fallback
  protocol/      mandates, signing, hash-chained ledger, pricing, terms
  orchestrator/  session lifecycle, marketplace fan-out, shortlist, upsell, economics
  ds/            LRU session store, catalog trie + inverted index, ranking, event bus, SQLite
  integrations/  Razorpay client
  api/routes.py  HTTP surface
frontend/
  src/app/       / (explains) · /try (console) · /vendors · /developers
  src/components/console/  intent composer, approval gate, vendor race, offer board, settlement
```

## Cost

Measured from each completion's `usage`, not estimated — `GET /economics`, and
shown live on the landing page. A five-vendor negotiation runs about **₹0.6–0.8**
in model calls.

---

## Deeper reading

[`TECHNICAL_BREAKDOWN.md`](TECHNICAL_BREAKDOWN.md) — the full engineering
account: architecture and trust boundary, the mandate chain, the commercial
model and its arithmetic, every data structure with its complexity class and
why it was chosen, concurrency, the failure-mode matrix, scalability limits by
order of magnitude, security posture, what was verified and how, the bugs found
by testing, and the gaps stated plainly.

## Author

Built by **Dev Chalana** — <https://github.com/dev591>

## What this is not

Not affiliated with Razorpay. Test mode only — no real funds move. Razorpay
Route attribution is *simulated*: linked-account ids are derived
deterministically so payout intent is explicit in the mandate and ledger, but
settlement goes through the single test account. Merchant onboarding has no
auth or KYC. `BUSINESSES` is an in-memory list; a real deployment would need a
registry behind the catalog index.

No public deployment: the console holds a 40–70s SSE stream that serverless
hosts buffer or time out, and the backend assumes one long-lived process. A
public URL would need a persistent container.
