"""Price migrations (business book §8, §14.3) against PostgreSQL: the Family
price in Germany rises from €18.99 to €20.99 for new subscribers from
1 December 2026, and the existing ones are asked for their consent from
2 November at 09:00 in Berlin, for 45 days. Silence is never consent; without
a yes the account moves to the free plan when the period already paid at the
deadline runs out. In Italy the same move is a notice of 30 days, with the
right to leave before the new price.

The German Family subscribers are charged on different days, so that each
rule of the dates shows: 203 on the 10th (from the seed), 205 on the 17th
(the deadline's day, as in the maquette), 206 on the 5th, 207 on the 18th."""

from __future__ import annotations

import io
import json
from datetime import UTC, date, datetime

import pytest

from commerce.engine import migrations, outbox
from commerce.engine.errors import FailedPrecondition, InvalidArgument, NotFound
from commerce.server.app import Jobs
from commerce.engine.logs import JsonLog
from commerce.engine.providers import FAILED, PENDING, ChargeResult, ProviderEvent
from commerce.invariants import check
from helpers import add_subscription
from commerce.v1 import catalog_pb2, changes_pb2, common_pb2, overview_pb2, quotes_pb2, simulation_pb2, subscriptions_pb2
from engine_support import (
    AUDITOR, FINANCE, LEAD, MARKETING, ON_CALL, PUBLIC, apply, create, eur, family_migration, gift_pass, scheduled,
    student_autumn,
)

REFUSAL = common_pb2.RefusalCode
FAMILY = {205: (date(2026, 3, 17), 17), 206: (date(2026, 4, 5), 5), 207: (date(2026, 5, 18), 18)}


