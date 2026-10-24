"""A launch, step by step (business book §7.5, §12, §14.6): its steps run once,
a failed step is tried again from where it stopped, a step cut short by a stop
resumes and publishes once, five failures in a row or a clash stop it with an
incident, the alarm opens one for a late start, and the on-call engineer
retries or cancels it. The engine's own process is stopped for real, and its
connection cut, in tests/faults; here the faults come from the probe, in the
tests' process."""

from __future__ import annotations

import asyncio
import io
import json
from datetime import UTC, datetime

import asyncpg

import pytest

from commerce.engine.errors import Unavailable
from commerce.engine.launches import STEPS
from commerce.server.app import Jobs
from commerce.engine.logs import JsonLog
from commerce.v1 import changes_pb2, common_pb2, launches_pb2, overview_pb2
from conftest import ADMIN_URL, on_database
from engine_support import (
    AUDITOR, FINANCE, LEAD, MARKETING, ON_CALL, apply, eur, family_rise, past_validation_by_hand, scheduled, student_autumn,
)

REFUSAL = common_pb2.RefusalCode
STATE = launches_pb2.LaunchState
STEP = launches_pb2.LaunchStepState


def at(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


DUE = at(2026, 10, 26, 7, 59, 30)  # half a minute after the Student Autumn Pass is due, a minute before 09:00 in Rome


async def launch_of(world, change_id: int) -> launches_pb2.LaunchRun:
    listed = await world.call("ListLaunches", launches_pb2.ListLaunchesRequest(change_id=change_id), AUDITOR)
    [summary] = listed.launches
    return (await world.call("GetLaunch", launches_pb2.GetLaunchRequest(launch_id=summary.launch_id), AUDITOR)).launch


def steps(run: launches_pb2.LaunchRun) -> dict[str, launches_pb2.LaunchStep]:
    return {step.name: step for step in run.steps}


async def retry(world, run, who=ON_CALL, reason: str = ""):
    return await world.call("RetryLaunch", launches_pb2.RetryLaunchRequest(launch_id=run.launch_id, reason=reason), who)


async def cancel(world, run, who=ON_CALL, reason: str = "The price list needs a fix first."):
    return await world.call("CancelLaunch", launches_pb2.CancelLaunchRequest(launch_id=run.launch_id, reason=reason), who)


async def overview_incidents(world) -> list:
    return list((await world.call("GetOverview", overview_pb2.GetOverviewRequest(), ON_CALL)).incidents_today)


async def refused_list_price(world):
    """A Family rise in Germany whose launch is refused: a later price slipped into the price list by hand."""
    change = await scheduled(world, family_rise(), LEAD, FINANCE)
    await world.owner.execute("update list_price set valid = tsrange(lower(valid), '2026-12-15') "
                              "where plan_id = 'family' and market = 'DE'")
    await world.owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                              "values ('family', 'DE', 'EUR', 1949, tsrange('2026-12-15', null))")
    world.clock.at = at(2026, 11, 30, 22, 59, 30)
    await world.engine.run_launches()
    return change


async def test_a_launch_runs_its_five_steps_once_and_says_what_each_did(world):
    change = await scheduled(world, student_autumn())
    world.clock.at = DUE
    happened = await world.engine.run_launches()
    assert [h.event for h in happened] == ["launch_started"] + ["launch_step_done"] * 5 + ["launch_done"]
    run = await launch_of(world, change.id)
    assert (run.state, run.current_step, run.attempts, run.cause, run.version) == (STATE.LAUNCH_STATE_DONE, "", 5, "", 1)
    assert [(s.name, s.state, s.attempts, s.error) for s in run.steps] == [(n, STEP.LAUNCH_STEP_STATE_DONE, 1, "") for n in STEPS]
    assert run.starts == common_pb2.LocalTime(market="IT", local="2026-10-26T09:00", utc="2026-10-26T08:00:00Z")
    assert (run.due_at, run.started_at, run.run) == ("2026-10-26T07:59:00Z", "2026-10-26T07:59:30Z", f"launch-{run.launch_id}")
    done = steps(run)
    assert int(done["publish"].facts["snapshot"]) == run.snapshot_after and run.snapshot_before == 0
    assert done["prepare"].facts["snapshot"] == done["publish"].facts["snapshot"]  # nothing was published in between
    assert done["notify"].facts["arrivals"] == "1" and done["verify"].facts["markets"] == "IT"
    assert run.resolution == f"published at 2026-10-26T07:59:30Z (snapshot {run.snapshot_after})"
    events = {e["seq"]: e["action"] for e in await world.events()}
    assert [events[seq] for seq in run.audit_events] == ["change.activated", "catalog.published"]
    notices = await world.owner.fetch("select snapshot_id, arrivals from site_notice")
    assert [(n["snapshot_id"], n["arrivals"]) for n in notices] == [(run.snapshot_after, 1)]
    assert await world.owner.fetchval("select count(*) from outbox_message where delivered_at is null") == 0
    assert list(run.incidents) == []


