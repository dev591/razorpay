from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import router
from orchestrator import runtime

app = FastAPI(title="Mandate — agentic commerce on Razorpay")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3411",
        "http://127.0.0.1:3411",
    ],
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


@app.get("/health")
def health():
    return {"status": "ok"}