def at(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


async def add_family(world) -> None:
    for subscriber, (started, day) in FAMILY.items():
        await world.owner.execute("insert into subscriber (id, market, joined_on) values ($1, 'DE', $2)", subscriber, started)
        await add_subscription(world.owner, subscriber, "DE", "family", 1899, started, subscription=subscriber, billing_day=day)


async def started(world) -> changes_pb2.Change:
    """The rise written by the commercial lead, signed by finance, and launched on 2 November at 09:00 in Berlin."""
    await add_family(world)
    change = await scheduled(world, family_migration(), LEAD, FINANCE)
    world.clock.at = at(2026, 11, 2, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    return change


async def account(world, subscriber: int) -> subscriptions_pb2.Account:
    return (await world.call("GetAccount", subscriptions_pb2.GetAccountRequest(subscriber_id=subscriber), PUBLIC)).account


async def answer(world, subscriber: int, accept: bool, *, key: str | None = None, request_id: str | None = None):
    [change] = (await account(world, subscriber)).price_changes
    return await world.call("AnswerPriceChange", subscriptions_pb2.AnswerPriceChangeRequest(
        subscriber_id=subscriber, price_change_id=change.price_change_id, accept=accept), PUBLIC, key=key,
        request_id_=request_id)


async def requests(world) -> dict[int, dict]:
    rows = await world.owner.fetch(
        "select subscriber_id, kind, state, answer, old_price_minor, new_price_minor, new_price_from::text, leaves_on::text, "
        "to_char(window_ends_local, 'YYYY-MM-DD\"T\"HH24:MI') as ends, request_id from price_change_request order by subscriber_id")
    return {r["subscriber_id"]: dict(r) for r in rows}


async def waiting_messages(world, topic: str) -> list[outbox.Message]:
    async with world.engine.db.transaction(readonly=True) as tx:
        ids = [r["id"] for r in await tx.fetch(
            "select id from outbox_message where delivered_at is null and topic = $1 order by id", topic)]
        return [await outbox.load(tx, message_id) for message_id in ids]


# -- the start ----------------------------------------------------------------------

async def test_the_launch_asks_every_paid_family_subscriber_in_germany_once(world):
    change = await started(world)
    asked = await requests(world)
    assert sorted(asked) == [203, 205, 206, 207]
    run = await world.owner.fetchval("select 'launch-' || id from launch where change_id = $1", change.id)
    assert {(r["kind"], r["state"], r["old_price_minor"], r["new_price_minor"], r["ends"], r["request_id"])
            for r in asked.values()} == {("consent", "waiting", 1899, 2099, "2026-12-17T23:59", run)}
    [activated] = await world.events("change.activated")
    assert '"asked": 4' in activated["body"] and '"window_ends": "2026-12-17T23:59"' in activated["body"]
    # New subscribers pay the new price from 1 December, through the price list.
    rows = await world.owner.fetch("select amount_minor, lower(valid) as starts from list_price "
                                   "where plan_id = 'family' and market = 'DE' order by lower(valid)")
    assert [(r["amount_minor"], r["starts"]) for r in rows][-1] == (2099, datetime(2026, 12, 1))
    # Each request reaches the listener's inbox from the outbox, once however often it arrives.
    messages = await waiting_messages(world, migrations.REQUEST)
    assert len(messages) == 4 and {m.request_id for m in messages} == {run}
    deliveries = [d for d in await world.engine.deliver_outbox() if d.topic == migrations.REQUEST]
    assert {(d.consumer, d.delivered) for d in deliveries} == {("listeners", True)}
    again = await world.engine.relay.deliver(messages[0])
    assert again.facts["arrivals"] == 2
    notices = await world.owner.fetch("select subscriber_id, subject, body, arrivals from subscriber_notice order by subscriber_id")
    assert [(n["subscriber_id"], n["subject"]) for n in notices] == [
        (s, "Your price: we ask for your consent") for s in (203, 205, 206, 207)]
    assert "€18.99" in notices[0]["body"] and "€20.99" in notices[0]["body"] and "not a legal requirement" in notices[0]["body"]
    assert sum(n["arrivals"] for n in notices) == 5


async def test_a_second_launch_pass_asks_nobody_twice(world):
    change = await started(world)
    world.clock.at = at(2026, 11, 2, 8, 5)
    await world.engine.run_launches()
    assert await world.owner.fetchval("select count(*) from price_change_request where change_id = $1", change.id) == 4


# -- what the listener sees ---------------------------------------------------------------

async def test_the_account_shows_the_request_and_both_outcomes_with_their_days(world):
    await started(world)
    world.clock.at = at(2026, 11, 2, 9, 0)
    on_17th = await account(world, 205)
    [change] = on_17th.price_changes
    assert (change.kind, change.state, change.old_price, change.new_price) == ("consent", "waiting", eur(1899), eur(2099))
    assert (change.new_subscribers_from.local, change.new_subscribers_from.utc) == ("2026-12-01T00:00", "2026-11-30T23:00:00Z")
    assert (change.window_ends.local, change.window_ends.utc) == ("2026-12-17T23:59", "2026-12-17T22:59:00Z")
    # The maquette's case: billed on the 17th, a yes pays €20.99 from 17 December; without one, the plan ends that
    # day, when the month paid on 17 November runs out, and nothing is charged.
    assert (change.applies_from, change.if_no_leaves_on, change.leaves_on, change.new_price_from) == (
        "2026-12-17", "2026-12-17", "", "")
    assert "not a legal requirement" in change.if_no_answer and "Kammergericht" in change.legal_basis
    s = on_17th.subscription
    assert (s.ends_on, s.next_billing_on, s.next_charge) == ("2026-12-17", "2026-11-17", eur(1899))
    # Billed on the 5th: a yes pays from 5 December; without one, the month paid on 5 December runs to 5 January.
    on_5th = await account(world, 206)
    [change] = on_5th.price_changes
    assert (change.applies_from, change.if_no_leaves_on) == ("2026-12-05", "2027-01-05")
    assert (on_5th.subscription.ends_on, on_5th.subscription.next_billing_on) == ("2027-01-05", "2026-11-05")
    # Billed on the 18th: the deadline falls in the month paid on 18 November, which runs to 18 December.
    [change] = (await account(world, 207)).price_changes
    assert (change.applies_from, change.if_no_leaves_on) == ("2026-12-18", "2026-12-18")
    # On 6 December the next charge of the subscriber billed on the 5th depends on the answer: none is shown.
    world.clock.at = at(2026, 12, 6, 9, 0)
    on_5th = await account(world, 206)
    assert (on_5th.subscription.ends_on, on_5th.subscription.next_billing_on, on_5th.subscription.HasField("next_charge")) == (
        "2027-01-05", "", False)
    assert on_5th.price_changes[0].applies_from == "2027-01-05"


async def test_a_yes_sets_the_new_price_from_the_next_charge_once_and_keeps_its_answer(world):
    await started(world)
    world.clock.at = at(2026, 11, 3, 10, 0)
    response = await answer(world, 205, True, key="key-yes-205-0001", request_id="req-yes-205-0001")
    change = response.price_change
    assert (change.state, change.new_price_from, change.applies_from, change.if_no_leaves_on) == (
        "accepted", "2026-12-17", "", "")
    history = await world.owner.fetch("select from_on::text, price_minor, change_id from subscription_price "
                                      "where subscription_id = 205 order by from_on")
    assert [(h["from_on"], h["price_minor"]) for h in history] == [("2026-03-17", 1899), ("2026-12-17", 2099)]
    [event] = await world.events("price_change.answered")
    assert (event["actor"], event["actor_role"], event["request_id"]) == ("subscriber-205", "subscriber", "req-yes-205-0001")
    assert '"answer": "yes"' in event["body"] and '"to": "accepted"' in event["body"]
    # The same call again, with its key: the recorded answer; the same answer with another key: no second event.
    replay = await answer(world, 205, True, key="key-yes-205-0001")
    assert replay.SerializeToString() == response.SerializeToString()
    assert (await answer(world, 205, True)).price_change.state == "accepted"
    assert len(await world.events("price_change.answered")) == 1
    # Changing one's mind is refused: the answer stays.
    refused = await answer(world, 205, False)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and "answered already" in refused.refusal.reason
    # The account: €18.99 on 17 November, €20.99 from 17 December, and no end.
    s = (await account(world, 205)).subscription
    assert (s.ends_on, s.next_billing_on, s.next_charge) == ("", "2026-11-17", eur(1899))
    world.clock.at = at(2026, 12, 1, 9, 0)
    s = (await account(world, 205)).subscription
    assert (s.next_billing_on, s.next_charge) == ("2026-12-17", eur(2099))


async def test_a_no_ends_the_paid_plan_when_the_month_paid_at_the_deadline_runs_out(world):
    await started(world)
    world.clock.at = at(2026, 11, 3, 10, 0)
    change = (await answer(world, 206, False)).price_change
    assert (change.state, change.leaves_on, change.if_no_leaves_on, change.applies_from) == (
        "declined", "2027-01-05", "", "")
    rows = await world.owner.fetch("select plan_id, paid, started_on::text, ended_on::text from subscription "
                                   "where subscriber_id = 206 order by started_on")
    assert [tuple(r) for r in rows] == [("family", True, "2026-04-05", "2027-01-05"), ("free", False, "2027-01-05", None)]
    s = (await account(world, 206)).subscription
    assert (s.plan, s.ends_on, s.next_billing_on, s.next_charge) == ("family", "2027-01-05", "2026-11-05", eur(1899))
    world.clock.at = at(2027, 1, 5, 9, 0)
    after = await account(world, 206)
    assert (after.subscription.plan, after.subscription.paid, list(after.price_changes)) == ("free", False, [])


async def test_answers_that_cannot_be_taken(world):
    await started(world)
    [mine] = (await account(world, 205)).price_changes
    with pytest.raises(NotFound):  # another listener's request
        await world.call("AnswerPriceChange", subscriptions_pb2.AnswerPriceChangeRequest(
            subscriber_id=206, price_change_id=mine.price_change_id, accept=True), PUBLIC)
    with pytest.raises(NotFound):
        await world.call("AnswerPriceChange", subscriptions_pb2.AnswerPriceChangeRequest(
            subscriber_id=205, price_change_id=99_999, accept=True), PUBLIC)
    with pytest.raises(InvalidArgument):
        await world.call("AnswerPriceChange", subscriptions_pb2.AnswerPriceChangeRequest(price_change_id=1, accept=True),
                         PUBLIC)
    # After the deadline, 23:59 in Berlin, the window is closed even before its end is acted on.
    world.clock.at = at(2026, 12, 17, 22, 59)
    late = await answer(world, 207, True)
    assert late.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE
    assert late.refusal.reason == "The time to answer ended on 17 December 2026, 23:59 (Europe/Berlin)."


# -- the end of the window ----------------------------------------------------------------

async def test_the_end_of_the_window_acts_once_and_tells_each_listener(world):
    change = await started(world)
    world.clock.at = at(2026, 11, 3, 10, 0)
    await answer(world, 205, True)
    await answer(world, 206, False)
    world.clock.at = at(2026, 12, 17, 22, 58, 30)  # 23:58:30 in Berlin: still open
    assert await world.engine.settle_migrations() == []
    world.clock.at = at(2026, 12, 17, 23, 0)  # midnight in Berlin
    whose = {r["id"]: r["subscriber_id"] for r in await world.owner.fetch("select id, subscriber_id from subscription")}
    settled = {whose[s.subscription]: s for s in await world.engine.settle_migrations()}
    assert {s: (o.state, o.effect, o.dates) for s, o in settled.items()} == {
        203: ("lapsed", "left", {"leaves_on": "2027-01-10"}),  # billed on the 10th: silence is no
        205: ("accepted", "none", {}),
        206: ("declined", "left", {"leaves_on": "2027-01-05"}),
        207: ("lapsed", "left", {"leaves_on": "2026-12-18"}),
    }
    assert await world.engine.settle_migrations() == []  # once
    asked = await requests(world)
    assert {s: (r["state"], r["leaves_on"]) for s, r in asked.items()} == {
        203: ("lapsed", "2027-01-10"), 205: ("accepted", None), 206: ("declined", "2027-01-05"), 207: ("lapsed", "2026-12-18")}
    left = await world.events("subscription.left_after_price_change")
    assert len(left) == 3 and {e["request_id"] for e in left} == {f"migration-{change.id}-settlement"}
    assert {e["actor"] for e in left} == {"migrations"}
    outcomes = await waiting_messages(world, migrations.OUTCOME)
    assert len(outcomes) == 3
    await world.engine.deliver_outbox()
    told = await world.owner.fetch("select subscriber_id, body from subscriber_notice where kind = 'price_change.outcome' "
                                   "order by subscriber_id")
    assert [t["subscriber_id"] for t in told] == [203, 206, 207]
    assert "ends on 2026-12-18, when the period you paid for runs out" in told[2]["body"]
    # Where the change stands, for the console.
    progress = (await world.call("GetChange", changes_pb2.GetChangeRequest(change_id=change.id), FINANCE)).change.migration
    assert (progress.requirement, progress.window_ends.local, progress.asked, progress.waiting, progress.accepted,
            progress.declined, progress.lapsed, progress.new_price, progress.left) == (
        "consent", "2026-12-17T23:59", 4, 0, 1, 1, 2, 0, 3)
    # 207 is on the free plan from 18 December; the home's revenue counts what each pays that day.
    world.clock.at = at(2026, 12, 20, 9, 0)
    assert (await account(world, 207)).subscription.plan == "free"
    home = await world.call("GetOverview", overview_pb2.GetOverviewRequest(), FINANCE)
    [germany] = [r for r in home.monthly_revenue if r.market == "DE"]
    assert germany.revenue == eur(1596 + 1764 + 1596)  # 203 and 206 at €18.99 until they leave, 205 at €20.99


async def test_the_server_s_jobs_settle_the_window_and_log_each_request_once(world):
    await started(world)
    world.clock.at = at(2026, 12, 17, 23, 0, 5)
    logs = io.StringIO()
    jobs = Jobs(world.engine, JsonLog(world.clock.now, logs))
    for _ in range(3):
        await jobs.run_pass()
        world.clock.advance(seconds=5)
    lines = [json.loads(line) for line in logs.getvalue().splitlines()]
    settled = [line for line in lines if line["event"] == "price_change_settled"]
    # Nobody answered: each leaves when the month paid at the deadline runs out, once, whatever the passes.
    assert sorted((line["leaves_on"], line["subscription"], line["state"], line["effect"]) for line in settled) == [
        ("2026-12-17", 205, "lapsed", "left"), ("2026-12-18", 207, "lapsed", "left"),
        ("2027-01-05", 206, "lapsed", "left"), ("2027-01-10", 14, "lapsed", "left")]
    assert {line["level"] for line in settled} == {"info"}
    told = [line for line in lines if line["event"] == "outbox_delivered" and line["topic"] == migrations.OUTCOME]
    assert len(told) == 4 and {line["consumer"] for line in told} == {"listeners"}


async def test_a_window_that_cannot_be_settled_holds_up_neither_the_others_nor_the_outbox(world, monkeypatch):
    """A fault no rule foresaw in one request's end of window: the other three settle and their listeners are told in
    the same pass, the failure is logged once with its request, and the request settles once the fault is gone."""
    await started(world)
    world.clock.at = at(2026, 12, 17, 23, 0, 5)
    stuck = await world.owner.fetchval("select min(id) from price_change_request")
    fault = {"on": True}
    settle = migrations.Migrations._settle

    async def faulty(self, tx, request_id):
        if fault["on"] and request_id == stuck:
            raise RuntimeError("a fault in the end of a window")
        return await settle(self, tx, request_id)

    monkeypatch.setattr(migrations.Migrations, "_settle", faulty)
    logs = io.StringIO()
    jobs = Jobs(world.engine, JsonLog(world.clock.now, logs))
    for _ in range(2):
        await jobs.run_pass()
        world.clock.advance(seconds=5)
    lines = [json.loads(line) for line in logs.getvalue().splitlines()]
    assert len([line for line in lines if line["event"] == "price_change_settled"]) == 3
    told = [line for line in lines if line["event"] == "outbox_delivered" and line["topic"] == migrations.OUTCOME]
    assert len(told) == 3
    [failed] = [line for line in lines if line["event"] == "price_change_settle_failed"]
    assert (failed["level"], failed["price_change"], failed["error"]) == (
        "warning", stuck, "RuntimeError: a fault in the end of a window")
    fault["on"] = False
    await jobs.run_pass()
    lines = [json.loads(line) for line in logs.getvalue().splitlines()]
    assert [line["price_change"] for line in lines if line["event"] == "price_change_settled"][-1] == stuck
    assert not [line for line in lines if line["event"] == "jobs_pass_failed"]


async def test_a_job_that_fails_holds_up_none_of_the_jobs_after_it(world, monkeypatch):
    """The end of the windows fails for a fault of its own: the outbox after it still delivers the requests, the job's
    failure is logged once, and once more when it works again."""
    await started(world)

    async def faulty():
        raise RuntimeError("a fault in one job")

    monkeypatch.setattr(world.engine, "settle_migrations", faulty)
    logs = io.StringIO()
    jobs = Jobs(world.engine, JsonLog(world.clock.now, logs))
    for _ in range(2):
        await jobs.run_pass()
    lines = [json.loads(line) for line in logs.getvalue().splitlines()]
    told = [line for line in lines if line["event"] == "outbox_delivered" and line["topic"] == migrations.REQUEST]
    assert len(told) == 4
    monkeypatch.undo()
    await jobs.run_pass()
    lines = [json.loads(line) for line in logs.getvalue().splitlines()]
    assert [(line["event"], line.get("job")) for line in lines if line["event"].startswith("jobs_")] == [
        ("jobs_pass_failed", "price changes"), ("jobs_working_again", "price changes")]


# -- a notice market ---------------------------------------------------------------------

async def test_in_italy_a_notice_applies_the_price_unless_the_listener_leaves(world):
    # 101 takes the Student Autumn Pass on 31 October: €2.99 for three months, billed on the 28th, the list price
    # from 28 January 2027. 103 is a Student subscriber billed on the 10th.
    pass_ = await scheduled(world, student_autumn(), MARKETING, FINANCE)
    world.clock.at = at(2026, 10, 26, 7, 59, 30)
    await world.engine.run_launches()
    world.clock.at = at(2026, 10, 31, 9, 0)
    quote = (await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="student", market="IT", offer_id=pass_.id,
                                                                     subscriber_id=101), PUBLIC)).quote
    await world.call("ConfirmQuote", subscriptions_pb2.ConfirmQuoteRequest(quote_id=quote.quote_id, subscriber_id=101), PUBLIC)
    await world.engine.deliver_outbox()  # its first payment settles: a rise waits for a pending one (§8.9)
    rise = family_migration(title="Student price, Italy", plan="student", market="IT", amount=eur(649))
    await scheduled(world, rise, LEAD, FINANCE)
    world.clock.at = at(2026, 11, 2, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    asked = await requests(world)
    assert {s: (r["kind"], r["old_price_minor"], r["ends"]) for s, r in asked.items()} == {
        101: ("notice", 579, "2026-12-02T23:59"), 103: ("notice", 579, "2026-12-02T23:59")}
    # The offer's months keep their price: the new one applies from the first charge after them.
    world.clock.at = at(2026, 11, 3, 9, 0)
    on_offer = await account(world, 101)
    [change] = on_offer.price_changes
    assert (change.kind, change.applies_from, change.if_no_leaves_on) == ("notice", "2027-01-28", "2027-01-28")
    s = on_offer.subscription
    assert (s.price, s.full_price_from, s.full_price, s.ends_on) == (eur(299), "2027-01-28", eur(579), "")
    [change] = (await account(world, 103)).price_changes
    assert (change.applies_from, change.if_no_leaves_on) == ("2026-12-10", "2026-12-10")
    # 103 leaves; 101 says yes, which only says it read the notice.
    left = (await answer(world, 103, False)).price_change
    assert (left.state, left.leaves_on) == ("declined", "2026-12-10")
    read = (await answer(world, 101, True)).price_change
    assert (read.state, read.applies_from, read.if_no_leaves_on) == ("waiting", "2027-01-28", "")
    # The notice runs out at midnight in Rome on 3 December.
    world.clock.at = at(2026, 12, 2, 23, 0)
    settled = {s.subscription: (s.state, s.effect, s.dates) for s in await world.engine.settle_migrations()}
    on_offer_id = await world.owner.fetchval("select id from subscription where subscriber_id = 101 and paid")
    assert settled[on_offer_id] == ("new_price", "new_price", {"new_price_from": "2027-01-28"})
    assert [v for k, v in settled.items() if k != on_offer_id] == [("declined", "left", {"leaves_on": "2026-12-10"})]
    world.clock.at = at(2027, 1, 27, 9, 0)
    s = (await account(world, 101)).subscription
    assert (s.price, s.next_billing_on, s.next_charge, s.full_price) == (eur(299), "2027-01-28", eur(649), eur(649))
    told = {e["action"]: e["request_id"] for e in await world.events()
            if e["action"] in ("subscription.price_changed", "subscription.left_after_price_change")}
    assert sorted(told) == ["subscription.left_after_price_change", "subscription.price_changed"]
    assert len(set(told.values())) == 1 and next(iter(told.values())).endswith("-settlement")


async def test_a_second_rise_leaves_for_later_a_subscription_whose_first_new_price_waits_for_its_offer(world):
    """§8.9: 101 is on the Student Autumn Pass until 28 January 2027, so the first rise's price takes over that day; a
    second rise, whose notice runs out on 3 January, would take over the same day. It does not reach 101, who keeps the
    first rise's price, and its launch counts 101 as left for later; 103, whose first new price took over on
    10 December, is told."""
    pass_ = await scheduled(world, student_autumn(), MARKETING, FINANCE)
    world.clock.at = at(2026, 10, 26, 7, 59, 30)
    await world.engine.run_launches()
    world.clock.at = at(2026, 10, 31, 9, 0)
    quote = (await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="student", market="IT", offer_id=pass_.id,
                                                                     subscriber_id=101), PUBLIC)).quote
    await world.call("ConfirmQuote", subscriptions_pb2.ConfirmQuoteRequest(quote_id=quote.quote_id, subscriber_id=101), PUBLIC)
    await world.engine.deliver_outbox()  # its first payment settles: a rise waits for a pending one (§8.9)
    await scheduled(world, family_migration(title="Student price, Italy", plan="student", market="IT", amount=eur(649)),
                    LEAD, FINANCE)
    world.clock.at = at(2026, 11, 2, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    world.clock.at = at(2026, 12, 2, 23, 0)
    assert [s.dates for s in await world.engine.settle_migrations()] == [
        {"new_price_from": "2026-12-10"}, {"new_price_from": "2027-01-28"}]
    world.clock.at = at(2026, 12, 3, 9, 0)
    again = await scheduled(world, family_migration(title="Student price again, Italy", plan="student", market="IT",
                                                    amount=eur(699), notices_local="2026-12-04T09:00",
                                                    starts_local="2027-01-01T00:00"), LEAD, FINANCE)
    simulated = (await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(change_id=again.id),
                                  LEAD)).result
    assert {a.name: (a.value, a.source) for a in simulated.assumptions}["existing"] == (
        1, "counted in the data at 2026-12-03T09:00:00Z, leaving out 1 waiting for an earlier migration's price or a "
           "first payment (§8.9)")
    world.clock.at = at(2026, 12, 4, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    asked = await world.owner.fetch("select subscriber_id, old_price_minor from price_change_request where change_id = $1",
                                    again.id)
    assert [tuple(r) for r in asked] == [(103, 649)]
    activated = [json.loads(e["body"]) for e in await world.events("change.activated")][-1]
    assert (activated["change"], activated["asked"], activated["left_for_later"]) == (again.id, 1, 1)
    # Its notice runs out: 103 pays it from its next charge, and 101 the first rise's price after the offer.
    world.clock.at = at(2027, 1, 3, 23, 0)
    paying = await world.owner.fetchval("select id from subscription where subscriber_id = 103 and paid")
    assert [(s.subscription, s.dates) for s in await world.engine.settle_migrations()] == [
        (paying, {"new_price_from": "2027-01-10"})]
    on_offer = await world.owner.fetchval("select id from subscription where subscriber_id = 101 and paid")
    history = await world.owner.fetch("select from_on::text, price_minor from subscription_price where subscription_id = $1 "
                                      "order by from_on", on_offer)
    assert [tuple(r) for r in history] == [("2026-10-31", 299), ("2027-01-28", 649)]


async def confirmed_pending(world, monkeypatch, subscriber: int, market: str) -> str:
    """A listener takes Individual on 24 October, and the provider takes its time: the first payment stays pending."""
    async def slow(charge):
        event = ProviderEvent("simulated", f"evt_slow_{subscriber}", PENDING, charge.payment_id, "sim-pay-slow",
                              world.clock.now())
        return ChargeResult("simulated", "sim-pay-slow", (event,))

    monkeypatch.setattr(world.engine.payments, "charge", slow)
    quote = (await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="individual", market=market,
                                                                     subscriber_id=subscriber), PUBLIC)).quote
    payment = (await world.call("ConfirmQuote", subscriptions_pb2.ConfirmQuoteRequest(
        quote_id=quote.quote_id, subscriber_id=subscriber), PUBLIC)).confirmation.payment.payment_id
    await world.engine.deliver_outbox()
    monkeypatch.undo()
    return payment


