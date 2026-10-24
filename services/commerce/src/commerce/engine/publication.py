"""Publishing the catalog, and the minimal activation (business book §7.5).

publish() writes a new snapshot of the offers that are active, and moves the
live pointer to it by adding a publication, in the caller's transaction.
activate() is one transaction: the change goes from scheduled to active, a
list price enters the price list, the catalog is published, and every step
writes its audit event. If anything fails, nothing of it is visible.

Activation runs a little before a change's start (LEAD): an offer's period
and a list price's validity are dated, so the site shows the offer, and the
new price applies, exactly at the local start. A run that comes late applies
a list price from the moment it really ran, and the price list says so.

Stage 6 wraps activate() in a job with an outbox, steps and recovery; until
then the server calls activate_due() and end_due() on a timer.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from commerce.domain.localtime import format_instant, format_local, parse_instant, to_instant, to_local
from commerce.domain.offers import ListPrice, Offer, from_json
from commerce.domain.sentence import audience_words
from commerce.engine import clashes, records, reference
from commerce.engine.call import Clock
from commerce.engine.database import Connection, Database, utc_text
from commerce.engine.errors import FailedPrecondition

# One publisher at a time: the snapshot is computed from the state under this
# lock, so publications are ordered as they commit. (V4 uses 4600011 for the
# audit chain.)
PUBLICATION_LOCK = 4_600_021
LEAD = timedelta(minutes=1)
SYSTEM_ACTOR, SYSTEM_ROLE = "activation", "system"


def job_request_id(kind: str) -> str:
    return f"{kind}-{secrets.token_hex(12)}"


def _ceil_second(moment: datetime) -> datetime:
    whole = moment.replace(microsecond=0)
    return whole if whole == moment else whole + timedelta(seconds=1)


@dataclass(frozen=True)
class Outcome:
    change_id: int
    action: str  # activated, ended, skipped, refused, failed
    snapshot_id: int | None = None
    error: str | None = None


class Publisher:
    async def lock(self, tx: Connection) -> None:
        await tx.execute("select pg_advisory_xact_lock($1)", PUBLICATION_LOCK)

    async def live_snapshot(self, tx: Connection, at: datetime) -> int | None:
        """The snapshot live at an instant: of the publications made by then, the last one.
        The sequence decides which is last; publish() keeps the times in the same order."""
        return await tx.fetchval(
            "select snapshot_id from catalog_publication where published_at <= $1::text::timestamptz "
            "order by seq desc limit 1", format_instant(at))

    async def publication_time(self, tx: Connection, now: datetime) -> datetime:
        """The time to publish at, under the lock: now, or the latest publication's time if that is later."""
        latest = await tx.fetchval(
            f"select {utc_text('published_at')} from catalog_publication order by seq desc limit 1")
        return now if latest is None else max(now, parse_instant(latest))

    async def publish(self, tx: Connection, *, now: datetime, actor: str, role: str, request_id: str, cause: dict) -> int:
        """A snapshot of the active offers, made live. The caller holds the publication lock.

        The publication's time is taken under the lock and is never before the
        latest publication: a caller that read its clock earlier (an activation
        pass that waited for the lock while a suspension published) would
        otherwise publish later in the sequence with an earlier time."""
        await self.lock(tx)
        now = await self.publication_time(tx, now)
        previous = await tx.fetchval("select snapshot_id from catalog_publication order by seq desc limit 1")
        ref = await reference.load(tx, now)
        snapshot = await tx.fetchval(
            "insert into catalog_snapshot (created_at, created_by, request_id, cause) "
            "values ($1::text::timestamptz, $2, $3, $4::text::jsonb) returning id",
            format_instant(now), actor, request_id, json.dumps(cause))
        rows = await tx.fetch(
            "select c.id, c.current_version, v.content::text as content from change c "
            "join change_version v on v.change_id = c.id and v.version = c.current_version "
            "where c.kind = 'offer' and c.state = 'active' order by c.id")
        offers = 0
        for row in rows:
            offer = from_json(json.loads(row["content"]))
            assert isinstance(offer, Offer)
            artists = await reference.artist_names(tx, {offer.audience.listening.artist_id} if offer.audience.listening else set())
            for price in offer.prices:
                market = ref.markets[price.market]
                period, page = offer.period_in(price.market), offer.page_in(price.market)
                if period is None or period.starts is None or page is None:
                    raise FailedPrecondition(f"change #{row['id']} is active without a period or a page in {price.market}")
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
        await tx.execute(
            "insert into catalog_publication (snapshot_id, published_at, published_by, request_id) "
            "values ($1, $2::text::timestamptz, $3, $4)", snapshot, format_instant(now), actor, request_id)
        await records.record(tx, at=now, actor=actor, role=role, action="catalog.published", subject=f"catalog:{snapshot}",
                             request_id=request_id, body={"snapshot": snapshot, "previous": previous, "offers": offers, "cause": cause})
        return snapshot

    async def activate(self, tx: Connection, change_id: int, now: datetime, request_id: str) -> Outcome:
        await self.lock(tx)
        now = await self.publication_time(tx, now)
        change = await records.lock_change(tx, change_id)
        if change.state != "scheduled":
            return Outcome(change_id, "skipped")
        content, _, _ = await records.version_content(tx, change.id, change.current_version)
        ref = await reference.load(tx, now)
        if isinstance(content, Offer):
            # The publication lock makes activations go one at a time: an offer
            # that clashes with one already live stays scheduled, off the site.
            clash = await clashes.first_clash(tx, content, change.id, ("active",), ref, now)
            if clash is not None:
                return Outcome(change.id, "refused", error=clash.words(ref.markets[clash.market].name, content.group)
                               + " It stays scheduled: cancel one of them.")
        body: dict = {"change": change.id, "version": change.current_version, "from": "scheduled", "to": "active"}
        if isinstance(content, ListPrice):
            market = ref.markets[content.market]
            local_now = to_local(now, market.zone)
            effective = content.starts if content.starts > local_now else _ceil_second(local_now)
            previous = await tx.fetchrow(
                "select id, to_char(lower(valid), 'YYYY-MM-DD\"T\"HH24:MI:SS') as starts, change_id from list_price "
                "where plan_id = $1 and market = $2 and upper_inf(valid) for update", content.plan, content.market)
            if previous is not None:
                if datetime.fromisoformat(previous["starts"]) >= effective:
                    raise FailedPrecondition(f"the open {content.plan} price in {content.market} starts at or after "
                                             f"{format_local(effective)}: the new price would overlap it")
                await tx.execute("update list_price set valid = tsrange(lower(valid), $2::text::timestamp) where id = $1",
                                 previous["id"], format_local(effective))
            await tx.execute(
                "insert into list_price (plan_id, market, currency, amount_minor, valid, change_id) "
                "values ($1, $2, $3, $4, tsrange($5::text::timestamp, null), $6)",
                content.plan, content.market, market.currency, content.amount.amount, format_local(effective), change.id)
            body.update({"market": content.market, "plan": content.plan, "amount": content.amount.amount,
                         "starts": format_local(content.starts), "effective": format_local(effective)})
            if previous is not None and previous["change_id"] is not None:
                await self._end_superseded(tx, previous["change_id"], now, request_id)
        await tx.execute("update change set state = 'active', updated_at = $2::text::timestamptz where id = $1",
                         change.id, format_instant(now))
        await records.record(tx, at=now, actor=SYSTEM_ACTOR, role=SYSTEM_ROLE, action="change.activated",
                             subject=f"change:{change.id}", request_id=request_id, body=body)
        snapshot = await self.publish(tx, now=now, actor=SYSTEM_ACTOR, role=SYSTEM_ROLE, request_id=request_id,
                                      cause={"activated": change.id})
        return Outcome(change.id, "activated", snapshot)

    async def _end_superseded(self, tx: Connection, change_id: int, now: datetime, request_id: str) -> None:
        """A list price change ends when a later one closes its price."""
        state = await tx.fetchval("select state from change where id = $1 for update", change_id)
        if state == "active":
            await tx.execute("update change set state = 'ended', updated_at = $2::text::timestamptz where id = $1",
                             change_id, format_instant(now))
            await records.record(tx, at=now, actor=SYSTEM_ACTOR, role=SYSTEM_ROLE, action="change.ended",
                                 subject=f"change:{change_id}", request_id=request_id,
                                 body={"change": change_id, "from": "active", "to": "ended", "why": "superseded"})

    async def end(self, tx: Connection, change_id: int, now: datetime, request_id: str) -> Outcome:
        await self.lock(tx)
        now = await self.publication_time(tx, now)
        change = await records.lock_change(tx, change_id)
        if change.state != "active" or change.kind != "offer":
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