async def test_a_failed_step_is_tried_again_from_where_it_stopped(world):
    change = await scheduled(world, student_autumn())
    left = {"failures": 1}

    async def full_disk(step, phase, tx):
        if (step, phase) == ("publish", "end") and left["failures"]:
            left["failures"] -= 1
            raise OSError("no space left on the device")

    world.engine.launches.probe = full_disk
    world.clock.at = DUE
    [failed] = [h for h in await world.engine.run_launches() if h.event == "launch_step_failed"]
    assert (failed.detail["step"], failed.detail["retry_at"]) == ("publish", "2026-10-26T07:59:35Z")
    # Nothing of the publish step was kept: not the change's state, not the catalog, not the site's notice.
    assert await world.owner.fetchval("select state from change where id = $1", change.id) == "scheduled"
    assert await world.owner.fetchval("select count(*) from catalog_publication") == 0
    assert await world.owner.fetchval("select count(*) from outbox_message") == 0
    run = await launch_of(world, change.id)
    assert (run.state, run.current_step, run.retry_at) == (STATE.LAUNCH_STATE_RUNNING, "publish", "2026-10-26T07:59:35Z")
    assert "no space left on the device" in run.cause and "no space left" in steps(run)["publish"].error
    assert await world.engine.run_launches() == []  # it waits: nothing happens, and nothing is said
    world.clock.advance(seconds=5)
    await world.engine.run_launches()
    run = await launch_of(world, change.id)
    assert run.state == STATE.LAUNCH_STATE_DONE
    assert [s.attempts for s in run.steps] == [1, 1, 2, 1, 1]  # the steps done before were not done again
    assert steps(run)["publish"].facts["earlier attempts"] == "1"
    assert "no space left" in steps(run)["publish"].facts["last failure"]
    assert await world.owner.fetchval("select count(*) from catalog_publication") == 1
    assert len(await world.events("change.activated")) == 1


async def test_next_due_is_the_opening_of_the_next_launch_then_its_next_attempt(world):
    """What the browser's demo skips its clock to (stage 8)."""
    assert await world.engine.next_launch_due() is None
    change = await scheduled(world, student_autumn())
    assert await world.engine.next_launch_due() == at(2026, 10, 26, 7, 59)  # a minute before 09:00 in Rome
    world.clock.at = DUE
    assert await world.engine.next_launch_due() == at(2026, 10, 26, 7, 59)  # due already: no pass ran since
    left = {"failures": 1}

    async def full_disk(step, phase, tx):
        if (step, phase) == ("prepare", "end") and left["failures"]:
            left["failures"] -= 1
            raise OSError("no space left on the device")

    world.engine.launches.probe = full_disk
    await world.engine.run_launches()
    assert await world.engine.next_launch_due() == at(2026, 10, 26, 7, 59, 35)  # its next attempt
    world.clock.advance(seconds=5)
    await world.engine.run_launches()
    assert (await launch_of(world, change.id)).state == STATE.LAUNCH_STATE_DONE
    assert await world.engine.next_launch_due() is None  # nothing waits for a moment of its own


class Stopped(BaseException):
    """What the engine's process stopping looks like from inside it: nothing after it runs."""


