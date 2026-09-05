import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# Credentials are optional, and that is deliberate.
#
# Requiring them at import meant a clean clone could not start at all without a
# reviewer first getting an OpenAI key — a real barrier to anyone evaluating
# this from a repository link. The system already has a rule-based path for a
# model it cannot reach, and a handled failure path for a payment provider it
# cannot reach, so a missing key is just those paths taken permanently rather
# than an outage. Everything it produces is labelled degraded, exactly as it
# would be during a real outage.
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "").strip()
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "").strip()

# What this process can actually reach. Read at boot and reported in the
# banner, so "why is everything degraded" is answered before it is asked.
HAS_OPENAI = bool(OPENAI_API_KEY)
HAS_RAZORPAY = bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)

# Comma-separated origins a deployed frontend is served from, e.g.
# "https://mandate.vercel.app". Empty locally, where the defaults cover it.
EXTRA_CORS_ORIGINS = [
    o for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()
]

OPENAI_MODEL = "gpt-4o-mini"
# Per-request timeout for OpenAI calls. Without this the SDK's default is 10
# minutes — and since the marketplace flow blocks on ALL businesses finishing
# (ThreadPoolExecutor.map), one slow/stalled call would hang the entire
# request (and the UI) for up to 10 minutes with zero feedback. Fail fast
# instead so a single bad call becomes a handled negotiation failure, not an
# apparent frontend freeze.
OPENAI_TIMEOUT_SECONDS = 30.0

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
AUDIT_DIR = DATA_DIR / "audit"
SESSIONS_DIR = DATA_DIR / "sessions"

# Embedded SQLite, deliberately: a repo-link submission has to run from a
# clean clone with no external service, credentials or network.
DB_PATH = DATA_DIR / "acp.db"

for _dir in (DATA_DIR, AUDIT_DIR, SESSIONS_DIR):
    _dir.mkdir(parents=True, exist_ok=True)
