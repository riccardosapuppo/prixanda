"""Idempotency keys (migration V7).

The key is claimed at the start of the call's transaction and the outcome is
recorded in it before it commits. The claim is a row: a second call with the
same key while the first runs waits on it, then reads the first's outcome. A
key is bound to the method, the role and the request's bytes as protobuf
writes them deterministically; the same key with anything else is refused.

Keys are pruned (prune(), a job of the server): a key whose call finished
more than RETENTION ago is deleted, a key whose call is still running never
is (the database refuses it, migration V11). A retry that comes with a pruned
key runs the call again: the gateway retries within seconds, and RETENTION is
a week.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta

from commerce.domain.localtime import format_instant
from commerce.engine.call import Call, Clock
from commerce.engine.database import Connection, Database
from commerce.engine.errors import Aborted, InvalidArgument

RETENTION = timedelta(days=7)
PRUNE_BATCH = 1_000


def fingerprint(method: str, role: str | None, request) -> str:
    material = b"\n".join([method.encode(), (role or "").encode(), request.SerializeToString(deterministic=True)])
    return hashlib.sha256(material).hexdigest()


async def claim(tx: Connection, call: Call, method: str, request, now: datetime) -> bytes | None:
    """None when the key is new (the call goes on), else the recorded response."""
    digest = fingerprint(method, call.role, request)
    claimed = await tx.fetchval(
        "insert into idempotent_call (scope, key, method, request_hash, started_at, request_id) "
        "values ($1, $2, $3, decode($4, 'hex'), $5::text::timestamptz, $6) on conflict (scope, key) do nothing returning 1",
        call.scope, call.idempotency_key, method, digest, format_instant(now), call.request_id)
    if claimed:
        return None
    row = await tx.fetchrow(
        "select method, encode(request_hash, 'hex') as request_hash, encode(response, 'hex') as response "
        "from idempotent_call where scope = $1 and key = $2", call.scope, call.idempotency_key)
    if row["method"] != method or row["request_hash"] != digest:
        raise InvalidArgument("this idempotency-key was already used for another request: send a new key for a new request")
    if row["response"] is None:
        raise Aborted("a call with this idempotency-key is still running: try again shortly")
    return bytes.fromhex(row["response"])


async def complete(tx: Connection, call: Call, response, now: datetime) -> None:
    outcome = "refusal" if response.WhichOneof("outcome") == "refusal" else "answer"
    await tx.execute(
        "update idempotent_call set response = decode($3, 'hex'), outcome = $4, completed_at = $5::text::timestamptz "
        "where scope = $1 and key = $2",
        call.scope, call.idempotency_key, response.SerializeToString().hex(), outcome, format_instant(now))


async def prune(db: Database, clock: Clock, *, retention: timedelta = RETENTION, batch: int = PRUNE_BATCH) -> int:
    """Deletes the keys of calls that finished before now less the retention, a batch per transaction.
    Returns how many went."""
    cutoff = format_instant(clock.now() - retention)
    pruned = 0
    while True:
        async with db.transaction() as tx:
            gone = await tx.fetchval(
                "with gone as (delete from idempotent_call where (scope, key) in (select scope, key from idempotent_call "
                "where completed_at < $1::text::timestamptz order by completed_at limit $2) returning 1) "
                "select count(*) from gone", cutoff, batch)
        pruned += gone
        if gone < batch:
            return pruned