async def test_a_step_cut_short_by_a_stop_resumes_and_publishes_once(world):
    change = await scheduled(world, student_autumn())

    async def stop(step, phase, tx):
        if (step, phase) == ("publish", "end"):
            raise Stopped()

    world.engine.launches.probe = stop
    world.clock.at = DUE
    with pytest.raises(Stopped):
        await world.engine.run_launches()
    publish = await world.owner.fetchrow("select state, attempts from launch_step where name = 'publish'")
    assert (publish["state"], publish["attempts"]) == ("running", 1)
    assert await world.owner.fetchval("select state from change where id = $1", change.id) == "scheduled"
    assert await world.owner.fetchval("select count(*) from catalog_publication") == 0
    world.engine.launches.probe = None
    world.clock.advance(seconds=20)  # the engine is back
    happened = await world.engine.run_launches()
    assert [h.detail["step"] for h in happened if h.event == "launch_step_interrupted"] == ["publish"]
    run = await launch_of(world, change.id)
    assert run.state == STATE.LAUNCH_STATE_DONE and steps(run)["publish"].attempts == 2
    assert "stopped before it finished" in steps(run)["publish"].facts["last failure"]
    assert await world.owner.fetchval("select count(*) from catalog_publication") == 1
    assert len(await world.events("change.activated")) == 1


async def test_five_failures_in_a_row_fail_the_launch_and_the_on_call_engineer_retries_it(world):
    change = await scheduled(world, student_autumn())
    broken = {"on": True}

    async def unreachable(step, phase, tx):
        if (step, phase) == ("check", "end") and broken["on"]:
            raise ConnectionError("the catalog's store does not answer")

    world.engine.launches.probe = unreachable
    world.clock.at = DUE
    for wait in (5, 15, 45, 135, None):
        await world.engine.run_launches()
        if wait:
            world.clock.advance(seconds=wait)
    run = await launch_of(world, change.id)
    assert (run.state, run.current_step, steps(run)["check"].attempts) == (STATE.LAUNCH_STATE_FAILED, "check", 5)
    [incident] = run.incidents
    assert (incident.kind, incident.state) == ("failed", "open") and "failed 5 times in a row" in incident.summary
    assert "Nothing was published" in incident.summary
    [home] = await overview_incidents(world)
    assert (home.change_id, home.launch_id, home.kind, home.state, home.run) == (
        change.id, run.launch_id, "failed", "open", f"launch-{run.launch_id}")
    assert await world.engine.run_launches() == []  # a failed launch waits for a person
    broken["on"] = False
    retried = (await retry(world, run, reason="The store is back.")).launch
    assert (retried.state, retried.resolution.startswith("retried by on-call-1")) == (STATE.LAUNCH_STATE_RUNNING, True)
    await world.engine.run_launches()
    run = await launch_of(world, change.id)
    assert run.state == STATE.LAUNCH_STATE_DONE and "after on-call-1 retried it" in run.resolution
    [incident] = run.incidents
    assert (incident.state, incident.resolution) == ("resolved", run.resolution)
    [home] = await overview_incidents(world)
    assert (home.state, home.closed_at) == ("resolved", run.finished_at)
    retried_event = [e for e in await world.events("launch.retried")][0]
    assert retried_event["seq"] in run.audit_events and retried_event["reason"] == "The store is back."


async def test_a_clash_refuses_the_launch_once_and_a_retry_after_the_fix_goes_through(world):
    first = await scheduled(world, student_autumn(title="Student Autumn Pass"))
    world.clock.at = DUE
    await world.engine.run_launches()
    second = await past_validation_by_hand(world, student_autumn(title="Student Black Friday"))
    await world.owner.execute("update change set state = 'scheduled' where id = $1", second.id)
    world.clock.at = at(2026, 10, 26, 8, 1)
    happened = await world.engine.run_launches()
    assert [h.event for h in happened if h.change == second.id][-2:] == ["launch_refused", "incident_opened"]
    run = await launch_of(world, second.id)
    assert (run.state, run.current_step) == (STATE.LAUNCH_STATE_REFUSED, "check")
    assert "Student Autumn Pass" in run.cause and "stays scheduled" in run.cause
    assert [i.kind for i in run.incidents] == ["refused"]
    world.clock.advance(minutes=10)
    assert await world.engine.run_launches() == []  # refused: no new attempt, no alarm on top, nothing to say
    suspended = await world.call("SuspendChange", changes_pb2.SuspendChangeRequest(
        change_id=first.id, reason="Black Friday replaces it."), ON_CALL)
    assert suspended.change.state == changes_pb2.CHANGE_STATE_SUSPENDED
    assert (await retry(world, run)).launch.state == STATE.LAUNCH_STATE_RUNNING
    await world.engine.run_launches()
    run = await launch_of(world, second.id)
    assert run.state == STATE.LAUNCH_STATE_DONE
    [incident] = run.incidents
    assert incident.state == "resolved"


