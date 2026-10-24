"""Recomputes the audit log's hash chain from the stored events.

The database computes each hash when an event is written (migration V4).
This check recomputes them independently, from the stored values, with
PostgreSQL's built-in functions only (qualified with pg_catalog, so a
function redefined in the schema cannot answer for them). It finds an event
that was changed, removed or reordered after the fact.

It cannot find a chain that an administrator rewrote from end to end, since
every hash then agrees with its event. That is what the exported head is for
(business book §11.3): pass the head exported earlier, kept outside the
database, and a chain that no longer leads to it is reported as rewritten.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

GENESIS = bytes(32)

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


@dataclass(frozen=True)
class Anchor:
    """A head of the chain exported earlier: the last sequence number and its hash."""

    seq: int
    hash: bytes


@dataclass(frozen=True)
class ChainReport:
    ok: bool
    events: int
    head: bytes | None
    broken_at: int | None = None
    why: str | None = None

    def as_dict(self) -> dict:
        return {"ok": self.ok, "events": self.events, "head": self.head.hex() if self.head else None,
                "broken_at": self.broken_at, "why": self.why}


async def verify_chain(connection, anchor: Anchor | None = None) -> ChainReport:
    """Walks the whole log in order; the first event that does not follow is reported."""
    previous = GENESIS
    expected = 1
    events = 0
    anchor_seen = anchor is None
    async with connection.transaction(readonly=True, isolation="repeatable_read"):
        async for row in connection.cursor(CANONICAL, prefetch=2000):
            seq = row["seq"]
            if seq != expected:
                why = "an event is missing" if seq > expected else "events are out of order"
                return ChainReport(False, events, previous, seq, f"{why}: expected {expected}, found {seq}")
            if bytes(row["prev_hash"]) != previous:
                return ChainReport(False, events, previous, seq, "the link to the previous event does not match")
            computed = hashlib.sha256(previous + row["canonical"].encode("utf-8")).digest()
            if bytes(row["hash"]) != computed:
                return ChainReport(False, events, previous, seq, "the event's hash does not match its content")
            if anchor is not None and seq == anchor.seq:
                if computed != anchor.hash:
                    return ChainReport(False, events + 1, computed, seq,
                                       "the chain no longer leads to the exported head: it was rewritten")
                anchor_seen = True
            previous = computed
            expected += 1
            events += 1
    if not anchor_seen:
        return ChainReport(False, events, previous if events else None, anchor.seq if anchor else None,
                           "the exported head is beyond the end of the chain: events were removed")
    return ChainReport(True, events, previous if events else None)


async def head(connection) -> Anchor | None:
    """The current head, to export and keep outside the database."""
    row = await connection.fetchrow("select seq, hash from audit_event order by seq desc limit 1")
    return Anchor(row["seq"], bytes(row["hash"])) if row else None
