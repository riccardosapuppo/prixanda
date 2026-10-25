"""The generator gives the same data for the same seed, and every invariant
holds on it and fires when its rule is broken (a check that cannot fail
checks nothing)."""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import asyncpg
import pytest

from commerce.audit import head
from commerce.generate import START, demo_listeners, fingerprint, generate, load, ordinal
from commerce.invariants import check
from conftest import ADMIN_URL, _admin as admin, fresh_database, on_database
from helpers import add_subscription, new_change


def test_the_demo_s_paying_listeners_say_their_month_and_billing_day_for_any_until():
    labels = lambda until: [row[3] for row in demo_listeners(5001, 9001, START, until)[3]]  # noqa: E731
    family, individual = labels(date(2026, 10, 24))[4:]
    assert "since June 2025, billed on the 15th:" in family and "since May 2026, billed on the 8th:" in individual
    # The console's stack loads the data up to the day it starts: a month later, the labels follow the dates.
    family, individual = labels(date(2026, 11, 24))[4:]
    assert "since July 2025, billed on the 16th:" in family and "since June 2026, billed on the 8th:" in individual
    assert all("{" not in label for label in labels(date(2026, 11, 24)))
    assert [ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28)] == [
        "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "28th"]


def test_the_demo_s_histories_follow_on_when_the_data_start_later():
    """Days counted back from --until stop at --start. With --start 2026-01-01 the Family subscriber in Germany joins
    and begins to pay on that day, and so does the student who paid before: the Free plan of no day goes, so that no
    subscription ends on the day it started (V5, subscription_dates), and each history follows on from the day its
    listener joined."""
    subscribers, subscriptions, _, rows = demo_listeners(5001, 9001, date(2026, 1, 1), date(2026, 10, 24))
    for subscriber, _, joined in subscribers:
        history = [(s[4], s[7], s[8]) for s in subscriptions if s[1] == subscriber]
        assert history[0][1] == joined and history[-1][2] is None, history
        assert all(ended > began for _, began, ended in history[:-1]), history
        assert all(before[2] == after[1] for before, after in zip(history, history[1:])), history
    plans = lambda subscriber: [(s[4], str(s[7])) for s in subscriptions if s[1] == subscriber]  # noqa: E731
    assert plans(5005) == [("family", "2026-01-01")]
    assert plans(5003) == [("student", "2026-01-01"), ("free", "2026-06-26")]
    assert "since January 2026, billed on the 1st:" in rows[4][3]


async def test_a_start_too_close_to_until_for_the_demo_s_story_is_refused_with_the_least_and_why():
    """The student who paid before stopped paying 120 days before --until: a --start any later would leave them no day
    paid, against what their label says. The command line refuses it, before it connects, and so does the generator."""
    why = "--start must be at least 121 days before --until: the demo's student who paid before stopped paying 120 days"
    ran = subprocess.run(
        [sys.executable, "-m", "commerce.generate", "--url", "postgresql://nobody@127.0.0.1:9/none",
         "--start", "2026-10-01", "--until", "2026-10-24"],
        capture_output=True, text=True, env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")})
    assert ran.returncode == 2 and why in ran.stderr, ran.stderr
    with pytest.raises(ValueError, match=why):
        await load(None, "small", 7, date(2026, 6, 26), date(2026, 10, 24))  # 120 days


async def test_the_data_can_start_later_in_the_story():
    """--start 2026-01-01: the generator writes the shorter history, and every invariant holds on it."""
    name = await fresh_database()
    try:
        await generate(on_database(ADMIN_URL, name), "small", 7, date(2026, 1, 1), date(2026, 10, 24))
        conn = await asyncpg.connect(on_database(ADMIN_URL, name))
        try:
            report = await check(conn)
        finally:
            await conn.close()
        assert report["broken"] == 0, [i for i in report["invariants"] if i["violations"]]
    finally:
        await admin(f"drop database {name} with (force)")


async def test_the_small_size_has_what_it_declares(generated):
    _, summary = generated
    counts = summary["counts"]
    assert counts["subscribers"] == 5_000 + 6  # the generated people and the demo's six listeners
    assert counts["demo_listeners"] == 6
    assert counts["artists"] == 47
    assert counts["subscriptions"] >= counts["subscribers"]
    assert counts["student_verifications"] > 0 and counts["listening_days"] > 10_000
    assert set(key.split("/")[0] for key in summary["current_subscriptions"]) == {"DE", "FR", "GB", "IT"}


async def test_the_same_seed_gives_the_same_data_and_another_seed_does_not(generated):
    source, _ = generated
    names = [await fresh_database(), await fresh_database()]
    try:
        await generate(on_database(ADMIN_URL, names[0]), "small", 7, date(2025, 1, 1), date(2026, 10, 24))
        await generate(on_database(ADMIN_URL, names[1]), "small", 8, date(2025, 1, 1), date(2026, 10, 24))
        prints = []
        for name in (source, *names):
            conn = await asyncpg.connect(on_database(ADMIN_URL, name))
            try:
                prints.append(await fingerprint(conn))
            finally:
                await conn.close()
        assert prints[0] == prints[1]
        assert prints[0] != prints[2]
    finally:
        for name in names:
            await admin(f"drop database {name} with (force)")


async def test_generating_twice_into_one_database_is_refused(generated):
    source, _ = generated
    with pytest.raises(SystemExit):
        await generate(on_database(ADMIN_URL, source), "small", 7, date(2025, 1, 1), date(2026, 10, 24))


async def test_every_invariant_holds_on_the_generated_data(copy):
    report = await check(copy)
    assert report["checked"] == 18
    assert report["broken"] == 0, [i for i in report["invariants"] if i["violations"]]


async def broken(conn: asyncpg.Connection, **kwargs) -> list[str]:
    report = await check(conn, **kwargs)
    return [i["name"] for i in report["invariants"] if i["violations"]]


async def test_a_gap_in_the_price_list_is_found(copy):
    await copy.execute("alter table list_price disable trigger list_price_only_close")
    await copy.execute("update list_price set valid = tsrange(lower(valid), '2026-01-01') where plan_id = 'duo' and market = 'FR'")
    found = await broken(copy)
    # Duo subscriptions that started in France after the gap opened have no
    # list price either: the second finding is the first one's consequence.
    assert found[0] == "prices_cover_every_paid_plan"
    assert set(found) <= {"prices_cover_every_paid_plan", "paid_subscriptions_start_at_the_list_price"}


async def test_a_plan_without_its_entitlements_is_found(copy):
    await copy.execute("alter table plan_entitlement disable trigger plan_entitlement_only_close")
    await copy.execute("delete from plan_entitlement where plan_id = 'free' and market = 'GB'")
    assert await broken(copy) == ["entitlements_cover_every_plan"]


async def test_a_market_without_vat_is_found(copy):
    await copy.execute("delete from vat_rate where market = 'DE'")
    assert await broken(copy) == ["vat_rates_cover_the_price_list"]


async def test_a_day_on_no_plan_is_found(copy):
    subscriber = await copy.fetchval("select subscriber_id from subscription where ended_on is not null limit 1")
    await copy.execute(
        "update subscription set started_on = started_on + 1 where subscriber_id = $1 and started_on = "
        "(select max(started_on) from subscription where subscriber_id = $1)", subscriber)
    # The start moved, its first price did not: both are found.
    assert await broken(copy) == ["every_subscriber_is_on_one_plan_every_day", "every_subscription_has_its_first_price"]


async def test_a_subscription_at_the_wrong_price_is_found(copy):
    await copy.execute("alter table subscription_price disable trigger subscription_price_written_once")
    await copy.execute("update subscription_price set price_minor = price_minor - 100 "
                       "where subscription_id = (select min(id) from subscription where paid)")
    assert await broken(copy) == ["paid_subscriptions_start_at_the_list_price"]


async def test_a_subscription_without_its_first_price_is_found(copy):
    await copy.execute("alter table subscription_price disable trigger subscription_price_written_once")
    await copy.execute("delete from subscription_price where subscription_id = (select min(id) from subscription where paid)")
    assert await broken(copy) == ["every_subscription_has_its_first_price"]


async def test_weekly_sums_parted_from_their_days_are_found(copy):
    await copy.execute("alter table listening_week disable trigger listening_week_added_only")
    await copy.execute("update listening_week set seconds = seconds + 1 where (artist_id, week, subscriber_id) = "
                       "(select artist_id, week, subscriber_id from listening_week order by 1, 2, 3 limit 1)")
    assert await broken(copy) == ["listening_weeks_sum_their_days"]


async def test_a_day_of_listening_without_its_month_is_found(copy):
    listener = await copy.fetchval("select id from subscriber order by id limit 1")
    await copy.execute("insert into listening_day (subscriber_id, artist_id, day, seconds) values ($1, 1, '2028-03-01', 60)",
                       listener)
    assert await broken(copy) == ["listening_has_its_month"]


async def test_a_code_sold_without_its_payment_or_activated_into_nothing_is_found(copy):
    change = await new_change(copy, kind="prepaid", author="commercial-lead-1",
                              content={"title": "Three-month gift pass", "market": "IT"})
    buyer = await copy.fetchval("select id from subscriber where market = 'IT' order by id limit 1")
    await copy.execute(
        "insert into prepaid_code (code, change_id, version, market, currency, plan_id, months, price_minor, net_minor, "
        "buyer_id, sold_at, valid_until, state, request_id) values ('K7QM-3XTP-9WAD', $1, 1, 'IT', 'EUR', 'individual', 3, "
        "2999, 2458, $2, '2026-10-20 08:00+00', '2027-10-19', 'ready', 'site-buy-00000001')", change, buyer)
    assert await broken(copy) == ["prepaid_codes_follow_their_payment"]
    await copy.execute("alter table prepaid_code disable trigger prepaid_code_guard")
    other = await copy.fetchval("select id from subscription where paid order by id limit 1")
    await copy.execute("update prepaid_code set state = 'activated', activated_by = $1, activated_on = '2026-10-21', "
                       "subscription_id = $2", buyer, other)
    assert await broken(copy) == ["prepaid_codes_follow_their_payment", "activated_codes_run_their_pass"]


async def test_a_later_price_after_the_end_or_without_its_request_is_found(copy):
    migration = await new_change(copy, kind="price_migration", author="commercial-lead-1",
                                 content={"title": "Family price, Germany", "market": "DE"})
    ended = await copy.fetchrow("select id, ended_on from subscription where paid and ended_on is not null order by id limit 1")
    await copy.execute("alter table subscription_price disable trigger subscription_price_rules")
    await copy.execute("insert into subscription_price (subscription_id, from_on, price_minor, change_id) values ($1, $2, 2099, $3)",
                       ended["id"], ended["ended_on"], migration)
    assert await broken(copy) == ["prices_are_charged_while_their_subscription_runs", "later_prices_follow_a_price_migration"]


async def test_a_student_without_a_verification_is_found(copy):
    await copy.execute("delete from student_verification where subscriber_id = "
                       "(select min(subscriber_id) from subscription where plan_id = 'student')")
    assert await broken(copy) == ["student_subscriptions_start_verified"]


async def test_listening_before_joining_is_found(copy):
    await copy.execute("update subscriber set joined_on = '2026-10-23' where id = "
                       "(select subscriber_id from listening_day order by day limit 1)")
    found = await broken(copy)
    assert "nobody_listens_before_joining" in found


async def test_an_approved_change_without_a_signature_is_found(copy):
    await copy.execute("alter table change disable trigger change_transition")
    change = await copy.fetchval(
        "insert into change (kind, title, created_by, created_at, state) "
        "values ('offer', 'x', 'marketing-1', '2026-10-24 08:42+00', 'approved') returning id")
    await copy.execute(
        "insert into change_version (change_id, version, author, created_at, content, content_hash) "
        "values ($1, 1, 'marketing-1', '2026-10-24 08:42+00', '{}', $2)", change, bytes(32))
    await copy.execute("update change set current_version = 1 where id = $1", change)
    assert await broken(copy) == ["approved_changes_carry_a_signature"]


async def test_a_rewritten_audit_event_is_found_and_so_is_a_rewritten_chain(copy):
    exported = await head(copy)
    assert await broken(copy, anchor=exported) == []
    await copy.execute("alter table audit_event disable trigger audit_event_no_change")
    await copy.execute("update audit_event set reason = 'rewritten' where seq = 1")
    assert await broken(copy) == ["audit_chain_verifies"]


async def test_a_student_offer_for_new_subscribers_reaches_someone_in_every_market(copy):
    # Free listeners who verified and have not subscribed yet: the audience of
    # the Student Autumn Pass (§14.1), counted with the engine's own predicate.
    from commerce.domain.offers import Audience
    from commerce.engine import eligibility

    for market in ("IT", "FR", "DE", "GB"):
        assert await eligibility.count(copy, Audience("never_paid", None, True), market, date(2026, 10, 24)) > 0, market


async def test_a_subscription_that_does_not_pay_its_quote_is_found(copy):
    listener = await copy.fetchval("select subscriber_id from demo_listener where position = 1")
    current = await copy.fetchrow("select id, started_on from subscription where subscriber_id = $1 and ended_on is null", listener)
    await copy.execute(
        "insert into quote (id, created_at, expires_at, market, currency, plan_id, price_minor, list_price_minor, "
        "months_at_price, then_price_minor, subscriber_id, request_id) values ('q_' || repeat('a', 32), "
        "'2026-10-24 08:00+00', '2026-10-24 08:30+00', 'IT', 'EUR', 'student', 579, 579, 0, 579, $1, 'req-00000001')",
        listener)
    await copy.execute("update subscription set ended_on = '2026-10-24' where id = $1", current["id"])
    await add_subscription(copy, listener, "IT", "student", 499, "2026-10-24", billing_day=24, quote_id="q_" + "a" * 32)
    assert await broken(copy) == ["confirmed_subscriptions_pay_their_quote"]


async def test_the_demo_s_listeners_show_what_their_labels_say(copy):
    from commerce.domain.offers import Audience
    from commerce.engine import eligibility

    rows = await copy.fetch("select d.subscriber_id, d.title, d.label, d.student, b.market from demo_listener d "
                            "join subscriber b on b.id = d.subscriber_id order by d.position")
    assert [(r["subscriber_id"], r["title"]) for r in rows] == [
        (5001, "Student in Italy, verified"), (5002, "Student in Italy, not verified yet"),
        (5003, "Student in Italy who paid before"), (5004, "Free listener in France"),
        (5005, "Family subscriber in Germany"), (5006, "Individual subscriber in Italy")]
    assert all(r["label"].startswith("Simulated listener.") for r in rows)
    autumn = Audience("never_paid", None, True)
    day = date(2026, 10, 24)
    inside = [await eligibility.includes(copy, autumn, r["market"], day, r["subscriber_id"]) for r in rows]
    assert inside == [True, False, False, False, False, False]
    never_paid = Audience("never_paid")
    assert await eligibility.includes(copy, never_paid, "IT", day, rows[1]["subscriber_id"])  # verifying would open it
    assert not await eligibility.includes(copy, never_paid, "IT", day, rows[2]["subscriber_id"])  # paid before
    assert [r["student"] for r in rows] == [True, True, True, False, False, False]
    # The two who pay: Family in Germany since 15 June 2025 and Individual in Italy since 8 May 2026, each billed on
    # the day it began, at the list price, the price a rise asks them about (§8.2, §8.3).
    paying = await copy.fetch(
        "select s.subscriber_id, s.plan_id, s.started_on::text as started_on, s.billing_day, h.price_minor from subscription s "
        "join subscription_price h on h.subscription_id = s.id and h.from_on = s.started_on "
        "where s.subscriber_id in (5005, 5006) and s.paid and s.ended_on is null order by s.subscriber_id")
    assert [tuple(r) for r in paying] == [(5005, "family", "2025-06-15", 15, 1899), (5006, "individual", "2026-05-08", 8, 1049)]
