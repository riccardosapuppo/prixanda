"""The audit log: append only, one chain in one order, and what the chain
really guarantees (business book §11.3)."""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import timedelta

import asyncpg

from commerce.audit import GENESIS, Anchor, head, verify_chain
from helpers import T0, audit, sqlstate_of


async def test_events_form_one_chain_from_the_genesis(db):
    for n in range(5):
        await audit(db.app, subject=f"change:{n}", at=T0 + timedelta(seconds=n))
    rows = await db.app.fetch("select seq, prev_hash, hash from audit_event order by seq")
    assert [r["seq"] for r in rows] == [1, 2, 3, 4, 5]
    assert bytes(rows[0]["prev_hash"]) == GENESIS
    assert all(bytes(b["prev_hash"]) == bytes(a["hash"]) for a, b in zip(rows, rows[1:]))
    report = await verify_chain(db.app)
    assert report.ok and report.events == 5 and report.head == bytes(rows[-1]["hash"])


async def test_the_engine_cannot_rewrite_the_log(db):
    await audit(db.app)
    assert await sqlstate_of(db.app.execute("update audit_event set reason = 'x'")) == "42501"
    assert await sqlstate_of(db.app.execute("delete from audit_event")) == "42501"
    assert await sqlstate_of(db.app.execute("truncate audit_event")) == "42501"


async def test_the_trigger_refuses_even_the_owner(db):
    await audit(db.app)
    assert await sqlstate_of(db.owner.execute("update audit_event set reason = 'x'")) == "42501"
    assert await sqlstate_of(db.owner.execute("delete from audit_event")) == "42501"
    assert await sqlstate_of(db.owner.execute("truncate audit_event")) == "42501"


async def test_forty_concurrent_writers_leave_one_unbroken_chain(db):
    connections = [await asyncpg.connect(db.url("app")) for _ in range(8)]
    try:
        async def write(n: int) -> None:
            conn = connections[n % len(connections)]
            async with conn.transaction():
                await audit(conn, subject=f"change:{n}", at=T0 + timedelta(milliseconds=n))
        # Eight connections, five events each, interleaved.
        for wave in range(5):
            await asyncio.gather(*(write(wave * 8 + i) for i in range(8)))
    finally:
        await asyncio.gather(*(c.close() for c in connections))
    report = await verify_chain(db.app)
    assert report.ok and report.events == 40
    assert await db.app.fetchval("select count(distinct prev_hash) from audit_event") == 40


async def with_trigger_off(db, statement: str, *args) -> None:
    """What only a superuser can do: switch the guard off, rewrite, switch it on."""
    async with db.owner.transaction():
        await db.owner.execute("alter table audit_event disable trigger audit_event_no_change")
        await db.owner.execute(statement, *args)
        await db.owner.execute("alter table audit_event enable trigger audit_event_no_change")


async def ten_events(db) -> None:
    for n in range(10):
        await audit(db.app, subject=f"change:{n}", reason=f"reason {n}", body={"n": n}, at=T0 + timedelta(seconds=n))


async def test_an_event_changed_after_the_fact_is_found(db):
    await ten_events(db)
    await with_trigger_off(db, "update audit_event set body = '{\"n\": 99}' where seq = 4")
    report = await verify_chain(db.app)
    assert not report.ok and report.broken_at == 4 and "content" in report.why


async def test_every_column_is_inside_the_hash(db):
    for column, value in [("reason", "rewritten"), ("request_id", "req-other"), ("actor_role", "finance"),
                          ("subject", "change:999"), ("at", T0 + timedelta(days=1))]:
        await ten_events(db)
        await with_trigger_off(db, f"update audit_event set {column} = $1 where seq = (select max(seq) - 3 from audit_event)", value)
        report = await verify_chain(db.app)
        assert not report.ok and "content" in report.why, column
        await with_trigger_off(db, "delete from audit_event")


async def test_a_removed_event_is_found(db):
    await ten_events(db)
    await with_trigger_off(db, "delete from audit_event where seq = 6")
    report = await verify_chain(db.app)
    assert not report.ok and report.broken_at == 7 and "missing" in report.why


async def test_a_chain_rewritten_from_end_to_end_is_found_only_against_the_exported_head(db):
    await ten_events(db)
    exported = await head(db.app)
    # An administrator rewrites event 3 and recomputes every later hash, so
    # that each event agrees with its own hash again.
    await with_trigger_off(db, "update audit_event set reason = 'rewritten' where seq = 3")
    rows = await db.owner.fetch(
        "select seq, jsonb_build_array(seq, to_char(at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), "
        "actor, actor_role, action, subject, request_id, reason, body)::text as canonical from audit_event order by seq")
    previous = GENESIS
    for row in rows:
        digest = hashlib.sha256(previous + row["canonical"].encode("utf-8")).digest()
        await with_trigger_off(db, "update audit_event set prev_hash = $2, hash = $3 where seq = $1", row["seq"], previous, digest)
        previous = digest
    assert (await verify_chain(db.app)).ok, "the rewritten chain is consistent with itself"
    report = await verify_chain(db.app, anchor=exported)
    assert not report.ok and report.broken_at == exported.seq and "rewritten" in report.why


async def test_an_exported_head_beyond_the_end_means_events_were_removed(db):
    await ten_events(db)
    exported = await head(db.app)
    await with_trigger_off(db, "delete from audit_event where seq >= 9")
    report = await verify_chain(db.app, anchor=exported)
    assert not report.ok and "removed" in report.why


async def test_an_empty_log_verifies_and_has_no_head(db):
    report = await verify_chain(db.app)
    assert report.ok and report.events == 0 and report.head is None
    assert await head(db.app) is None
    assert json.dumps(report.as_dict())
    assert Anchor(1, GENESIS).seq == 1