async def declined(world, payment: str, subscriber: int) -> None:
    event = ProviderEvent("simulated", f"evt_declined_{subscriber}", FAILED, payment, "sim-pay-slow", world.clock.now(),
                          "The card was declined.")
    assert await world.engine.provider_events.receive(event) == "applied"


async def test_a_rise_leaves_for_later_a_subscription_whose_first_payment_is_pending(world, monkeypatch):
    """§8.9: 401's first payment is still pending when a rise in France starts on 2 November, so the rise does not ask
    it, and says so: an answer would write the subscription's future while its payment may still undo it. The payment
    is declined on 3 November: 401 is on Free from the next day, its only plan from then, and on 5 November it takes
    Individual again."""
    payment = await confirmed_pending(world, monkeypatch, 401, "FR")
    rise = await scheduled(world, family_migration(title="Individual price, France", plan="individual", market="FR",
                                                   amount=eur(1199)), LEAD, FINANCE)
    world.clock.at = at(2026, 11, 2, 7, 30)
    simulated = (await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(change_id=rise.id),
                                  LEAD)).result
    assert "leaving out 1 waiting for an earlier migration's price or a first payment (§8.9)" in (
        {a.name: a.source for a in simulated.assumptions}["existing"])
    world.clock.at = at(2026, 11, 2, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    assert (await account(world, 401)).price_changes == []
    activated = [json.loads(e["body"]) for e in await world.events("change.activated")][-1]
    assert (activated["change"], activated["left_for_later"]) == (rise.id, 1)
    world.clock.at = at(2026, 11, 3, 9, 0)
    await declined(world, payment, 401)
    world.clock.at = at(2026, 11, 5, 9, 0)
    quote = (await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="individual", market="FR", subscriber_id=401),
                              PUBLIC)).quote
    again = (await world.call("ConfirmQuote", subscriptions_pb2.ConfirmQuoteRequest(
        quote_id=quote.quote_id, subscriber_id=401), PUBLIC)).confirmation.subscription
    assert (again.plan, again.started_on) == ("individual", "2026-11-05")
    history = await world.owner.fetch("select plan_id, started_on::text, ended_on::text from subscription "
                                      "where subscriber_id = 401 order by started_on")
    assert [tuple(r) for r in history] == [("free", "2026-01-10", "2026-10-24"), ("individual", "2026-10-24", "2026-11-04"),
                                           ("free", "2026-11-04", "2026-11-05"), ("individual", "2026-11-05", None)]
    report = await check(world.owner)
    assert report["broken"] == 0, [i for i in report["invariants"] if i["violations"]]


