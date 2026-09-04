"""Standalone data structures backing the orchestrator.

Kept out of `orchestrator/` on purpose: none of these import anything from
the app, so they are unit-testable in isolation and reusable if the
orchestrator is ever split across processes.
"""
