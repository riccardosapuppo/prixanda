"""Launches (business book §7.5, §14.6): the activation of a scheduled change,
run as a job of steps kept in PostgreSQL (migration V11).

A launch begins when its change is due, a minute before the change's first
local start (LEAD), and runs its steps in order:

  check    the change is still scheduled at its approved version, and nothing
           stands in its way: no offer of its group live for the same people
           (§6.4), no later price for the same plan and market (§4.1)
  prepare  the new snapshot is written, not yet live
  publish  one transaction: the change becomes active (a list price enters the
           price list and ends the one it replaces), the snapshot goes live,
           and the audit events and the outbox's notice for the site are
           written. The prepared snapshot goes live when nothing was published
           since it was prepared; otherwise a fresh one is built here, under
           the publication lock
  notify   the notice reaches the site's inbox, at least once
  verify   the live catalog, or the price list, shows the change as approved

Each attempt of a step is two transactions: the first marks the step running
and counts the attempt, the second does the step's work and marks it done.
A fault anywhere (the engine stopped, the connection cut) leaves the step
either done with all its work, or running with none of it; the next pass, of
this engine or of another after a restart, resumes at the first step not
done, and counts the attempt that was cut short as a failure. The database
refuses to do a done step again, and the publish step is done if and only if
its change went active in the same transaction (V11): a launch publishes
once, however often it resumes.

A step that fails waits 5, 15, 45 and 135 seconds before its next attempts;
after 5 failures in a row the launch fails and opens an incident. A check
that finds a clash or a later price refuses the launch at once, with an
incident: trying again would find the same, until a person changes
something and retries. A scheduled change not live LATE_AFTER its start
opens a "late" incident: the alarm. An incident closes when its launch goes
through (recovered, when nobody acted; resolved, when a person retried it)
or is cancelled (resolved).

A pass returns what changed, each change of state once, for the server's
log: a launch that waits, or that was refused, writes nothing more until
something happens to it.

The probe is how the fault-injection tests stop the engine, or cut its
connection, inside a step: it is called in the step's transaction, at its
start and before it commits. The server's entry point passes none, and no
setting turns one on.

Limit, written down: two engines may work on one launch at the same moment.
Every step is safe to run twice (the publish step under the publication lock
and the change's state), and the attempts then count one too many.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from commerce.domain import policy
from commerce.domain.localtime import describe_local, format_instant, format_local, parse_instant, to_instant, to_local
from commerce.domain.offers import ListPrice, Offer, PrepaidPass, PriceMigration, from_json
from commerce.engine import clashes, contract, migrations, outbox, prepaid, records, reference
from commerce.engine.call import Call, Clock
from commerce.engine.database import Connection, Database, utc_text
from commerce.engine.errors import InvalidArgument, NotFound, Refused
from commerce.engine.publication import SYSTEM_ACTOR, SYSTEM_ROLE, Publisher
from commerce.v1 import common_pb2, launches_pb2

STEPS = ("check", "prepare", "publish", "notify", "verify")
PURPOSES = {
    "check": "The change is still scheduled at its approved version, and nothing clashes with it.",
    "prepare": "The new catalog snapshot is written, not yet live.",
    "publish": "In one transaction: the change becomes active, the snapshot goes live, and the audit events and "
               "the site's notice are written.",
    "notify": "The outbox delivers the notice to the site's inbox.",
    "verify": "The live catalog, or the price list, shows the change as approved.",
}
LEAD = timedelta(minutes=1)
LATE_AFTER = timedelta(minutes=5)
MAX_FAILURES = 5
WAITS = (5, 15, 45, 135)  # seconds after the 1st, 2nd, 3rd and 4th failure in a row
PAGE_DEFAULT, PAGE_MAX = 50, 200
REASON_MAX = 2_000
STATE = launches_pb2.LaunchState
STEP_STATE = launches_pb2.LaunchStepState

Probe = Callable[[str, str, Connection], Awaitable[None]]


def run_id(launch_id: int) -> str:
    """The identifier a launch's audit events and log lines carry."""
    return f"launch-{launch_id}"


class Refusal(Exception):
    """What the check found: trying again would find the same. The launch is refused."""

    def __init__(self, reason: str, facts: dict[str, object]) -> None:
        super().__init__(reason)
        self.reason = reason
        self.facts = facts


class Withdrawn(Exception):
    """The change is not scheduled at the launch's version any more: there is nothing to launch."""


class NotVerified(Exception):
    """The live catalog, or the price list, does not show the change as it was published."""


@dataclass(frozen=True)
class Happened:
    """One change of state, for the log."""

    event: str
    launch: int
    change: int
    detail: dict[str, object] = field(default_factory=dict)

    @property
    def level(self) -> str:
        warnings = ("launch_step_interrupted", "launch_step_failed", "launch_failed", "launch_refused", "incident_opened")
        return "warning" if self.event in warnings else "info"


@dataclass(frozen=True)
class LaunchRow:
    id: int
    change_id: int
    version: int
    kind: str
    state: str
    title: str
    starts_market: str
    starts_local: str
    starts_at: str
    retry_at: str | None
    retried_by: str | None
    cause: str | None


@dataclass(frozen=True)
class StepRow:
    name: str
    state: str
    attempts: int
    failures: int
    error: str | None
    facts: dict


_LAUNCH = (f"select l.id, l.change_id, l.version, l.kind, l.state, c.title, l.starts_market, "
           f"to_char(l.starts_local, 'YYYY-MM-DD\"T\"HH24:MI') as starts_local, {utc_text('l.starts_at')} as starts_at, "
           f"{utc_text('l.retry_at')} as retry_at, l.retried_by, l.cause from launch l join change c on c.id = l.change_id ")