async def test_a_listener_whose_first_payment_was_declined_during_a_rise_activates_a_pass(world, monkeypatch):
    """§9.3: 105 takes Individual in Italy and its first payment is pending when a rise there starts: the rise leaves it
    for later. The payment is declined on 3 November, and on 5 November 105 activates a gift pass."""
    payment = await confirmed_pending(world, monkeypatch, 105, "IT")
    gift = await scheduled(world, gift_pass(), LEAD, FINANCE)
    world.clock.at = at(2026, 10, 31, 22, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    world.clock.at = at(2026, 11, 1, 9, 0)
    code = (await world.call("BuyPrepaidPass", subscriptions_pb2.BuyPrepaidPassRequest(subscriber_id=101, pass_id=gift.id),
                             PUBLIC)).code
    await world.engine.deliver_outbox()
    await scheduled(world, family_migration(title="Individual price, Italy", plan="individual", market="IT",
                                            amount=eur(1199)), LEAD, FINANCE)
    world.clock.at = at(2026, 11, 2, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    assert (await account(world, 105)).price_changes == []
    world.clock.at = at(2026, 11, 3, 9, 0)
    await declined(world, payment, 105)
    world.clock.at = at(2026, 11, 5, 9, 0)
    activated = (await world.call("ActivatePrepaidPass", subscriptions_pb2.ActivatePrepaidPassRequest(
        subscriber_id=105, code=code.code), PUBLIC)).subscription
    assert (activated.plan, activated.started_on, activated.ends_on) == ("individual", "2026-11-05", "2027-02-05")
    report = await check(world.owner)
    assert report["broken"] == 0, [i for i in report["invariants"] if i["violations"]]


async def test_a_declined_first_payment_does_not_build_on_an_end_written_by_hand(world, monkeypatch):
    """Nothing in the engine ends a subscription while its first payment is pending: an end written there by hand is
    not built on. The decline is refused with the reason, and the payment stays pending."""
    payment = await confirmed_pending(world, monkeypatch, 401, "FR")
    await world.owner.execute("update subscription set ended_on = '2026-12-24' where subscriber_id = 401 and paid")
    with pytest.raises(FailedPrecondition, match="ends on 2026-12-24 already"):
        await world.engine.provider_events.receive(ProviderEvent(
            "simulated", "evt_declined_by_hand", FAILED, payment, "sim-pay-slow", world.clock.now(), "The card was declined."))
    assert await world.owner.fetchval("select state from payment where subscriber_id = 401") == "pending"


# -- the simulation -----------------------------------------------------------------------

async def test_the_simulation_counts_the_existing_subscribers_and_says_where_each_assumption_comes_from(world):
    await add_family(world)
    change = await create(world, family_migration(), LEAD)
    response = await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(change_id=change.id), LEAD)
    result = response.result
    assert (result.before.price, result.before.net, result.before.artists) == (eur(1899), eur(1596), eur(958))
    assert (result.after.price, result.after.net, result.after.artists) == (eur(2099), eur(1764), eur(1058))
    assert (result.new_subscribers_from.local, result.notices_from.local, result.window_ends.local) == (
        "2026-12-01T00:00", "2026-11-02T09:00", "2026-12-17T23:59")
    assert {a.name: (a.value, a.source) for a in result.assumptions} == {
        "existing": (4, "counted in the data at 2026-10-24T08:42:00Z"),
        "acceptance": (9000, "default: business book §16 (illustrative)")}
    assert (result.existing, result.accepting, result.not_accepting, result.moving_to_free) == (4, 4, 0, 0)
    assert "they answer by 17 December 2026, 23:59 (Europe/Berlin)" in result.existing_from
    assert [c.number for c in result.finance_conditions if c.met] == [1, 5]
    assert result.prepaid_passes_untouched == 0


async def test_a_migration_simulates_the_same_before_and_after_its_launch(world):
    """The launch puts the new price in the price list from its start: the simulation still starts from the price the
    migration raises, so the console shows the same numbers through the consent window."""
    await add_family(world)
    change = await scheduled(world, family_migration(), LEAD, FINANCE)
    world.clock.at = at(2026, 11, 2, 7, 59, 30)

    async def simulate() -> simulation_pb2.SimulateMigrationResponse:
        return await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(change_id=change.id), LEAD)

    before = await simulate()
    assert before.WhichOneof("outcome") == "result", before
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    after = await simulate()
    assert after.WhichOneof("outcome") == "result", after
    assert after.result == before.result
    assert (after.result.before.price, after.result.after.price, after.result.existing) == (eur(1899), eur(2099), 4)


