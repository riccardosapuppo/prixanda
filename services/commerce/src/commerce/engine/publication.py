"""Publishing the catalog (business book §6.2, §7.5).

A snapshot holds the offers live at one moment, and a publication makes a
snapshot live by adding a row (migration V8): the live catalog is the snapshot
of the latest publication. build_snapshot() writes a snapshot without making
it live, so that a launch prepares one ahead (launches.py). go_live() makes a
snapshot live, in the caller's transaction, with its audit event and the
outbox's notice for the site (outbox.py). publish() does both at once, for a
suspension and for the end of an offer. The database lets a snapshot go live
only when every offer in it is active at its current version (V11).

One publisher at a time: go_live() runs under the publication lock, and the
time of a publication is never before the latest one's, so that the sequence
of the publications and their times agree.

end_due() ends the offers whose periods are all over, each in one transaction
that also publishes the catalog without it. Activation is a launch.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from datetime import datetime

from commerce.domain.localtime import format_instant, format_local, parse_instant, to_instant
from commerce.domain.offers import Offer, PrepaidPass, from_json
from commerce.domain.sentence import audience_words
from commerce.engine import outbox, records, reference
from commerce.engine.call import Clock
from commerce.engine.database import Connection, Database, utc_text
from commerce.engine.errors import FailedPrecondition

# One publisher at a time: the publication is decided under this lock, so
# publications are ordered as they commit. (V4 uses 4600011 for the audit
# chain, the clashes 4600031.)
PUBLICATION_LOCK = 4_600_021
SYSTEM_ACTOR, SYSTEM_ROLE = "activation", "system"
NOTICE = "catalog.published"


def job_request_id(kind: str) -> str:
    return f"{kind}-{secrets.token_hex(12)}"


@dataclass(frozen=True)
class Outcome:
    change_id: int
    action: str  # activated, ended, skipped, refused, failed, cancelled
    snapshot_id: int | None = None
    error: str | None = None


@dataclass(frozen=True)
class Live:
    """The latest publication."""

    seq: int
    snapshot_id: int
    published_at: datetime


@dataclass(frozen=True)
class Publication:
    seq: int
    snapshot_id: int
    previous: int | None
    event_seq: int  # its audit event
    notice: int  # its outbox message for the site


class Publisher:
    async def lock(self, tx: Connection) -> None:
        await tx.execute("select pg_advisory_xact_lock($1)", PUBLICATION_LOCK)

    async def live_snapshot(self, tx: Connection, at: datetime) -> int | None:
        """The snapshot live at an instant: of the publications made by then, the last one.
        The sequence decides which is last; go_live() keeps the times in the same order."""
        return await tx.fetchval(
            "select snapshot_id from catalog_publication where published_at <= $1::text::timestamptz "
            "order by seq desc limit 1", format_instant(at))

    async def latest(self, tx: Connection) -> Live | None:
        row = await tx.fetchrow(
            f"select seq, snapshot_id, {utc_text('published_at')} as published_at from catalog_publication "
            "order by seq desc limit 1")
        return None if row is None else Live(row["seq"], row["snapshot_id"], parse_instant(row["published_at"]))

    async def publication_time(self, tx: Connection, now: datetime) -> datetime:
        """The time to publish at, under the lock: now, or the latest publication's time if that is later."""
        latest = await self.latest(tx)
        return now if latest is None else max(now, latest.published_at)

    async def build_snapshot(self, tx: Connection, *, now: datetime, actor: str, request_id: str, cause: dict,
                             launching: int | None = None) -> tuple[int, int]:
        """A snapshot of the active offers, and of the offer being launched if one is named; not live.
        Returns the snapshot and how many offers it holds, one per market."""
        ref = await reference.load(tx, now)
        snapshot = await tx.fetchval(
            "insert into catalog_snapshot (created_at, created_by, request_id, cause) "
            "values ($1::text::timestamptz, $2, $3, $4::text::jsonb) returning id",
            format_instant(now), actor, request_id, json.dumps(cause, sort_keys=True))
        rows = await tx.fetch(
            "select c.id, c.current_version, v.content::text as content from change c "
            "join change_version v on v.change_id = c.id and v.version = c.current_version "
            "where c.kind = 'offer' and (c.state = 'active' or (c.id = $1 and c.state = 'scheduled')) order by c.id",
            launching or 0)
        offers = 0
        for row in rows:
            offer = from_json(json.loads(row["content"]))
            assert isinstance(offer, Offer)
            artists = await reference.artist_names(tx, {offer.audience.listening.artist_id} if offer.audience.listening else set())
            for price in offer.prices:
                market = ref.markets[price.market]
                period, page = offer.period_in(price.market), offer.page_in(price.market)
                if period is None or period.starts is None or page is None:
                    raise FailedPrecondition(f"change #{row['id']} has no period or no page in {price.market}")
                starts_at = to_instant(period.starts, market.zone)
                ends_at = to_instant(period.ends, market.zone) if period.ends is not None else None
                if ends_at is not None and ends_at <= now:
                    continue  # over in this market: nothing to show
                a = offer.audience
                await tx.execute(
                    "insert into catalog_offer (snapshot_id, change_id, version, market, currency, plan_id, fixed_minor, "
                    "percent_off_bp, months, starts_local, ends_local, starts_at, ends_at, title, body, terms, treatment, "
                    "audience, audience_words, needs_student_check, group_name, redemption_cap) values ($1, $2, $3, $4, $5, $6, "
                    "$7, $8, $9, $10::text::timestamp, $11::text::timestamp, $12::text::timestamptz, $13::text::timestamptz, "
                    "$14, $15, $16, $17, $18::text::jsonb, $19, $20, $21, $22)",
                    snapshot, row["id"], row["current_version"], price.market, market.currency, offer.plan,
                    price.fixed.amount if price.fixed is not None else None, price.percent_off_bp,
                    offer.months_at_offer_price, format_local(period.starts),
                    format_local(period.ends) if period.ends is not None else None, format_instant(starts_at),
                    format_instant(ends_at) if ends_at is not None else None, page.title, page.text, page.terms,
                    page.treatment, json.dumps({"segment": a.segment, "current_plan": a.current_plan,
                                                "needs_student_check": a.needs_student_check,
                                                "listening": None if a.listening is None else {
                                                    "artist_id": a.listening.artist_id, "min_seconds": a.listening.min_seconds,
                                                    "within_days": a.listening.within_days}}),
                    audience_words(a, market.name, plan_names={p.id: p.name for p in ref.plans.values()}, artist_names=artists),
                    a.needs_student_check, offer.group, offer.redemption_cap)
                offers += 1
        return snapshot, offers

    async def go_live(self, tx: Connection, snapshot: int, *, now: datetime, actor: str, role: str, request_id: str,
                      cause: dict, offers: int) -> Publication:
        """Makes a snapshot live. The caller holds the publication lock and took now from publication_time().
        The audit event and the outbox's notice for the site are written in the same transaction."""
        latest = await self.latest(tx)
        previous = latest.snapshot_id if latest is not None else None
        seq = await tx.fetchval(
            "insert into catalog_publication (snapshot_id, published_at, published_by, request_id) "
            "values ($1, $2::text::timestamptz, $3, $4) returning seq", snapshot, format_instant(now), actor, request_id)
        notice = await outbox.write(tx, topic=NOTICE, key=f"publication:{seq}", now=now, request_id=request_id, payload={
            "snapshot": snapshot, "publication": seq, "previous": previous, "published_at": format_instant(now),
            "cause": cause})
        event_seq = await records.record(
            tx, at=now, actor=actor, role=role, action="catalog.published", subject=f"catalog:{snapshot}", request_id=request_id,
            body={"snapshot": snapshot, "previous": previous, "offers": offers, "cause": cause, "notice": notice})
        return Publication(seq, snapshot, previous, event_seq, notice)

    async def publish(self, tx: Connection, *, now: datetime, actor: str, role: str, request_id: str, cause: dict) -> int:
        """A snapshot of the active offers, made live at once: for a suspension and for the end of an offer."""
        await self.lock(tx)
        now = await self.publication_time(tx, now)
        snapshot, offers = await self.build_snapshot(tx, now=now, actor=actor, request_id=request_id, cause=cause)
        await self.go_live(tx, snapshot, now=now, actor=actor, role=role, request_id=request_id, cause=cause, offers=offers)
        return snapshot

    async def end(self, tx: Connection, change_id: int, now: datetime, request_id: str) -> Outcome:
        await self.lock(tx)
        now = await self.publication_time(tx, now)
        change = await records.lock_change(tx, change_id)
        if change.state != "active" or change.kind not in ("offer", "prepaid"):
            return Outcome(change_id, "skipped")
        await tx.execute("update change set state = 'ended', updated_at = $2::text::timestamptz where id = $1",
                         change.id, format_instant(now))
        await records.record(tx, at=now, actor=SYSTEM_ACTOR, role=SYSTEM_ROLE, action="change.ended",
                             subject=f"change:{change.id}", request_id=request_id,
                             body={"change": change.id, "version": change.current_version, "from": "active", "to": "ended",
                                   "why": "every period is over"})
        snapshot = await self.publish(tx, now=now, actor=SYSTEM_ACTOR, role=SYSTEM_ROLE, request_id=request_id,
                                      cause={"ended": change.id})
        return Outcome(change.id, "ended", snapshot)