async def test_the_alarm_opens_an_incident_when_a_launch_starts_late(world):
    change = await scheduled(world, student_autumn())
    world.clock.at = at(2026, 10, 26, 8, 6)  # the engine was down at 09:00 in Rome, and comes back six minutes later
    happened = await world.engine.run_launches()
    assert [h.event for h in happened][:2] == ["launch_started", "incident_opened"]
    assert [h.event for h in happened][-2:] == ["launch_done", "incident_closed"]
    [incident] = (await launch_of(world, change.id)).incidents
    assert (incident.kind, incident.state) == ("late", "recovered")
    assert "is not live 5 minutes later" in incident.summary and "26 October 2026, 09:00 (Europe/Rome)" in incident.summary
    [home] = await overview_incidents(world)
    assert (home.kind, home.state, home.title) == ("late", "recovered", "Student Autumn Pass")


async def test_the_alarm_waits_five_minutes_after_the_start(world):
    change = await scheduled(world, student_autumn())
    broken = {"on": True}

    async def slow(step, phase, tx):
        if (step, phase) == ("check", "end") and broken["on"]:
            raise TimeoutError("the check took too long")

    world.engine.launches.probe = slow
    world.clock.at = at(2026, 10, 26, 8, 4, 59)
    await world.engine.run_launches()
    assert list((await launch_of(world, change.id)).incidents) == []
    world.clock.at = at(2026, 10, 26, 8, 5)
    opened = [h for h in await world.engine.run_launches() if h.event == "incident_opened"]
    assert [h.detail["kind"] for h in opened] == ["late"]
    world.clock.advance(minutes=5)
    assert [h for h in await world.engine.run_launches() if h.event == "incident_opened"] == []  # one is open already


async def test_an_alarm_is_never_opened_on_a_launch_that_stopped_meanwhile(world):
    """The alarm reads the late launches, then opens their incidents: a launch cancelled in between must not get an
    incident that nobody would close. Here the cancellation holds the launch while the alarm runs."""
    change = await refused_list_price(world)  # refused at its check: stopped, and late from five minutes on
    await world.owner.execute("update incident set state = 'resolved', closed_at = opened_at + interval '1 minute', "
                              "closed_by = 'on-call-1', resolution = 'Looked at.' where state = 'open'")
    launch = await world.owner.fetchval("select id from launch where change_id = $1", change.id)
    world.clock.at = at(2026, 12, 1, 0, 0)  # an hour after the start in Berlin
    cancelling = world.owner.transaction()
    await cancelling.start()
    await world.owner.execute("select id from launch where id = $1 for update", launch)
    alarm = asyncio.create_task(world.engine.launches._raise_alarms())
    waiting = await asyncpg.connect(on_database(ADMIN_URL, world.name))
    try:
        for _ in range(200):  # until the alarm waits for the launch the cancellation holds
            if await waiting.fetchval("select count(*) from pg_locks where not granted") or alarm.done():
                break
            await asyncio.sleep(0.05)
    finally:
        await waiting.close()
    await world.owner.execute("update launch set state = 'cancelled', finished_at = now(), "
                              "resolution = 'cancelled by on-call-1: the price list needs a fix first.' where id = $1", launch)
    await cancelling.commit()
    assert await alarm == []
    assert await world.owner.fetchval("select count(*) from incident where launch_id = $1 and state = 'open'", launch) == 0