async def test_the_simulation_gives_the_maquette_s_numbers_with_its_typed_assumptions(world):
    change = await create(world, family_migration(), LEAD)
    typed = [simulation_pb2.AssumptionOverride(name="existing", value=8412),
             simulation_pb2.AssumptionOverride(name="acceptance", value=9300)]
    result = (await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(
        change_id=change.id, overrides=typed), LEAD)).result
    assert (result.existing, result.accepting, result.not_accepting, result.moving_to_free) == (8412, 7823, 589, 589)
    assert (result.monthly_revenue_change, result.monthly_contribution_change, result.revenue_at_risk_monthly) == (
        eur(374_220), eur(144_916), eur(940_044))
    assert (result.break_even_acceptance_revenue_bp, result.break_even_acceptance_contribution_bp) == (9048, 9042)
    assert {a.name: a.source for a in result.assumptions} == {
        "existing": "typed by the commercial lead at 2026-10-24T08:42:00Z",
        "acceptance": "typed by the commercial lead at 2026-10-24T08:42:00Z"}


async def test_simulation_refusals_and_errors(world):
    change = await create(world, family_migration(), LEAD)
    offer = await create(world, student_autumn(), MARKETING)
    with pytest.raises(InvalidArgument, match="a campaign has SimulateOffer"):
        await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(change_id=offer.id), LEAD)
    with pytest.raises(InvalidArgument, match="a price migration has SimulateMigration"):
        await world.call("SimulateOffer", simulation_pb2.SimulateOfferRequest(change_id=change.id, market="DE"), LEAD)
    with pytest.raises(NotFound):
        await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(change_id=99_999), LEAD)
    refused = await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(change_id=change.id), AUDITOR)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    typed = simulation_pb2.AssumptionOverride
    for overrides, words in [([typed(name="take_up", value=1)], "not an assumption"),
                             ([typed(name="acceptance", value=10_001)], "between 0 and 10000"),
                             ([typed(name="existing", value=1)] * 2, "typed twice")]:
        with pytest.raises(InvalidArgument, match=words):
            await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(
                change_id=change.id, overrides=overrides), LEAD)
    unfinished = await create(world, family_migration(notices_local=""), LEAD)
    refused = await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(change_id=unfinished.id), LEAD)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_INVALID and "Nothing to simulate yet" in refused.refusal.reason


