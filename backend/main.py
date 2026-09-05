from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import router
import config
from orchestrator import runtime

app = FastAPI(title="Mandate — agentic commerce on Razorpay")

# Local development origins, plus whatever a deployment adds. Listing them
# explicitly rather than allowing "*" keeps a deployed instance from being
# driven by any page on the internet — the endpoints spend money.
_ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3411",
    "http://127.0.0.1:3411",
    *[o.strip() for o in config.EXTRA_CORS_ORIGINS if o.strip()],
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.on_event("startup")
def boot():
    """Rebuild in-memory state from disk before serving anything.

    Previously this warmed the metrics cache instead, which kicked off a
    multi-minute batch of *real* OpenAI negotiations on every boot — latency
    and spend on a cold start — while the 700+ sessions already on disk stayed
    invisible, so a restart mid-demo emptied the dashboard and 404'd every
    prior session. Rehydration is local file I/O and costs nothing.
    """
    summary = runtime.boot()
    print(
        f"[boot] rehydrated {summary['sessions_rehydrated']} sessions "
        f"({summary['store']['hot_resident']} hot) | "
        f"{summary['catalog']['indexed_skus']} SKUs indexed | "
        f"booked GMV ₹{summary['leaderboard']['booked_gmv']:,.0f}"
    )
    # Say plainly what this process can reach. Without it, a reviewer running
    # from a clean clone sees every cart marked degraded and has to guess why.
    if not config.HAS_OPENAI:
        print(
            "[boot] no OPENAI_API_KEY — agents will quote from the rule-based "
            "fallback and every cart will be labelled degraded. Gates, margin "
            "floors, the shortlist and the audit chain all work unchanged."
        )
    if not config.HAS_RAZORPAY:
        print(
            "[boot] no RAZORPAY_KEY_ID/SECRET — deals will reach the payment "
            "gate and hold the signed mandate instead of creating an order."
        )
    if config.HAS_OPENAI and config.HAS_RAZORPAY:
        print("[boot] OpenAI and Razorpay configured — full live mode.")


@app.get("/health")
def health():
    return {"status": "ok"}
