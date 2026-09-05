# Deploying Mandate

The backend needs a **persistent container**, not a serverless function: the
console holds a 40–70 second SSE stream that serverless platforms buffer or cut,
and the process keeps parked deals and converged offers in memory between
requests. Railway and Render both work; Vercel functions do not.

The frontend is an ordinary Next.js app and goes anywhere.

---

## Backend — Railway (or Render)

1. New project → deploy from `github.com/dev591/razorpay`, root directory `backend`.
2. Start command is in `Procfile`; the platform's `$PORT` is honoured.
3. Environment variables:

   | Variable | Needed? | Notes |
   |---|---|---|
   | `OPENAI_API_KEY` | Optional | Without it every cart is quoted from the rule-based fallback and labelled degraded. Everything else works. |
   | `RAZORPAY_KEY_ID` | Optional | Without it deals reach the payment gate and hold the signed mandate. |
   | `RAZORPAY_KEY_SECRET` | Optional | — |
   | `CORS_ORIGINS` | **Yes** | The frontend's URL, e.g. `https://mandate.vercel.app`. Comma-separated for several. |

4. Attach a **volume mounted at `backend/data`**. Without one the SQLite file
   and the audit ledgers live on ephemeral disk and reset on every redeploy —
   registered vendors would disappear.

## Frontend — Vercel

1. Import the same repository and set **Root Directory** to `frontend`. That
   setting lives in the Vercel dashboard, not in `vercel.json`, and without it
   the build runs at the repo root and finds no Next app.
2. `frontend/vercel.json` supplies the rest — framework, build command, and
   `bom1` (Mumbai) as the region, since the buyers are Indian and the backend
   will likely sit there too.
3. Set `NEXT_PUBLIC_BACKEND_URL` to the backend's public URL, **no trailing
   slash**. It is read at build time, so changing it later needs a redeploy,
   not just a restart.
4. Deploy, then put that Vercel URL into the backend's `CORS_ORIGINS` and
   redeploy the backend. Until you do, every request from the deployed
   frontend is blocked by CORS and the console will look dead.

### Order matters

The two deployments reference each other, so do it in this order:

1. Deploy the backend first and copy its URL.
2. Deploy the frontend with `NEXT_PUBLIC_BACKEND_URL` set to that URL.
3. Set `CORS_ORIGINS` on the backend to the frontend's URL and redeploy it.

---

## Before making the URL public

**Put a spending limit on the OpenAI key.** A public console means anyone who
opens it spends your money — roughly ₹0.6–0.8 per negotiation. A hard monthly
cap in the OpenAI dashboard is the protection; the shortlist gate bounds the
per-purchase cost but not how many people press the button.

**Razorpay test-mode keys are safe to deploy.** No real money moves, and the
key id is publishable by design — it is already sent to the browser to open
Checkout.

**Or deploy with no OpenAI key at all.** The negotiation still runs on the
rule-based path, the floors still hold, the ledger still chains, and every cart
says degraded. That costs nothing and cannot be abused, at the price of showing
the fallback rather than live model negotiation.