def two_markets(**changes) -> changes_pb2.OfferContent:
    """Individual at €8.99 for new subscribers: in Italy for 26 October only, in Germany for a month."""
    content = student_autumn(
        title="Weekend start", plan="individual", audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_NEVER_PAID),
        prices=[changes_pb2.OfferPrice(market="IT", fixed=eur(899)), changes_pb2.OfferPrice(market="DE", fixed=eur(899))],
        periods=[changes_pb2.OfferPeriod(market="IT", starts_local="2026-10-26T09:00", ends_local="2026-10-27T00:00"),
                 changes_pb2.OfferPeriod(market="DE", starts_local="2026-10-26T09:00", ends_local="2026-11-26T00:00")],
        non_combinability_group="weekend-offers",
        pages=[changes_pb2.OfferPage(market=m, title="Weekend start", text="Individual for 8,99 €.", terms="New only.")
               for m in ("IT", "DE")])
    return apply(content, changes)


async def test_a_resumed_launch_verifies_what_the_site_shows_after_a_market_s_period_ended(world):
    """A launch stopped before its verify step; meanwhile the offer's day in Italy ended and another publication left
    Italy out. The site shows what it must, and the verify step, tried again, says so."""
    change = await scheduled(world, two_markets())
    left = {"failures": 1}

    async def site_away(step, phase, tx):
        if (step, phase) == ("verify", "start") and left["failures"]:
            left["failures"] -= 1
            raise OSError("the site did not answer")

    world.engine.launches.probe = site_away
    world.clock.at = DUE
    await world.engine.run_launches()
    run = await launch_of(world, change.id)
    assert (run.state, run.current_step) == (STATE.LAUNCH_STATE_RUNNING, "verify")
    world.clock.at = at(2026, 10, 26, 23, 0, 30)  # 00:00:30 on 27 October in Rome: Italy's day is over
    async with world.engine.db.transaction() as tx:
        await world.engine.publisher.publish(tx, now=world.clock.now(), actor="on-call-1", role="on_call",
                                             request_id="req-another-publication", cause={"another": "publication"})
    await world.engine.run_launches()
    run = await launch_of(world, change.id)
    assert (run.state, steps(run)["verify"].facts["markets"]) == (STATE.LAUNCH_STATE_DONE, "DE")
    assert [i.state for i in run.incidents] == []


async def test_the_on_call_engineer_cancels_a_launch_that_has_not_published(world):
    change = await refused_list_price(world)
    run = await launch_of(world, change.id)
    assert (await cancel(world, run, MARKETING)).refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    assert (await cancel(world, run, reason=" ")).refusal.code == REFUSAL.REFUSAL_CODE_REASON_REQUIRED
    done = (await cancel(world, run)).launch
    assert done.state == STATE.LAUNCH_STATE_CANCELLED
    assert done.resolution.startswith("cancelled by on-call-1") and done.resolution.endswith("The price list needs a fix first.")
    [incident] = done.incidents
    assert (incident.kind, incident.state) == ("refused", "resolved")
    changed = await world.owner.fetchrow("select state, state_reason from change where id = $1", change.id)
    assert (changed["state"], changed["state_reason"]) == ("cancelled", "The price list needs a fix first.")
    events = {e["seq"]: e["action"] for e in await world.events()}
    assert [events[seq] for seq in done.audit_events] == ["change.cancelled", "launch.cancelled"]
    assert (await cancel(world, run)).refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE
    assert (await retry(world, run)).refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE


async def test_a_launch_that_published_is_not_cancelled_and_its_retry_finishes_it(world):
    change = await scheduled(world, student_autumn())
    broken = {"on": True}

    async def inbox_down(step, phase, tx):
        if (step, phase) == ("notify", "start") and broken["on"]:
            raise ConnectionError("the site's inbox does not answer")

    world.engine.launches.probe = inbox_down
    world.clock.at = DUE
    for wait in (5, 15, 45, 135, None):
        await world.engine.run_launches()
        if wait:
            world.clock.advance(seconds=wait)
    run = await launch_of(world, change.id)
    assert (run.state, run.current_step) == (STATE.LAUNCH_STATE_FAILED, "notify")
    assert "It published: the change is live" in run.incidents[0].summary
    assert await world.owner.fetchval("select state from change where id = $1", change.id) == "active"
    refused = await cancel(world, run)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and refused.refusal.facts["published"] == "yes"
    broken["on"] = False
    await retry(world, run)
    await world.engine.run_launches()
    run = await launch_of(world, change.id)
    assert run.state == STATE.LAUNCH_STATE_DONE and steps(run)["notify"].attempts == 6
    assert await world.owner.fetchval("select arrivals from site_notice") >= 1
    assert await world.owner.fetchval("select count(*) from site_notice") == 1


