import hashlib
import json
import threading
import time
from pathlib import Path
from typing import Any

from config import AUDIT_DIR

GENESIS_HASH = "0" * 64


class AuditLedger:
    """Append-only, hash-chained event log for one negotiation session.

    Each entry's hash covers its own payload plus the previous entry's hash,
    so mutating or deleting any past entry breaks every hash after it —
    tampering is mechanically detectable, not just policy.

    The marketplace flow negotiates with several businesses concurrently in
    separate threads, all appending to the *same* session's ledger — so the
    read-last-hash-then-append sequence must be atomic, hence the lock. This
    only protects concurrent calls on one shared instance: callers must reuse
    a single AuditLedger per session_id across threads rather than each
    thread constructing its own (a second instance would read a stale
    in-memory tail and corrupt the chain regardless of this lock).
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.path: Path = AUDIT_DIR / f"{session_id}.jsonl"
        self._lock = threading.Lock()
        self._entries: list[dict[str, Any]] = []
        if self.path.exists():
            with self.path.open() as f:
                self._entries = [json.loads(line) for line in f if line.strip()]

    def _last_hash(self) -> str:
        return self._entries[-1]["hash"] if self._entries else GENESIS_HASH

    def append(self, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            prev_hash = self._last_hash()
            entry = {
                "seq": len(self._entries) + 1,
                "timestamp": time.time(),
                "event_type": event_type,
                "payload": payload,
                "prev_hash": prev_hash,
            }
            canonical = json.dumps(entry, sort_keys=True, separators=(",", ":"))
            entry["hash"] = hashlib.sha256(canonical.encode()).hexdigest()

            self._entries.append(entry)
            with self.path.open("a") as f:
                f.write(json.dumps(entry) + "\n")
            return entry

    def entries(self) -> list[dict[str, Any]]:
        return list(self._entries)

    def verify_chain(self) -> bool:
        """Recompute every hash from scratch to confirm no entry was altered."""
        prev_hash = GENESIS_HASH
        for entry in self._entries:
            if entry["prev_hash"] != prev_hash:
                return False
            check = dict(entry)
            recorded_hash = check.pop("hash")
            canonical = json.dumps(check, sort_keys=True, separators=(",", ":"))
            if hashlib.sha256(canonical.encode()).hexdigest() != recorded_hash:
                return False
            prev_hash = recorded_hash
        return True