async def _changes_in(db: Database, state: str) -> list[tuple[int, object]]:
    async with db.transaction(readonly=True) as tx:
        rows = await tx.fetch(
            "select c.id, v.content::text as content from change c "
            "join change_version v on v.change_id = c.id and v.version = c.current_version where c.state = $1 order by c.id",
            state)
        return [(row["id"], from_json(json.loads(row["content"]))) for row in rows]


async def _zones(db: Database, now: datetime) -> dict[str, str]:
    async with db.transaction(readonly=True) as tx:
        return {code: m.zone for code, m in (await reference.load(tx, now)).markets.items()}


async def end_due(db: Database, clock: Clock, publisher: Publisher) -> list[Outcome]:
    """Ends every active offer, and every prepaid pass, whose periods are all over, and publishes the catalog."""
    now = clock.now()
    zones = await _zones(db, now)
    outcomes = []
    for change_id, content in await _changes_in(db, "active"):
        if not isinstance(content, (Offer, PrepaidPass)):
            continue
        ends = [p.ends for p in content.periods]
        if not ends or any(e is None for e in ends):
            continue
        if all(to_instant(p.ends, zones[p.market]) <= now for p in content.periods):
            try:
                async with db.transaction() as tx:
                    outcomes.append(await publisher.end(tx, change_id, now, job_request_id("ending")))
            except Exception as error:
                outcomes.append(Outcome(change_id, "failed", error=f"{type(error).__name__}: {error}"))
    return outcomes