async def test_cancelling_a_change_stops_its_launch(world):
    change = await scheduled(world, student_autumn())

    async def once(step, phase, tx):
        if (step, phase) == ("check", "end"):
            raise ConnectionError("the database restarted")

    world.engine.launches.probe = once
    world.clock.at = DUE
    await world.engine.run_launches()
    world.engine.launches.probe = None
    cancelled = await world.call("CancelChange", changes_pb2.CancelChangeRequest(change_id=change.id,
                                                                                 reason="The campaign moves to spring."))
    assert cancelled.change.state == changes_pb2.CHANGE_STATE_CANCELLED
    run = await launch_of(world, change.id)
    assert run.state == STATE.LAUNCH_STATE_CANCELLED and run.resolution.startswith("cancelled by marketing-1")
    world.clock.advance(minutes=1)
    assert await world.engine.run_launches() == []
    assert await world.owner.fetchval("select count(*) from catalog_publication") == 0


async def test_a_launch_that_is_running_or_done_is_not_retried(world):
    change = await scheduled(world, student_autumn())
    world.clock.at = DUE
    await world.engine.run_launches()
    run = await launch_of(world, change.id)
    response = await retry(world, run)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and response.refusal.facts["state"] == "done"


async def test_launches_are_listed_newest_first_a_page_at_a_time(world):
    changes = [await scheduled(world, student_autumn(title=f"Pass {n}", non_combinability_group=f"group-{n}"))
               for n in range(3)]
    world.clock.at = DUE
    await world.engine.run_launches()
    first = await world.call("ListLaunches", launches_pb2.ListLaunchesRequest(page=common_pb2.PageRequest(size=2)), MARKETING)
    assert [l.change_id for l in first.launches] == [changes[2].id, changes[1].id] and first.page.next
    assert not first.launches[0].steps and not first.launches[0].audit_events  # GetLaunch has them
    rest = await world.call("ListLaunches", launches_pb2.ListLaunchesRequest(
        page=common_pb2.PageRequest(size=2, after=first.page.next)), MARKETING)
    assert [l.change_id for l in rest.launches] == [changes[0].id] and not rest.page.next
    done = await world.call("ListLaunches", launches_pb2.ListLaunchesRequest(state=STATE.LAUNCH_STATE_DONE), FINANCE)
    assert len(done.launches) == 3
    assert list((await world.call("ListLaunches", launches_pb2.ListLaunchesRequest(
        state=STATE.LAUNCH_STATE_FAILED), FINANCE)).launches) == []


async def test_the_jobs_log_each_change_of_state_once(world):
    change = await scheduled(world, family_rise(), LEAD, FINANCE)
    await world.owner.execute("update list_price set valid = tsrange(lower(valid), '2026-12-15') "
                              "where plan_id = 'family' and market = 'DE'")
    await world.owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                              "values ('family', 'DE', 'EUR', 1949, tsrange('2026-12-15', null))")
    world.clock.at = at(2026, 11, 30, 22, 59, 30)
    logs = io.StringIO()
    jobs = Jobs(world.engine, JsonLog(world.clock.now, logs))
    for _ in range(4):  # a pass every 5 seconds, as the server runs them
        await jobs.run_pass()
        world.clock.advance(seconds=5)
    lines = [json.loads(line) for line in logs.getvalue().splitlines()]
    assert [(line["event"], line["level"]) for line in lines if line.get("change") == change.id] == [
        ("launch_started", "info"), ("launch_refused", "warning"), ("incident_opened", "warning")]


async def test_a_pass_that_keeps_failing_says_so_once(world, monkeypatch):
    calls = {"n": 0}

    async def database_down():
        calls["n"] += 1
        if calls["n"] <= 3:
            raise Unavailable("the database cannot be reached (ConnectionRefusedError)")
        return []

    monkeypatch.setattr(world.engine, "run_launches", database_down)
    logs = io.StringIO()
    jobs = Jobs(world.engine, JsonLog(world.clock.now, logs))
    for _ in range(4):
        await jobs.run_pass()
    assert [json.loads(line)["event"] for line in logs.getvalue().splitlines()] == ["jobs_pass_failed", "jobs_working_again"]
