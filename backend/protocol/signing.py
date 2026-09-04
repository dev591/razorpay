import hashlib
import hmac
import json
from typing import Any

# In a real deployment each agent would hold its own private key issued at
# registration. Here every agent's signing secret is derived deterministically
# from a single master secret plus the agent's own ref — so any new business
# id automatically gets a valid, distinct, stable signing identity without
# editing a hardcoded dict per agent (needed once the marketplace can register
# an arbitrary number of businesses).
_MASTER_SECRET = "demo-master-secret-do-not-use-in-prod"


def _secret_for(agent_ref: str) -> bytes:
    return hmac.new(
        _MASTER_SECRET.encode(), agent_ref.encode(), hashlib.sha256
    ).digest()


def canonical_json(data: dict[str, Any]) -> str:
    """Deterministic JSON encoding so the same logical object always hashes the same."""
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


def sign(agent_ref: str, payload: dict[str, Any]) -> str:
    secret = _secret_for(agent_ref)
    message = canonical_json(payload).encode()
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def verify_signature(agent_ref: str, payload: dict[str, Any], signature: str) -> bool:
    expected = sign(agent_ref, payload)
    return hmac.compare_digest(expected, signature)


def hash_cart(items_payload: list[dict[str, Any]]) -> str:
    """Content hash of a cart's line items — the value a Payment Mandate locks to."""
    canonical = canonical_json({"items": items_payload})
    return hashlib.sha256(canonical.encode()).hexdigest()
