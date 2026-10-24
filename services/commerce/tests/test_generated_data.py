"""The generator gives the same data for the same seed, and every invariant
holds on it and fires when its rule is broken (a check that cannot fail
checks nothing)."""

from __future__ import annotations

import uuid
from datetime import date

import asyncpg
import pytest
import pytest_asyncio

from commerce.audit import head
from commerce.generate import fingerprint, generate
from commerce.invariants import check
from conftest import ADMIN_URL, TEMPLATE, on_database


async def admin(statement: str) -> None:
    conn = await asyncpg.connect(ADMIN_URL)
    try:
        await conn.execute(statement)
    finally:
        await conn.close()


async def fresh_database() -> str:
    name = f"gen_{uuid.uuid4().hex[:16]}"
    await admin(f"create database {name} template {TEMPLATE}")
    return name


@pytest_asyncio.fixture(scope="session")
async def generated():
    """The small size, seed 7, generated once; tests clone it."""
    name = await fresh_database()
    summary = await generate(on_database(ADMIN_URL, name), "small", 7, date(2025, 1, 1), date(2026, 10, 24))
    yield name, summary
    await admin(f"drop database {name} with (force)")


@pytest_asyncio.fixture
async def copy(generated):
    source, _ = generated
    name = f"copy_{uuid.uuid4().hex[:16]}"
    await admin(f"create database {name} template {source}")
    conn = await asyncpg.connect(on_database(ADMIN_URL, name))
    try:
        yield conn
    finally:
        await conn.close()
        await admin(f"drop database {name} with (force)")


async def test_the_small_size_has_what_it_declares(generated):
    _, summary = generated
    counts = summary["counts"]
    assert counts["subscribers"] == 5_000 + 4  # the generated people and the demo's four listeners
    assert counts["demo_listeners"] == 4
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
    assert report["checked"] == 10
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
    assert await broken(copy) == ["every_subscriber_is_on_one_plan_every_day"]


async def test_a_subscription_at_the_wrong_price_is_found(copy):
    await copy.execute("update subscription set price_minor = price_minor - 100 where id = (select min(id) from subscription where paid)")
    assert await broken(copy) == ["paid_subscriptions_start_at_the_list_price"]


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
    await copy.execute(
        "insert into subscription (id, subscriber_id, market, currency, plan_id, paid, price_minor, started_on, billing_day, "
        "quote_id) values (nextval('subscription_id_seq'), $1, 'IT', 'EUR', 'student', true, 499, '2026-10-24', 24, "
        "'q_' || repeat('a', 32))", listener)
    assert await broken(copy) == ["confirmed_subscriptions_pay_their_quote"]


async def test_the_demo_s_listeners_show_what_their_labels_say(copy):
    from commerce.domain.offers import Audience
    from commerce.engine import eligibility

    rows = await copy.fetch("select d.subscriber_id, d.title, d.label, d.student, b.market from demo_listener d "
                            "join subscriber b on b.id = d.subscriber_id order by d.position")
    assert [r["title"] for r in rows] == ["Student in Italy, verified", "Student in Italy, not verified yet",
                                          "Student in Italy who paid before", "Free listener in France"]
    assert all(r["label"].startswith("Simulated listener.") for r in rows)
    autumn = Audience("never_paid", None, True)
    day = date(2026, 10, 24)
    inside = [await eligibility.includes(copy, autumn, r["market"], day, r["subscriber_id"]) for r in rows]
    assert inside == [True, False, False, False]
    never_paid = Audience("never_paid")
    assert await eligibility.includes(copy, never_paid, "IT", day, rows[1]["subscriber_id"])  # verifying would open it
    assert not await eligibility.includes(copy, never_paid, "IT", day, rows[2]["subscriber_id"])  # paid before
    assert [r["student"] for r in rows] == [True, True, True, False]
