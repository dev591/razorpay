import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
RAZORPAY_KEY_ID = os.environ["RAZORPAY_KEY_ID"]
RAZORPAY_KEY_SECRET = os.environ["RAZORPAY_KEY_SECRET"]

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
