"""The outbox (business book §7.5, §4.5): what the platform announces after a
commit, written in the transaction of the change it announces (migration V11).

Two kinds of message today: "catalog.published", the notice that the catalog
changed, for the site (and for the jobs of stage 7); and "payment.charge", the
first month's charge, for the payment provider. A message is delivered after
the commit by the relay, at least once: a delivery that broke before it was
marked (the engine stopped, the connection was cut) is delivered again. So
every consumer takes a message once however often it arrives: the site's
inbox keeps one row per notice and counts its arrivals; the payment provider
charges once per idempotency key, and the engine counts each of its events
once.

A message that cannot be delivered is tried again after 5, 15, 45 and 135
seconds, then every 5 minutes, and never dropped: the attempts and the last
error stay on it, and the engine's log says so at each attempt.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol

from commerce.domain.localtime import format_instant
from commerce.engine.call import Clock
from commerce.engine.database import Connection, Database, utc_text

WAITS = (5, 15, 45, 135)
LAST_WAIT = 300
BATCH = 50


def wait_after(attempts: int) -> timedelta:
    """How long a message waits after its attempts so far failed."""
    return timedelta(seconds=WAITS[attempts - 1] if 0 < attempts <= len(WAITS) else LAST_WAIT)


@dataclass(frozen=True)
class Message:
    id: int
    topic: str
    key: str
    payload: dict
    created_at: str
    request_id: str
    attempts: int
    delivered_at: str | None


class Consumer(Protocol):
    """Takes a message once, however often it arrives, and says what it did."""

    name: str
    topic: str

    async def deliver(self, message: Message) -> dict[str, object]: ...


async def write(tx: Connection, *, topic: str, key: str, payload: dict, now: datetime, request_id: str) -> int:
    """A message, in the caller's transaction: it exists if and only if what it announces committed."""
    return await tx.fetchval(
        "insert into outbox_message (topic, key, payload, created_at, request_id, available_at) "
        "values ($1, $2, $3::text::jsonb, $4::text::timestamptz, $5, $4::text::timestamptz) returning id",
        topic, key, json.dumps(payload, sort_keys=True), format_instant(now), request_id)


_COLUMNS = (f"id, topic, key, payload::text as payload, {utc_text('created_at')} as created_at, request_id, attempts, "
            f"{utc_text('delivered_at')} as delivered_at")


def _message(row) -> Message:
    return Message(row["id"], row["topic"], row["key"], json.loads(row["payload"]), row["created_at"], row["request_id"],
                   row["attempts"], row["delivered_at"])


async def load(tx: Connection, message_id: int) -> Message | None:
    row = await tx.fetchrow(f"select {_COLUMNS} from outbox_message where id = $1", message_id)
    return None if row is None else _message(row)


async def mark_delivered(tx: Connection, message_id: int, now: datetime) -> bool:
    """True when this call marked it; False when it was marked already."""
    marked = await tx.fetchval(
        "update outbox_message set delivered_at = $2::text::timestamptz, attempts = attempts + 1, last_error = null "
        "where id = $1 and delivered_at is null returning id", message_id, format_instant(now))
    return marked is not None


async def mark_failed(tx: Connection, message_id: int, now: datetime, error: str) -> int:
    """Counts a failed attempt and sets the next one; the attempts so far."""
    row = await tx.fetchrow("select attempts from outbox_message where id = $1 and delivered_at is null for update", message_id)
    if row is None:
        return 0
    attempts = row["attempts"] + 1
    await tx.execute(
        "update outbox_message set attempts = $2, available_at = $3::text::timestamptz, last_error = $4 where id = $1",
        message_id, attempts, format_instant(now + wait_after(attempts)), error[:2000])
    return attempts


@dataclass(frozen=True)
class Delivery:
    message_id: int
    topic: str
    consumer: str
    delivered: bool
    attempts: int
    facts: dict
    error: str | None = None


class Relay:
    """Delivers the messages that wait, each to the consumer of its topic."""

    def __init__(self, db: Database, clock: Clock, consumers: list[Consumer]) -> None:
        self.db = db
        self.clock = clock
        self.consumers = {consumer.topic: consumer for consumer in consumers}

    def consumer(self, topic: str) -> Consumer:
        return self.consumers[topic]

    async def deliver(self, message: Message) -> Delivery:
        """One delivery attempt: the consumer takes the message, then it is marked delivered.
        Between the two the message can be delivered again; the consumer takes it once."""
        consumer = self.consumers[message.topic]
        try:
            facts = await consumer.deliver(message)
        except Exception as error:
            text = f"{type(error).__name__}: {error}"
            async with self.db.transaction() as tx:
                attempts = await mark_failed(tx, message.id, self.clock.now(), text)
            return Delivery(message.id, message.topic, consumer.name, False, attempts, {}, text)
        async with self.db.transaction() as tx:
            await mark_delivered(tx, message.id, self.clock.now())
        return Delivery(message.id, message.topic, consumer.name, True, message.attempts + 1, facts)

    async def deliver_due(self, limit: int = BATCH) -> list[Delivery]:
        """A pass: the messages waiting since before now, oldest first."""
        async with self.db.transaction(readonly=True) as tx:
            rows = await tx.fetch(
                f"select {_COLUMNS} from outbox_message where delivered_at is null and available_at <= $1::text::timestamptz "
                "order by available_at, id limit $2", format_instant(self.clock.now()), limit)
        return [await self.deliver(_message(row)) for row in rows]


class SiteInbox:
    """The site's consumer of the catalog's notices.

    A site with a server of its own would be told over the network, and would
    then read the new catalog. Here the site is served through the gateway and
    has no server of its own, so its inbox is a table (site_notice), written in
    a transaction of its own as an outside consumer would write it: the site's
    side learns from it that the catalog changed. A notice that arrives again
    counts as an arrival of the same row, never as a second notice."""

    name = "site"
    topic = "catalog.published"

    def __init__(self, db: Database, clock: Clock) -> None:
        self.db = db
        self.clock = clock

    async def deliver(self, message: Message) -> dict[str, object]:
        async with self.db.transaction() as tx:
            arrivals = await tx.fetchval(
                "insert into site_notice (message_id, snapshot_id, publication, received_at) "
                "values ($1, $2, $3, $4::text::timestamptz) "
                "on conflict (message_id) do update set arrivals = site_notice.arrivals + 1 returning arrivals",
                message.id, message.payload["snapshot"], message.payload["publication"], format_instant(self.clock.now()))
        return {"notice": message.id, "arrivals": arrivals}