# -- the markets' rules, the roles ----------------------------------------------------

async def test_each_market_shows_the_law_apart_from_the_choice(world):
    markets = {m.code: m for m in (await world.call("ListMarkets", catalog_pb2.ListMarketsRequest(), PUBLIC)).markets}
    de = markets["DE"].price_change_policy
    assert (de.legal_requirement, de.window_days, de.after_window) == ("consent", 45, "move_to_free")
    assert de.commercial_choice.startswith("When the period already paid at the consent deadline runs out")
    assert len(de.legal_sources) == 4 and len(de.alternatives) == 2
    assert de.label == "The music service's choice, configurable per market; not a legal requirement."
    assert {code: (m.price_change_policy.legal_requirement, m.price_change_policy.window_days,
                   m.price_change_policy.after_window) for code, m in markets.items() if code != "DE"} == {
        "IT": ("notice", 30, "new_price"), "FR": ("notice", 30, "new_price"), "GB": ("notice", 30, "new_price")}


async def test_the_commercial_lead_writes_a_migration_and_finance_signs_it(world):
    refused = await world.call("CreateChange", changes_pb2.CreateChangeRequest(price_migration=family_migration()), MARKETING)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    change = await create(world, family_migration(), LEAD)
    validated = (await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=change.id, version=1),
                                  LEAD)).change
    assert validated.validation.valid
    assert [(s.role, list(s.conditions)) for s in validated.required_signatures] == [(common_pb2.ROLE_FINANCE, [1, 5])]
    assert "asked for their consent from 2 November 2026, 09:00 (Europe/Berlin), within 45 days" in validated.sentence


async def test_a_migration_in_force_is_not_suspended(world):
    change = await started(world)
    refused = await world.call("SuspendChange", changes_pb2.SuspendChangeRequest(change_id=change.id, reason="Too soon."),
                               ON_CALL)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and "not suspended" in refused.refusal.reason


async def test_a_second_migration_waits_for_the_first_s_window(world):
    await started(world)
    world.clock.at = at(2026, 11, 3, 9, 0)
    second = await create(world, family_migration(title="Family again", amount=eur(2199), notices_local="2026-12-10T09:00",
                                                  starts_local="2027-01-01T00:00"), LEAD)
    refused = await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=second.id, version=1), LEAD)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_INVALID and refused.refusal.facts["checks"] == "overlap"
    assert "asks or tells the existing subscribers until 17 December 2026, 23:59 (Europe/Berlin)" in refused.refusal.reason
    later = apply(family_migration(), {"title": "Family again", "amount": eur(2199), "notices_local": "2026-12-18T09:00",
                                       "starts_local": "2027-01-01T00:00"})
    third = await create(world, later, LEAD)
    response = await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=third.id, version=1), LEAD)
    assert response.change.validation.valid, response