async def activate_due(db: Database, clock: Clock, publisher: Publisher, *, lead: timedelta = LEAD) -> list[Outcome]:
    """Activates every scheduled change whose first local start is within `lead` of now, one transaction each."""
    now = clock.now()
    zones = await _zones(db, now)
    outcomes = []
    for change_id, content in await _changes_in(db, "scheduled"):
        if isinstance(content, ListPrice):
            starts = [to_instant(content.starts, zones[content.market])]
        else:
            starts = [to_instant(p.starts, zones[p.market]) for p in content.periods if p.starts is not None]
        if not starts or min(starts) - lead > now:
            continue
        try:
            async with db.transaction() as tx:
                outcomes.append(await publisher.activate(tx, change_id, now, job_request_id("activation")))
        except Exception as error:  # one failed activation does not stop the others; stage 6 adds retries
            outcomes.append(Outcome(change_id, "failed", error=f"{type(error).__name__}: {error}"))
    return outcomes


async def end_due(db: Database, clock: Clock, publisher: Publisher) -> list[Outcome]:
    """Ends every active offer whose periods are all over, and publishes the catalog without it."""
    now = clock.now()
    zones = await _zones(db, now)
    outcomes = []
    for change_id, content in await _changes_in(db, "active"):
        if not isinstance(content, Offer):
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
