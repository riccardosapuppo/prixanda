"""Recomputes the audit log's hash chain from the stored events, for the
invariants command and the database tests, on one asyncpg connection.

The walk itself, and what it does and does not guarantee, is in
commerce.domain.chain; the engine's AuditService runs the same walk through
its database interface. The canonical text is rendered with PostgreSQL's
built-in functions only (qualified with pg_catalog, so a function redefined
in the schema cannot answer for them), exactly as the trigger of migration V4
renders it when it computes the hash.
"""

from __future__ import annotations

from commerce.domain.chain import GENESIS, Anchor, ChainReport, ChainWalk

__all__ = ["CANONICAL", "GENESIS", "Anchor", "ChainReport", "head", "verify_chain"]

CANONICAL = """
select seq, hash, prev_hash,
       pg_catalog.jsonb_build_array(
         seq,
         pg_catalog.to_char(pg_catalog.timezone('UTC', at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         actor, actor_role, action, subject, request_id, reason, body
       )::text as canonical
from audit_event
order by seq
"""


async def verify_chain(connection, anchor: Anchor | None = None) -> ChainReport:
    """Walks the whole log in order; the first event that does not follow is reported."""
    walk = ChainWalk(anchor)
    async with connection.transaction(readonly=True, isolation="repeatable_read"):
        async for row in connection.cursor(CANONICAL, prefetch=2000):
            if walk.feed(row["seq"], bytes(row["prev_hash"]), bytes(row["hash"]), row["canonical"]) is not None:
                break
    return walk.finish()


async def head(connection) -> Anchor | None:
    """The current head, to export and keep outside the database."""
    row = await connection.fetchrow("select seq, hash from audit_event order by seq desc limit 1")
    return Anchor(row["seq"], bytes(row["hash"])) if row else None
