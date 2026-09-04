"""Embedded SQLite store.

Chosen over a hosted database on purpose: the submission is a repo link, so
anyone cloning it must be able to run the whole system with no external
service, no credentials and no network. A single file gives that, plus the
two things the JSON-file layer could not:

  * **Atomic writes.** The previous `open(path, "w")` truncated the file
    before writing it. A Ctrl-C mid-write left a truncated JSON file, and
    since rehydration skips unparseable files, that session silently vanished.
    A transaction either lands or it does not.
  * **Durable vendor registration.** Registered merchants lived only in
    memory, so every restart wiped them — a vendor added during a demo was
    gone the moment the backend bounced.

The in-memory LRU, inverted indices, trie and leaderboard all stay exactly as
they were. This replaces the *persistence* layer beneath them, not the access
patterns above them — which is the whole reason `SessionStore` kept its disk
access behind three small methods.

Threading: the marketplace negotiates on a thread pool, so the connection is
opened with `check_same_thread=False` and every statement runs under one lock.
WAL mode is enabled so reads don't block behind a write.
"""

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    status              TEXT,
    buyer_business_id   TEXT,
    seller_business_id  TEXT,
    created_at          REAL,
    updated_at          REAL,
    data                TEXT NOT NULL
);
-- Mirrors the in-memory inverted indices, so a cold start can answer
-- "this merchant's orders" without loading every session first.
CREATE INDEX IF NOT EXISTS idx_sessions_buyer   ON sessions(buyer_business_id);
CREATE INDEX IF NOT EXISTS idx_sessions_seller  ON sessions(seller_business_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);

CREATE TABLE IF NOT EXISTS businesses (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  REAL,
    data        TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            # WAL: readers proceed during a write, which matters because the
            # dashboard polls while negotiations are writing.
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    # ── sessions ──────────────────────────────────────────────────────────

    def upsert_session(self, session: dict[str, Any]) -> None:
        payload = json.dumps(session, default=str)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO sessions (id, status, buyer_business_id, seller_business_id,
                                      created_at, updated_at, data)
                VALUES (?, ?, ?, ?, ?, strftime('%s','now'), ?)
                ON CONFLICT(id) DO UPDATE SET
                    status             = excluded.status,
                    buyer_business_id  = excluded.buyer_business_id,
                    seller_business_id = excluded.seller_business_id,
                    updated_at         = excluded.updated_at,
                    data               = excluded.data
                """,
                (
                    session["id"],
                    session.get("status"),
                    session.get("buyer_business_id"),
                    session.get("seller_business_id"),
                    session.get("created_at"),
                    payload,
                ),
            )
            self._conn.commit()

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        if row is None:
            return None
        try:
            return json.loads(row["data"])
        except json.JSONDecodeError:
            return None

    def iter_sessions(self) -> Iterator[dict[str, Any]]:
        """Oldest first, so a caller rebuilding a recency list ends up with the
        newest entries at the head."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT data FROM sessions ORDER BY created_at ASC"
            ).fetchall()
        for row in rows:
            try:
                yield json.loads(row["data"])
            except json.JSONDecodeError:
                continue

    def count_sessions(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"]

    # ── businesses ────────────────────────────────────────────────────────

    def upsert_business(self, business: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO businesses (id, name, created_at, data)
                VALUES (?, ?, strftime('%s','now'), ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    data = excluded.data
                """,
                (business["id"], business["name"], json.dumps(business, default=str)),
            )
            self._conn.commit()

    def all_businesses(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT data FROM businesses ORDER BY created_at ASC"
            ).fetchall()
        out = []
        for row in rows:
            try:
                out.append(json.loads(row["data"]))
            except json.JSONDecodeError:
                continue
        return out

    def delete_business(self, business_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM businesses WHERE id = ?", (business_id,))
            self._conn.commit()

    def stats(self) -> dict[str, Any]:
        with self._lock:
            sessions = self._conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"]
            businesses = self._conn.execute("SELECT COUNT(*) AS n FROM businesses").fetchone()["n"]
        return {
            "engine": "sqlite",
            "path": str(self.path),
            "sessions": sessions,
            "registered_businesses": businesses,
            "size_bytes": self.path.stat().st_size if self.path.exists() else 0,
        }
