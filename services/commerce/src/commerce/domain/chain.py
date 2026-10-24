"""The audit log's hash chain, recomputed from the stored events (business
book §11.3).

The database computes each hash when an event is written (migration V4):
hash = sha256(prev_hash || canonical text of the event). This walk recomputes
the chain event by event, from the events' canonical text as the database
renders it, and reports the first event that does not follow. It finds an
event changed, removed or reordered after the fact.

It cannot find a chain that an administrator rewrote from end to end, since
every hash then agrees with its event. That is what the exported head is for:
given a head exported earlier and kept outside the database, a chain that no
longer leads to it is reported as rewritten. Tamper-evident against that
anchor, not immutable.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

GENESIS = bytes(32)


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
    head_seq: int | None = None

    def as_dict(self) -> dict:
        return {"ok": self.ok, "events": self.events, "head": self.head.hex() if self.head else None,
                "broken_at": self.broken_at, "why": self.why}


def link(previous: bytes, canonical: str) -> bytes:
    return hashlib.sha256(previous + canonical.encode("utf-8")).digest()


class ChainWalk:
    """Feed the events in order of seq; the first broken one ends the walk."""

    def __init__(self, anchor: Anchor | None = None) -> None:
        self.anchor = anchor
        self.previous = GENESIS
        self.expected = 1
        self.events = 0
        self.anchor_seen = anchor is None
        self.failure: ChainReport | None = None

    def feed(self, seq: int, prev_hash: bytes, stored_hash: bytes, canonical: str) -> ChainReport | None:
        if self.failure is not None:
            return self.failure
        if seq != self.expected:
            why = "an event is missing" if seq > self.expected else "events are out of order"
            return self._fail(ChainReport(False, self.events, self.previous, seq, f"{why}: expected {self.expected}, found {seq}"))
        if prev_hash != self.previous:
            return self._fail(ChainReport(False, self.events, self.previous, seq, "the link to the previous event does not match"))
        computed = link(self.previous, canonical)
        if stored_hash != computed:
            return self._fail(ChainReport(False, self.events, self.previous, seq, "the event's hash does not match its content"))
        if self.anchor is not None and seq == self.anchor.seq:
            if computed != self.anchor.hash:
                return self._fail(ChainReport(False, self.events + 1, computed, seq,
                                              "the chain no longer leads to the exported head: it was rewritten"))
            self.anchor_seen = True
        self.previous = computed
        self.expected += 1
        self.events += 1
        return None

    def _fail(self, report: ChainReport) -> ChainReport:
        self.failure = report
        return report

    def finish(self) -> ChainReport:
        if self.failure is not None:
            return self.failure
        if not self.anchor_seen:
            return ChainReport(False, self.events, self.previous if self.events else None,
                               self.anchor.seq if self.anchor else None,
                               "the exported head is beyond the end of the chain: events were removed")
        return ChainReport(True, self.events, self.previous if self.events else None,
                           head_seq=self.events if self.events else None)
