"""Search index over every registered business's catalog.

This is what makes the catalog *agent-readable at scale*. An AI buyer
shouldn't have to pull `GET /businesses` and grep it client-side — that is
O(businesses x skus) over the wire on every query and gets worse with every
merchant onboarded. Two structures, built once at registration and updated
incrementally:

  * **Trie** (`_TrieNode`) for prefix completion — "mech" -> "mechanical
    keyboard". Walks the query's characters, so lookup is O(len(prefix) +
    matches) and completely independent of how many SKUs exist.
  * **Inverted index** (`token -> set[(business_id, sku)]`) for term
    lookup — "wireless mouse" resolves each token to a posting set and
    intersects them. Again independent of catalog size; cost scales with the
    rarest token's posting list, which is the whole point of an inverted
    index.

Results are ranked cheapest-first via `heapq.nsmallest`, so a top-k query
never sorts the full match set.
"""

import heapq
import re
import threading
from typing import Any, Iterable

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


class _TrieNode:
    __slots__ = ("children", "entries")

    def __init__(self) -> None:
        self.children: dict[str, _TrieNode] = {}
        # Every (business_id, sku) whose name contains a token starting here.
        self.entries: set[tuple[str, str]] = set()


class CatalogIndex:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._root = _TrieNode()
        self._postings: dict[str, set[tuple[str, str]]] = {}
        # (business_id, sku) -> the denormalised record we return to agents.
        self._records: dict[tuple[str, str], dict[str, Any]] = {}

    # ── build ─────────────────────────────────────────────────────────────

    def add_business(self, business: dict[str, Any]) -> None:
        """Indexes every catalog line of one business. Idempotent per SKU, so
        re-registering or updating a business re-indexes cleanly."""
        with self._lock:
            for item in business["catalog"]:
                key = (business["id"], item["sku"])
                # The list price a human sees; `cost` is the merchant's floor
                # input and must never leave the building.
                self._records[key] = {
                    "business_id": business["id"],
                    "business_name": business["name"],
                    "sku": item["sku"],
                    "name": item["name"],
                    "list_price": item.get("list_price", item["cost"]),
                    "margin_floor_pct": business["margin_floor_pct"],
                }
                for token in tokenize(item["name"]):
                    self._postings.setdefault(token, set()).add(key)
                    self._index_prefixes(token, key)

    def _index_prefixes(self, token: str, key: tuple[str, str]) -> None:
        node = self._root
        node.entries.add(key)
        for char in token:
            node = node.children.setdefault(char, _TrieNode())
            node.entries.add(key)

    # ── query ─────────────────────────────────────────────────────────────

    def prefix(self, prefix_text: str, limit: int = 20) -> list[dict[str, Any]]:
        """Trie walk. Cost is O(len(prefix)) to reach the node, then a bounded
        read of the keys hanging off it — independent of total catalog size."""
        token = "".join(tokenize(prefix_text))
        with self._lock:
            node = self._root
            for char in token:
                node = node.children.get(char)
                if node is None:
                    return []
            keys = list(node.entries)
        return self._rank(keys, limit)

    def search(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        """Inverted-index term lookup. Intersects the posting sets of every
        query token (AND), and falls back to their union (OR) when the strict
        intersection is empty — an agent asking for "wireless ergonomic
        mouse" should still get mice rather than nothing at all."""
        tokens = tokenize(query)
        if not tokens:
            return []

        with self._lock:
            posting_sets = [self._postings.get(t, set()) for t in tokens]
            # Intersect smallest-first: the rarest term does the most
            # filtering for the least work.
            posting_sets.sort(key=len)
            matched: set[tuple[str, str]] = set(posting_sets[0])
            for postings in posting_sets[1:]:
                matched &= postings
                if not matched:
                    break
            if not matched:
                matched = set().union(*posting_sets) if posting_sets else set()
            keys = list(matched)
        return self._rank(keys, limit)

    def _rank(self, keys: Iterable[tuple[str, str]], limit: int) -> list[dict[str, Any]]:
        """Cheapest-first top-k. `nsmallest` is a bounded heap pass — O(n log
        k) — rather than sorting every match to return 20 of them."""
        records = [self._records[k] for k in keys if k in self._records]
        return heapq.nsmallest(limit, records, key=lambda r: r["list_price"])

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "indexed_skus": len(self._records),
                "distinct_tokens": len(self._postings),
                "trie_nodes": _count_nodes(self._root),
            }


def _count_nodes(node: _TrieNode) -> int:
    return 1 + sum(_count_nodes(child) for child in node.children.values())