def _launch(row) -> LaunchRow:
    return LaunchRow(row["id"], row["change_id"], row["version"], row["kind"], row["state"], row["title"],
                     row["starts_market"].strip(), row["starts_local"], row["starts_at"], row["retry_at"], row["retried_by"],
                     row["cause"])


async def _lock(tx: Connection, launch_id: int) -> LaunchRow | None:
    await tx.execute("select id from launch where id = $1 for update", launch_id)
    row = await tx.fetchrow(_LAUNCH + "where l.id = $1", launch_id)
    return None if row is None else _launch(row)


async def _step(tx: Connection, launch_id: int, name: str) -> StepRow:
    row = await tx.fetchrow("select name, state, attempts, failures, error, facts::text as facts from launch_step "
                            "where launch_id = $1 and name = $2", launch_id, name)
    return StepRow(row["name"], row["state"], row["attempts"], row["failures"], row["error"], json.loads(row["facts"]))


async def _link(tx: Connection, launch_id: int, *seqs: int) -> None:
    for seq in seqs:
        await tx.execute("insert into launch_event (launch_id, seq) values ($1, $2) on conflict do nothing", launch_id, seq)


def _text(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"[:2000]


def _ceil_second(moment: datetime) -> datetime:
    whole = moment.replace(microsecond=0)
    return whole if whole == moment else whole + timedelta(seconds=1)


async def _open_incident(tx: Connection, launch: LaunchRow, kind: str, summary: str, now: datetime) -> Happened | None:
    opened = await tx.fetchval(
        "insert into incident (launch_id, kind, summary, opened_at) values ($1, $2, $3, $4::text::timestamptz) "
        "on conflict (launch_id) where state = 'open' do nothing returning id",
        launch.id, kind, summary[:2000], format_instant(now))
    if opened is None:
        return None  # one is open already: it stays the one to look at
    return Happened("incident_opened", launch.id, launch.change_id, {"incident": opened, "kind": kind, "summary": summary})


async def _close_incidents(tx: Connection, launch: LaunchRow, now: datetime, *, by: str | None, resolution: str,
                           person: bool) -> list[Happened]:
    rows = await tx.fetch(
        "update incident set state = $2, closed_at = $3::text::timestamptz, closed_by = $4, resolution = $5 "
        "where launch_id = $1 and state = 'open' returning id",
        launch.id, "resolved" if person else "recovered", format_instant(now), by, resolution[:2000])
    return [Happened("incident_closed", launch.id, launch.change_id,
                     {"incident": r["id"], "state": "resolved" if person else "recovered", "resolution": resolution})
            for r in rows]


async def withdraw(tx: Connection, change_id: int, *, actor: str | None, role: str, reason: str, now: datetime,
                   request_id: str, events: tuple[int, ...] = ()) -> list[Happened]:
    """The launch of a change cancelled before it published, in the cancellation's transaction:
    the launch is cancelled, its incident resolved. Nothing when the change has no launch."""
    launch_id = await tx.fetchval("select id from launch where change_id = $1", change_id)
    if launch_id is None:
        return []
    launch = await _lock(tx, launch_id)
    if launch.state in ("done", "cancelled"):
        return []
    who = actor or "a change made outside the platform's calls"
    resolution = f"cancelled by {who} at {format_instant(now)}: {reason}"
    await tx.execute("update launch set state = 'cancelled', finished_at = $2::text::timestamptz, retry_at = null, "
                     "resolution = $3 where id = $1", launch.id, format_instant(now), resolution[:2000])
    happened = [Happened("launch_cancelled", launch.id, launch.change_id, {"by": who, "reason": reason})]
    happened += await _close_incidents(tx, launch, now, by=actor, resolution=resolution, person=True)
    linked = list(events)
    if actor is not None:
        linked.append(await records.record(
            tx, at=now, actor=actor, role=role, action="launch.cancelled", subject=f"launch:{launch.id}", request_id=request_id,
            reason=reason, body={"launch": launch.id, "change": launch.change_id, "from": launch.state, "to": "cancelled"}))
    await _link(tx, launch.id, *linked)
    return happened


class Launches:
    def __init__(self, db: Database, clock: Clock, publisher: Publisher, relay: outbox.Relay, *,
                 probe: Probe | None = None) -> None:
        self.db = db
        self.clock = clock
        self.publisher = publisher
        self.relay = relay
        self.probe = probe

    async def _probe(self, step: str, phase: str, tx: Connection) -> None:
        if self.probe is not None:
            await self.probe(step, phase, tx)

    # -- a pass ---------------------------------------------------------------

    async def run_pass(self) -> list[Happened]:
        """Opens the launches that are due, raises the alarm on late ones, and moves every runnable launch on."""
        happened = await self._open_due()
        happened += await self._raise_alarms()
        for launch_id in await self._runnable():
            happened += await self.advance(launch_id)
        return happened

    async def _open_due(self) -> list[Happened]:
        now = self.clock.now()
        async with self.db.transaction(readonly=True) as tx:
            ref = await reference.load(tx, now)
            rows = await tx.fetch(
                "select c.id, c.kind, c.current_version, v.content::text as content from change c "
                "join change_version v on v.change_id = c.id and v.version = c.current_version "
                "where c.state = 'scheduled' and not exists (select from launch l where l.change_id = c.id) order by c.id")
        happened = []
        for row in rows:
            content = from_json(json.loads(row["content"]))
            starts = sorted((to_instant(moment, ref.markets[market].zone), market, moment)
                            for market, moment in records.starts_of(content))
            if not starts or starts[0][0] - LEAD > now:
                continue
            first_at, market, moment = starts[0]
            async with self.db.transaction() as tx:
                launch_id = await tx.fetchval(
                    "insert into launch (change_id, version, kind, starts_market, starts_local, starts_at, due_at, started_at) "
                    "values ($1, $2, $3, $4, $5::text::timestamp, $6::text::timestamptz, $7::text::timestamptz, "
                    "$8::text::timestamptz) on conflict (change_id) do nothing returning id",
                    row["id"], row["current_version"], row["kind"], market, format_local(moment), format_instant(first_at),
                    format_instant(first_at - LEAD), format_instant(now))
                if launch_id is None:
                    continue  # another engine opened it
                await tx.execute(
                    "insert into launch_step (launch_id, position, name) values ($1, 1, 'check'), ($1, 2, 'prepare'), "
                    "($1, 3, 'publish'), ($1, 4, 'notify'), ($1, 5, 'verify')", launch_id)
            happened.append(Happened("launch_started", launch_id, row["id"], {"due": format_instant(first_at - LEAD)}))
        return happened

    async def _raise_alarms(self) -> list[Happened]:
        """A scheduled change not live LATE_AFTER its start: one incident, until its launch goes through or stops.
        Each late launch is locked, and found late again, before its incident opens: in series with the launch's end
        and its cancellation, which close its incidents, so that an alarm never stays open on a launch that stopped
        meanwhile, where nothing would close it."""
        now = self.clock.now()
        late = ("c.state = 'scheduled' and l.state in ('running', 'failed', 'refused') and l.starts_at <= $1::text::timestamptz "
                "and not exists (select from incident i where i.launch_id = l.id and i.state = 'open')")
        async with self.db.transaction(readonly=True) as tx:
            found = [r["id"] for r in await tx.fetch(_LAUNCH + f"where {late} order by l.id", format_instant(now - LATE_AFTER))]
        happened = []
        for launch_id in found:
            async with self.db.transaction() as tx:
                if await _lock(tx, launch_id) is None:
                    continue
                row = await tx.fetchrow(_LAUNCH + f"where l.id = $2 and {late}", format_instant(now - LATE_AFTER), launch_id)
                if row is None:
                    continue  # it went through, stopped or was cancelled while this pass looked
                launch = _launch(row)
                market = (await reference.load(tx, now)).markets[launch.starts_market]
                minutes = int(LATE_AFTER.total_seconds() // 60)
                summary = (f"{launch.title} (#{launch.change_id}) was to start in {market.name} on "
                           f"{describe_local(datetime.fromisoformat(launch.starts_local), market.zone)}, and is not live "
                           f"{minutes} minutes later.")
                opened = await _open_incident(tx, launch, "late", summary, now)
                if opened is not None:
                    happened.append(opened)
        return happened

    async def _runnable(self) -> list[int]:
        async with self.db.transaction(readonly=True) as tx:
            rows = await tx.fetch(
                "select id from launch where state = 'running' and (retry_at is null or retry_at <= $1::text::timestamptz) "
                "order by due_at, id", format_instant(self.clock.now()))
        return [row["id"] for row in rows]

    # -- one launch -------------------------------------------------------------

    async def advance(self, launch_id: int) -> list[Happened]:
        """Runs the launch's steps until it is done, stops, or waits for its next attempt."""
        happened: list[Happened] = []
        while True:
            begun, more = await self._begin(launch_id)
            happened += more
            if begun is None:
                return happened
            try:
                happened += await self._do(launch_id, begun)
            except Refusal as refusal:
                return happened + await self._refuse(launch_id, begun, refusal)
            except Withdrawn as withdrawn:
                return happened + await self._withdrawn(launch_id, str(withdrawn))
            except asyncio.CancelledError:
                raise
            except Exception as error:  # the step failed; it is tried again after a wait, from where it stopped
                return happened + await self._fail(launch_id, begun, _text(error))

    async def _begin(self, launch_id: int) -> tuple[str | None, list[Happened]]:
        """Marks the first step not done running and counts its attempt. A step found running was cut
        short by a fault (the engine stopped, the connection broke): that attempt counts as a failure."""
        async with self.db.transaction() as tx:
            launch = await _lock(tx, launch_id)
            if launch is None or launch.state != "running":
                return None, []
            row = await tx.fetchrow("select name from launch_step where launch_id = $1 and state <> 'done' "
                                    "order by position limit 1", launch_id)
            if row is None:
                return None, []
            step = await _step(tx, launch_id, row["name"])
            now = self.clock.now()
            happened: list[Happened] = []
            if step.state == "running":
                error = (f"attempt {step.attempts} stopped before it finished: the engine stopped, or lost its "
                         "database connection, during the step")
                failures = step.failures + 1
                await tx.execute("update launch_step set failures = $3, error = $4 where launch_id = $1 and name = $2",
                                 launch_id, step.name, failures, error)
                await tx.execute("update launch set cause = $2 where id = $1", launch_id, f"{step.name}: {error}")
                happened.append(Happened("launch_step_interrupted", launch.id, launch.change_id,
                                         {"step": step.name, "attempt": step.attempts}))
                if failures >= MAX_FAILURES:
                    await tx.execute("update launch_step set state = 'failed', finished_at = $3::text::timestamptz "
                                     "where launch_id = $1 and name = $2", launch_id, step.name, format_instant(now))
                    return None, happened + await self._stop_failed(tx, launch, step.name, error, now)
            await tx.execute(
                "update launch_step set state = 'running', started_at = $3::text::timestamptz, finished_at = null, "
                "attempts = attempts + 1 where launch_id = $1 and name = $2", launch_id, step.name, format_instant(now))
            await tx.execute("update launch set retry_at = null where id = $1", launch_id)
            return step.name, happened

    async def _do(self, launch_id: int, name: str) -> list[Happened]:
        """The step's work and its done mark, in one transaction (notify delivers just before it)."""
        delivered: dict[str, object] = {}
        if name == "notify":
            delivered = await self._deliver_notice(launch_id)
        async with self.db.transaction() as tx:
            launch = await _lock(tx, launch_id)
            step = await _step(tx, launch_id, name)
            if launch is None or launch.state != "running" or step.state == "done":
                return []  # another engine did it meanwhile
            await self._probe(name, "start", tx)
            if name == "check":
                facts = await self._check(tx, launch)
            elif name == "prepare":
                facts = await self._prepare(tx, launch)
            elif name == "publish":
                facts = await self._publish(tx, launch)
            elif name == "notify":
                facts = await self._notify(tx, launch, delivered)
            else:
                facts = await self._verify(tx, launch)
            now = self.clock.now()
            if step.attempts > 1:
                facts["earlier attempts"] = step.attempts - 1
                if step.error:
                    facts["last failure"] = step.error
            await tx.execute(
                "update launch_step set state = 'done', finished_at = $3::text::timestamptz, error = null, failures = 0, "
                "facts = $4::text::jsonb where launch_id = $1 and name = $2",
                launch_id, name, format_instant(now), json.dumps({k: str(v) for k, v in facts.items()}, sort_keys=True))
            happened = [Happened("launch_step_done", launch.id, launch.change_id, {"step": name, "attempt": step.attempts})]
            if name == "verify":
                happened += await self._finish(tx, launch, now)
            await self._probe(name, "end", tx)
            return happened

    # -- the steps --------------------------------------------------------------

    async def _scheduled_content(self, tx: Connection, launch: LaunchRow, *, lock: bool):
        change = await (records.lock_change(tx, launch.change_id) if lock else
                        tx.fetchrow("select state, current_version from change where id = $1", launch.change_id))
        state, version = (change.state, change.current_version) if lock else (change["state"], change["current_version"])
        if state != "scheduled" or version != launch.version:
            raise Withdrawn(f"the change is {state.replace('_', ' ')} at version {version}, not scheduled at version "
                            f"{launch.version}")
        content, _, _ = await records.version_content(tx, launch.change_id, launch.version)
        return content

    async def _stands_clear(self, tx: Connection, launch: LaunchRow, content, ref: reference.Reference,
                            now: datetime) -> datetime | None:
        """Refuses the launch when something stands in its way. For a list price, the moment it takes effect."""
        if isinstance(content, Offer):
            clash = await clashes.first_clash(tx, content, launch.change_id, ("active",), ref, now)
            if clash is not None:
                raise Refusal(clash.words(ref.markets[clash.market].name, content.group)
                              + " Nothing was published, and the change stays scheduled.", clash.facts())
            return None
        if isinstance(content, PrepaidPass):
            return None  # a pass stands beside every other: nothing is in its way
        assert isinstance(content, (ListPrice, PriceMigration))
        market = ref.markets[content.market]
        local_now = to_local(now, market.zone)
        effective = content.starts if content.starts > local_now else _ceil_second(local_now)
        later = await tx.fetchval(
            "select to_char(lower(valid), 'YYYY-MM-DD\"T\"HH24:MI:SS') from list_price where plan_id = $1 and market = $2 "
            "and upper_inf(valid) and lower(valid) >= $3::text::timestamp", content.plan, content.market,
            format_local(effective))
        if later is not None:
            raise Refusal(f"The price list already holds a {content.plan} price in {market.name} from {later}: the new "
                          "price would overlap it (§4.1). Nothing was published, and the change stays scheduled.",
                          {"check": "overlap", "market": content.market, "starts": later})
        return effective

    async def _check(self, tx: Connection, launch: LaunchRow) -> dict[str, object]:
        now = self.clock.now()
        content = await self._scheduled_content(tx, launch, lock=False)
        await self._stands_clear(tx, launch, content, await reference.load(tx, now), now)
        live = await self.publisher.latest(tx)
        return {"version": launch.version, "in the way": "nothing", "live snapshot": live.snapshot_id if live else 0}

    async def _prepare(self, tx: Connection, launch: LaunchRow) -> dict[str, object]:
        now = self.clock.now()
        latest = await self.publisher.latest(tx)
        snapshot, offers = await self.publisher.build_snapshot(
            tx, now=now, actor=SYSTEM_ACTOR, request_id=run_id(launch.id), cause={"launch": launch.id, "change": launch.change_id},
            launching=launch.change_id if launch.kind == "offer" else None)
        return {"snapshot": snapshot, "offers": offers, "base": latest.seq if latest else 0}

    async def _publish(self, tx: Connection, launch: LaunchRow) -> dict[str, object]:
        await self.publisher.lock(tx)
        now = await self.publisher.publication_time(tx, self.clock.now())
        content = await self._scheduled_content(tx, launch, lock=True)
        ref = await reference.load(tx, now)
        effective = await self._stands_clear(tx, launch, content, ref, now)
        run = run_id(launch.id)
        events: list[int] = []
        body: dict = {"change": launch.change_id, "version": launch.version, "from": "scheduled", "to": "active",
                      "launch": launch.id}
        if isinstance(content, PriceMigration):
            # The existing subscribers first, while the price list still says what they pay after an offer.
            market = ref.markets[content.market]
            policy = (await reference.policies(tx))[market.code]
            opened = await migrations.open_requests(tx, change_id=launch.change_id, content=content, market=market,
                                                    policy=policy, now=now, request_id=run)
            body.update({"asked": opened.asked, "requirement": policy.legal_requirement,
                         "window_ends": format_local(opened.window_ends), "notices": format_local(content.notices)})
        if isinstance(content, (ListPrice, PriceMigration)):
            market = ref.markets[content.market]
            previous = await tx.fetchrow(
                "select id, change_id from list_price where plan_id = $1 and market = $2 and upper_inf(valid) for update",
                content.plan, content.market)
            if previous is not None:
                await tx.execute("update list_price set valid = tsrange(lower(valid), $2::text::timestamp) where id = $1",
                                 previous["id"], format_local(effective))
            await tx.execute(
                "insert into list_price (plan_id, market, currency, amount_minor, valid, change_id) "
                "values ($1, $2, $3, $4, tsrange($5::text::timestamp, null), $6)",
                content.plan, content.market, market.currency, content.amount.amount, format_local(effective), launch.change_id)
            body.update({"market": content.market, "plan": content.plan, "amount": content.amount.amount,
                         "starts": format_local(content.starts), "effective": format_local(effective)})
            if previous is not None and previous["change_id"] is not None:
                events += await self._end_superseded(tx, previous["change_id"], now, run)
        await tx.execute("update change set state = 'active', updated_at = $2::text::timestamptz where id = $1",
                         launch.change_id, format_instant(now))
        events.append(await records.record(tx, at=now, actor=SYSTEM_ACTOR, role=SYSTEM_ROLE, action="change.activated",
                                           subject=f"change:{launch.change_id}", request_id=run, body=body))
        prepared = (await _step(tx, launch.id, "prepare")).facts
        latest = await self.publisher.latest(tx)
        rebuilt = int(prepared["base"]) != (latest.seq if latest else 0)
        cause = {"activated": launch.change_id, "launch": launch.id}
        if rebuilt:  # something was published since the snapshot was prepared: it may not hold what is live now
            snapshot, offers = await self.publisher.build_snapshot(tx, now=now, actor=SYSTEM_ACTOR, request_id=run, cause=cause)
        else:
            snapshot, offers = int(prepared["snapshot"]), int(prepared["offers"])
        publication = await self.publisher.go_live(tx, snapshot, now=now, actor=SYSTEM_ACTOR, role=SYSTEM_ROLE,
                                                   request_id=run, cause=cause, offers=offers)
        events.append(publication.event_seq)
        await tx.execute("update launch set snapshot_before = $2, snapshot_after = $3 where id = $1",
                         launch.id, publication.previous, snapshot)
        await _link(tx, launch.id, *events)
        return {"snapshot": snapshot, "offers": offers, "publication": publication.seq, "notice": publication.notice,
                "published at": format_instant(now), "previous snapshot": publication.previous or 0,
                "prepared snapshot": "used" if not rebuilt else f"{prepared['snapshot']} replaced: the catalog changed meanwhile"}

    async def _end_superseded(self, tx: Connection, change_id: int, now: datetime, request_id: str) -> list[int]:
        """A list price change ends when a later one closes its price."""
        state = await tx.fetchval("select state from change where id = $1 for update", change_id)
        if state != "active":
            return []
        await tx.execute("update change set state = 'ended', updated_at = $2::text::timestamptz where id = $1",
                         change_id, format_instant(now))
        return [await records.record(tx, at=now, actor=SYSTEM_ACTOR, role=SYSTEM_ROLE, action="change.ended",
                                     subject=f"change:{change_id}", request_id=request_id,
                                     body={"change": change_id, "from": "active", "to": "ended", "why": "superseded"})]

    async def _deliver_notice(self, launch_id: int) -> dict[str, object]:
        """The publish step's notice, delivered to the site's inbox unless it was delivered already."""
        async with self.db.transaction(readonly=True) as tx:
            notice = int((await _step(tx, launch_id, "publish")).facts["notice"])
            message = await outbox.load(tx, notice)
        if message is None:
            raise LookupError(f"the publish step names notice {notice}, and the outbox has no such message")
        if message.delivered_at is not None:
            return {"notice": notice, "delivered": message.delivered_at}
        return await self.relay.consumer(message.topic).deliver(message)

    async def _notify(self, tx: Connection, launch: LaunchRow, delivered: dict[str, object]) -> dict[str, object]:
        notice = int((await _step(tx, launch.id, "publish")).facts["notice"])
        await outbox.mark_delivered(tx, notice, self.clock.now())
        return {"notice": notice, **{k: v for k, v in delivered.items() if k != "notice"}}

    async def _verify(self, tx: Connection, launch: LaunchRow) -> dict[str, object]:
        state = await tx.fetchval("select state from change where id = $1", launch.change_id)
        published = (await _step(tx, launch.id, "publish")).facts
        if state in ("suspended", "ended"):
            return {"live": f"the change is {state}: it went live, and a later decision took it off the site"}
        if state != "active":
            raise NotVerified(f"change #{launch.change_id} is {state} after its publication")
        if launch.kind == "prepaid":
            # On sale where its period has begun and not ended, as the site lists it.
            content, _, _ = await records.version_content(tx, launch.change_id, launch.version)
            assert isinstance(content, PrepaidPass)
            at = parse_instant(published["published at"])
            on_sale = await prepaid.on_sale(tx, at)
            listed = sorted(p.market for p in on_sale if p.change_id == launch.change_id)
            ref = await reference.load(tx, at)
            expected = sorted(p.market for p in content.prices
                              if (period := content.period_in(p.market)) is not None and period.starts is not None
                              and to_instant(period.starts, ref.markets[p.market].zone) <= at
                              and (period.ends is None or to_instant(period.ends, ref.markets[p.market].zone) > at))
            if listed != expected:
                raise NotVerified(f"the site lists pass #{launch.change_id} in {', '.join(listed) or 'no market'}, "
                                  f"not in {', '.join(expected) or 'no market'}")
            return {"on sale": ",".join(listed) or "from the start of its periods"}
        if launch.kind in ("list_price", "price_migration"):
            row = await tx.fetchrow(
                "select amount_minor, to_char(lower(valid), 'YYYY-MM-DD\"T\"HH24:MI:SS') as starts from list_price "
                "where change_id = $1", launch.change_id)
            if row is None:
                raise NotVerified(f"the price list holds no price of change #{launch.change_id}")
            facts: dict[str, object] = {"price list": f"{row['amount_minor']} from {row['starts']}"}
            if launch.kind == "price_migration":
                facts["subscribers asked or told"] = await tx.fetchval(
                    "select count(*) from price_change_request where change_id = $1", launch.change_id)
            return facts
        # What the site shows now is the latest snapshot: the offer belongs in every market whose period had not
        # ended when that snapshot was built. A later publication that left out a market whose period ended since
        # this launch published is right, and a launch resumed after it verifies as well.
        content, _, _ = await records.version_content(tx, launch.change_id, launch.version)
        latest = await self.publisher.latest(tx)
        built = parse_instant(await tx.fetchval(f"select {utc_text('created_at')} from catalog_snapshot where id = $1",
                                                latest.snapshot_id))
        ref = await reference.load(tx, built)
        expected = sorted(p.market for p in content.prices
                          if (period := content.period_in(p.market)) is not None
                          and (period.ends is None or to_instant(period.ends, ref.markets[p.market].zone) > built))
        shown = sorted(r["market"].strip() for r in await tx.fetch(
            "select market from catalog_offer where snapshot_id = $1 and change_id = $2 and version = $3",
            latest.snapshot_id, launch.change_id, launch.version))
        if shown != expected:
            raise NotVerified(f"the live catalog (snapshot {latest.snapshot_id}) shows change #{launch.change_id} in "
                              f"{', '.join(shown) or 'no market'}, not in {', '.join(expected)}")
        return {"live snapshot": latest.snapshot_id, "markets": ",".join(shown)}

    async def _finish(self, tx: Connection, launch: LaunchRow, now: datetime) -> list[Happened]:
        published = (await _step(tx, launch.id, "publish")).facts
        resolution = f"published at {published['published at']} (snapshot {published['snapshot']})"
        if launch.retried_by:
            resolution += f", after {launch.retried_by} retried it"
        await tx.execute("update launch set state = 'done', finished_at = $2::text::timestamptz, retry_at = null, "
                         "resolution = $3 where id = $1", launch.id, format_instant(now), resolution)
        happened = [Happened("launch_done", launch.id, launch.change_id,
                             {"snapshot": published["snapshot"], "published_at": published["published at"]})]
        return happened + await _close_incidents(tx, launch, now, by=launch.retried_by, resolution=resolution,
                                                 person=launch.retried_by is not None)

    # -- when a step does not go through ---------------------------------------

    async def _stop_failed(self, tx: Connection, launch: LaunchRow, step: str, error: str, now: datetime) -> list[Happened]:
        cause = f"{step}: {error}"
        await tx.execute("update launch set state = 'failed', finished_at = $2::text::timestamptz, retry_at = null, "
                         "cause = $3 where id = $1", launch.id, format_instant(now), cause[:2000])
        happened = [Happened("launch_failed", launch.id, launch.change_id, {"step": step, "error": error})]
        published = (await _step(tx, launch.id, "publish")).state == "done"
        summary = (f"The launch of {launch.title} (#{launch.change_id}) failed {MAX_FAILURES} times in a row at its "
                   f"{step} step: {error}. "
                   + ("It published: the change is live, and the steps after publishing wait for a retry."
                      if published else "Nothing was published, and the change stays scheduled."))
        opened = await _open_incident(tx, launch, "failed", summary, now)
        return happened + ([opened] if opened else [])

    async def _fail(self, launch_id: int, step: str, error: str) -> list[Happened]:
        async with self.db.transaction() as tx:
            launch = await _lock(tx, launch_id)
            if launch is None or launch.state != "running":
                return []
            row = await _step(tx, launch_id, step)
            if row.state == "done":
                return []
            now = self.clock.now()
            failures = row.failures + 1
            await tx.execute("update launch_step set state = 'failed', finished_at = $3::text::timestamptz, failures = $4, "
                             "error = $5 where launch_id = $1 and name = $2",
                             launch_id, step, format_instant(now), failures, error)
            happened = [Happened("launch_step_failed", launch.id, launch.change_id,
                                 {"step": step, "attempt": row.attempts, "failures": failures, "error": error})]
            if failures >= MAX_FAILURES:
                return happened + await self._stop_failed(tx, launch, step, error, now)
            retry = now + timedelta(seconds=WAITS[failures - 1])
            await tx.execute("update launch set retry_at = $2::text::timestamptz, cause = $3 where id = $1",
                             launch_id, format_instant(retry), f"{step}: {error}"[:2000])
            happened[0].detail["retry_at"] = format_instant(retry)
            return happened

    async def _refuse(self, launch_id: int, step: str, refusal: Refusal) -> list[Happened]:
        async with self.db.transaction() as tx:
            launch = await _lock(tx, launch_id)
            if launch is None or launch.state != "running":
                return []
            now = self.clock.now()
            await tx.execute("update launch_step set state = 'failed', finished_at = $3::text::timestamptz, "
                             "failures = failures + 1, error = $4 where launch_id = $1 and name = $2",
                             launch_id, step, format_instant(now), refusal.reason[:2000])
            await tx.execute("update launch set state = 'refused', finished_at = $2::text::timestamptz, retry_at = null, "
                             "cause = $3 where id = $1", launch_id, format_instant(now), f"{step}: {refusal.reason}"[:2000])
            happened = [Happened("launch_refused", launch.id, launch.change_id, {"step": step, "reason": refusal.reason})]
            opened = await _open_incident(tx, launch, "refused", f"The launch of {launch.title} (#{launch.change_id}) was "
                                                                 f"refused at its {step} step: {refusal.reason}", now)
            return happened + ([opened] if opened else [])

    async def _withdrawn(self, launch_id: int, why: str) -> list[Happened]:
        async with self.db.transaction() as tx:
            change_id = await tx.fetchval("select change_id from launch where id = $1", launch_id)
            return await withdraw(tx, change_id, actor=None, role=SYSTEM_ROLE, reason=why, now=self.clock.now(),
                                  request_id=run_id(launch_id))

    # -- what people do: LaunchService ------------------------------------------

    async def list_launches(self, tx: Connection, call: Call,
                            request: launches_pb2.ListLaunchesRequest) -> launches_pb2.ListLaunchesResponse:
        where, args = [], []

        def param(value) -> str:
            args.append(value)
            return f"${len(args)}"

        state = contract.enum_name(STATE, "LAUNCH_STATE_", request.state)
        if state is not None:
            where.append(f"l.state = {param(state)}")
        if request.change_id:
            where.append(f"l.change_id = {param(request.change_id)}")
        if request.page.after:
            where.append(f"l.id < {param(_cursor(request.page.after))}")
        if request.page.size < 0:
            raise InvalidArgument("page.size is a positive number")
        size = min(request.page.size or PAGE_DEFAULT, PAGE_MAX)
        rows = await tx.fetch(_LAUNCH + (f"where {' and '.join(where)} " if where else "") + f"order by l.id desc limit {size + 1}",
                              *args)
        page, more = rows[:size], len(rows) > size
        response = launches_pb2.ListLaunchesResponse(
            launches=[await self._message(tx, _launch(row), detail=False) for row in page])
        if more:
            response.page.next = str(page[-1]["id"])
        return response

    async def get_launch(self, tx: Connection, call: Call, request: launches_pb2.GetLaunchRequest) -> launches_pb2.GetLaunchResponse:
        row = await tx.fetchrow(_LAUNCH + "where l.id = $1", request.launch_id)
        if row is None:
            raise NotFound(f"no launch #{request.launch_id}")
        return launches_pb2.GetLaunchResponse(launch=await self._message(tx, _launch(row), detail=True))

    async def retry_launch(self, tx: Connection, call: Call,
                           request: launches_pb2.RetryLaunchRequest) -> launches_pb2.RetryLaunchResponse:
        launch = await _lock(tx, request.launch_id)
        if launch is None:
            raise NotFound(f"no launch #{request.launch_id}")
        _require_operator(call, "retry a launch")
        reason = request.reason.strip()
        if len(reason) > REASON_MAX:
            raise InvalidArgument(f"a reason is at most {REASON_MAX} characters")
        waiting = launch.state == "running" and launch.retry_at is not None
        if launch.state not in ("failed", "refused") and not waiting:
            raise Refused("WRONG_STATE", f"{run_id(launch.id)} is {launch.state}: only a failed, refused or waiting launch is "
                                         "retried.", {"state": launch.state})
        change_state = await tx.fetchval("select state from change where id = $1", launch.change_id)
        published = (await _step(tx, launch.id, "publish")).state == "done"
        if not published and change_state != "scheduled":
            raise Refused("WRONG_STATE", f"Change #{launch.change_id} is {change_state}: its launch has nothing left to do.",
                          {"state": launch.state, "change_state": change_state})
        now = self.clock.now()
        await tx.execute("update launch_step set failures = 0 where launch_id = $1 and state = 'failed'", launch.id)
        resolution = f"retried by {call.actor} at {format_instant(now)}" + (f": {reason}" if reason else "")
        await tx.execute("update launch set state = 'running', finished_at = null, retry_at = null, retried_by = $2, "
                         "resolution = $3 where id = $1", launch.id, call.actor, resolution)
        seq = await records.record(tx, at=now, actor=call.actor, role=call.role, action="launch.retried",
                                   subject=f"launch:{launch.id}", request_id=call.request_id, reason=reason or None,
                                   body={"launch": launch.id, "change": launch.change_id, "from": launch.state, "to": "running"})
        await _link(tx, launch.id, seq)
        return launches_pb2.RetryLaunchResponse(launch=await self._message(tx, await _lock(tx, launch.id), detail=True))

    async def cancel_launch(self, tx: Connection, call: Call,
                            request: launches_pb2.CancelLaunchRequest) -> launches_pb2.CancelLaunchResponse:
        launch = await _lock(tx, request.launch_id)
        if launch is None:
            raise NotFound(f"no launch #{request.launch_id}")
        _require_operator(call, "cancel a launch")
        reason = request.reason.strip()
        if not reason:
            raise Refused("REASON_REQUIRED", "Say why you cancel the launch: its change is cancelled with that reason (§7.1).")
        if len(reason) > REASON_MAX:
            raise InvalidArgument(f"a reason is at most {REASON_MAX} characters")
        if (await _step(tx, launch.id, "publish")).state == "done":
            raise Refused("WRONG_STATE", f"{run_id(launch.id)} has published: change #{launch.change_id} is live, and "
                                         "SuspendChange takes it off the site.", {"state": launch.state, "published": "yes"})
        if launch.state in ("done", "cancelled"):
            raise Refused("WRONG_STATE", f"{run_id(launch.id)} is {launch.state}.", {"state": launch.state})
        change = await records.lock_change(tx, launch.change_id)
        if change.state != "scheduled":
            raise Refused("WRONG_STATE", f"Change #{change.id} is {change.state.replace('_', ' ')}, not scheduled.",
                          {"state": launch.state, "change_state": change.state})
        now = self.clock.now()
        await tx.execute("update change set state = 'cancelled', state_reason = $2, updated_at = $3::text::timestamptz "
                         "where id = $1", change.id, reason, format_instant(now))
        cancelled = await records.record(tx, at=now, actor=call.actor, role=call.role, action="change.cancelled",
                                         subject=f"change:{change.id}", request_id=call.request_id, reason=reason,
                                         body={"change": change.id, "version": change.current_version, "from": "scheduled",
                                               "to": "cancelled", "launch": launch.id})
        await withdraw(tx, change.id, actor=call.actor, role=call.role, reason=reason, now=now, request_id=call.request_id,
                       events=(cancelled,))
        return launches_pb2.CancelLaunchResponse(launch=await self._message(tx, await _lock(tx, launch.id), detail=True))

    # -- the contract's message ---------------------------------------------------

    async def _message(self, tx: Connection, launch: LaunchRow, *, detail: bool) -> launches_pb2.LaunchRun:
        row = await tx.fetchrow(
            f"select {utc_text('due_at')} as due_at, {utc_text('started_at')} as started_at, "
            f"{utc_text('finished_at')} as finished_at, resolution, snapshot_before, snapshot_after from launch where id = $1",
            launch.id)
        steps = await tx.fetch(
            f"select name, state, {utc_text('started_at')} as started_at, {utc_text('finished_at')} as finished_at, attempts, "
            "error, facts::text as facts from launch_step where launch_id = $1 order by position", launch.id)
        message = launches_pb2.LaunchRun(
            launch_id=launch.id, change_id=launch.change_id, title=launch.title, kind=contract.kind_to_proto(launch.kind),
            version=launch.version, state=STATE.Value(f"LAUNCH_STATE_{launch.state.upper()}"),
            starts=common_pb2.LocalTime(market=launch.starts_market, local=launch.starts_local,
                                        utc=records.iso(launch.starts_at)),
            due_at=records.iso(row["due_at"]), started_at=records.iso(row["started_at"]),
            finished_at=records.iso(row["finished_at"]),
            current_step=next((s["name"] for s in steps if s["state"] != "done"), "") if launch.state != "done" else "",
            attempts=sum(s["attempts"] for s in steps), cause=launch.cause or "", retry_at=records.iso(launch.retry_at),
            snapshot_before=row["snapshot_before"] or 0, snapshot_after=row["snapshot_after"] or 0,
            resolution=row["resolution"] or "", run=run_id(launch.id))
        for incident in await tx.fetch(
                f"select id, kind, state, summary, {utc_text('opened_at')} as opened_at, {utc_text('closed_at')} as closed_at, "
                "resolution from incident where launch_id = $1 order by id", launch.id):
            message.incidents.append(launches_pb2.LaunchIncident(
                incident_id=incident["id"], kind=incident["kind"], state=incident["state"], summary=incident["summary"],
                opened_at=records.iso(incident["opened_at"]), closed_at=records.iso(incident["closed_at"]),
                resolution=incident["resolution"] or ""))
        if detail:
            for step in steps:
                message.steps.append(launches_pb2.LaunchStep(
                    name=step["name"], purpose=PURPOSES[step["name"]],
                    state=STEP_STATE.Value(f"LAUNCH_STEP_STATE_{step['state'].upper()}"),
                    started_at=records.iso(step["started_at"]), finished_at=records.iso(step["finished_at"]),
                    attempts=step["attempts"], error=step["error"] or "", facts=json.loads(step["facts"])))
            message.audit_events.extend(r["seq"] for r in await tx.fetch(
                "select seq from launch_event where launch_id = $1 order by seq", launch.id))
        return message


def _require_operator(call: Call, doing: str) -> None:
    if call.role not in policy.LAUNCH_OPERATORS:
        raise Refused("ROLE_NOT_ALLOWED", f"{policy.who(policy.LAUNCH_OPERATORS).capitalize()} may {doing}; you act as "
                                          f"{policy.ROLE_NAMES[call.role]}.",
                      {"role": call.role, "allowed": ",".join(sorted(policy.LAUNCH_OPERATORS))})


def _cursor(text: str) -> int:
    if not text.isdigit() or len(text) > 18:
        raise InvalidArgument("page.after is not a cursor this engine gave")
    return int(text)
