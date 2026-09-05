"""Hot/cold session store: an LRU over a disk-backed corpus, plus the
secondary indices the API reads from.

Why this shape rather than the plain `dict[str, dict]` it replaces:

  * **Bounded memory.** Sessions are unbounded and each carries a full
    transcript, every round's cart, and an audit tail. An `OrderedDict`
    capped at `max_hot` gives O(1) get/put/evict; eviction drops only the
    in-memory copy, and the JSON on disk stays authoritative, so a miss
    falls through to disk instead of losing data.
  * **O(1) lookup by business.** `get_business_orders` used to scan every
    session and filter. Two inverted indices (`business id -> set[session
    id]`, one per side of the trade) turn that into a set lookup of just
    that business's k sessions.
  * **Bounded recency.** A `deque(maxlen=n)` of ids gives the console's
    "recent activity" rail an O(1) append and an O(k) read, instead of
    sorting the whole corpus by `created_at` on every poll.

Thread-safety: one `RLock` guards every mutation. Re-entrant because
`put()` can trigger `_evict()`, which touches the same state.
"""

import json
import threading
from collections import OrderedDict, deque
from pathlib import Path
from typing import Any, Callable, Iterator

from ds.database import Database


class SessionStore:
    def __init__(
        self,
        directory: Path,
        database: Database,
        max_hot: int = 512,
        recent_size: int = 100,
    ) -> None:
        # `directory` is retained only to migrate the legacy JSON corpus on
        # first boot; SQLite is the store of record from then on.
        self._dir = directory
        self._db = database
        self._max_hot = max_hot
        self._lock = threading.RLock()

        self._hot: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._by_buyer: dict[str, set[str]] = {}
        self._by_seller: dict[str, set[str]] = {}
        self._recent: deque[str] = deque(maxlen=recent_size)
        # Every id the store knows about, hot or evicted. Lets `count()` and
        # `iter_ids()` answer without hitting the filesystem.
        self._known: set[str] = set()
        # What each session is currently filed under, so a change of party can
        # be un-filed from the old one. Without this the indices only ever
        # grow, and a session whose seller changed stays visible to both.
        self._filed_under: dict[str, tuple[str | None, str | None]] = {}

    # ── paths ─────────────────────────────────────────────────────────────

    def _path(self, session_id: str) -> Path:
        return self._dir / f"{session_id}.json"

    # ── core ──────────────────────────────────────────────────────────────

    def put(self, session: dict[str, Any], persist: bool = True) -> None:
        """Insert or refresh a session: writes through to disk, promotes it
        to the head of the LRU, and re-files it in both indices."""
        session_id = session["id"]
        with self._lock:
            self._hot[session_id] = session
            self._hot.move_to_end(session_id)

            if session_id not in self._known:
                self._known.add(session_id)
                self._recent.appendleft(session_id)

            self._reindex(session)
            self._evict()

        if persist:
            # One transaction: it lands whole or not at all. The previous
            # truncate-then-write could leave a half-written file on Ctrl-C,
            # and rehydration silently skipped those — losing the session.
            self._db.upsert_session(session)

    def get(self, session_id: str) -> dict[str, Any] | None:
        """Hot hit promotes and returns. Miss falls through to disk and, if
        found, re-admits the session to the hot tier."""
        with self._lock:
            hit = self._hot.get(session_id)
            if hit is not None:
                self._hot.move_to_end(session_id)
                return hit

        session = self._db.get_session(session_id)
        if session is None:
            return None

        with self._lock:
            self._hot[session_id] = session
            self._hot.move_to_end(session_id)
            self._known.add(session_id)
            self._reindex(session)
            self._evict()
        return session

    def _reindex(self, session: dict[str, Any]) -> None:
        """Files a session under whichever businesses it involves.

        Called on every `put`, because `seller_business_id` is only assigned
        partway through a session's life (once a winner is picked) — the index
        has to pick that up on the update, not just at creation.

        It also has to *un*-file: a buyer can override the recommendation and
        settle with a different vendor, and an add-only index left the order
        sitting in the losing vendor's queue forever, asking it to accept a
        deal it had not won.
        """
        session_id = session["id"]
        buyer = session.get("buyer_business_id")
        seller = session.get("seller_business_id")

        previous_buyer, previous_seller = self._filed_under.get(
            session_id, (None, None)
        )
        if previous_buyer and previous_buyer != buyer:
            self._by_buyer.get(previous_buyer, set()).discard(session_id)
        if previous_seller and previous_seller != seller:
            self._by_seller.get(previous_seller, set()).discard(session_id)

        if buyer:
            self._by_buyer.setdefault(buyer, set()).add(session_id)
        if seller:
            self._by_seller.setdefault(seller, set()).add(session_id)
        self._filed_under[session_id] = (buyer, seller)

    def _evict(self) -> None:
        """Trim the hot tier back to `max_hot`, oldest-touched first. The
        indices deliberately keep the evicted id: they map to ids, not
        objects, so they stay correct and `get()` will page the session back
        in from disk on demand."""
        while len(self._hot) > self._max_hot:
            self._hot.popitem(last=False)

    # ── reads ─────────────────────────────────────────────────────────────

    def get_many(self, session_ids: Iterator[str] | set[str]) -> list[dict[str, Any]]:
        found = [self.get(sid) for sid in session_ids]
        return [s for s in found if s is not None]

    def by_buyer(self, business_id: str) -> list[dict[str, Any]]:
        with self._lock:
            ids = set(self._by_buyer.get(business_id, ()))
        return self.get_many(ids)

    def by_seller(self, business_id: str) -> list[dict[str, Any]]:
        with self._lock:
            ids = set(self._by_seller.get(business_id, ()))
        return self.get_many(ids)

    def recent(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            ids = list(self._recent)[:limit]
        return self.get_many(ids)

    def all_sessions(self) -> list[dict[str, Any]]:
        """Every session the store knows about. O(n) with disk reads for
        evicted entries — intended for admin/metrics paths, not hot ones."""
        with self._lock:
            ids = set(self._known)
        return self.get_many(ids)

    def count(self) -> int:
        with self._lock:
            return len(self._known)

    def stats(self) -> dict[str, Any]:
        """Exposed on /system/stats so the console can show the tiering is
        real rather than decorative."""
        with self._lock:
            return {
                "total_sessions": len(self._known),
                "hot_resident": len(self._hot),
                "hot_capacity": self._max_hot,
                "indexed_buyers": len(self._by_buyer),
                "indexed_sellers": len(self._by_seller),
            }

    # ── boot ──────────────────────────────────────────────────────────────

    def migrate_legacy_json(self) -> int:
        """One-time import of the pre-SQLite JSON corpus.

        Runs only when the database has no sessions yet, so it is a no-op on
        every boot after the first. The JSON files are left in place rather
        than deleted — a migration that destroys its own source is a migration
        you cannot re-run when it turns out to have been wrong.
        """
        if self._db.count_sessions() > 0 or not self._dir.exists():
            return 0

        imported = 0
        for path in sorted(self._dir.glob("*.json"), key=lambda p: p.stat().st_mtime):
            try:
                with path.open() as f:
                    session = json.load(f)
            except (json.JSONDecodeError, OSError):
                # A truncated file from the old non-atomic writer. Skipping it
                # is the best available outcome; the new writer cannot produce
                # one.
                continue
            if not isinstance(session, dict) or "id" not in session:
                continue
            self._db.upsert_session(session)
            imported += 1
        return imported

    def rehydrate(self, on_session: Callable[[dict[str, Any]], None] | None = None) -> int:
        """Rebuilds `_known`, both indices and the recency deque from the
        database at startup, oldest first so `_recent` ends up newest-first.

        Without this a restart mid-demo emptied every derived view and made
        prior sessions 404 — the data was persisted the whole time, nothing
        read it back.

        Only the newest `max_hot` sessions stay resident; the rest are known
        and indexed but paged out, which is the steady state the store reaches
        under load anyway.
        """
        self.migrate_legacy_json()

        loaded = 0
        for session in self._db.iter_sessions():
            # persist=False: it came *from* the database.
            self.put(session, persist=False)
            if on_session is not None:
                on_session(session)
            loaded += 1
        return loaded
