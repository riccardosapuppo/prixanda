"""The tables of price migrations (migration V13): a market's rules keep the
law apart from the choice and the choice fits the law; a request keeps what
it asked, to whom and until when, is answered once, settled once, and never
deleted; the listener's inbox only counts arrivals."""

from __future__ import annotations

import json

from helpers import T0, add_people, new_change, sqlstate_of

REQUEST = (
    "insert into price_change_request (change_id, subscription_id, subscriber_id, market, plan_id, kind, old_price_minor, "
    "new_price_minor, sent_at, window_ends_local, window_ends_at, request_id) "
    "values ($1, 2, 1, 'DE', 'family', $2, 1899, $3, $4, '2026-12-17 23:59', '2026-12-17 22:59+00', 'launch-1') returning id")


async def world(db) -> int:
    await add_people(db.owner)
    migration = await new_change(db.app, kind="price_migration", author="commercial-lead-1",
                                 content={"title": "Family price, Germany", "market": "DE"})
    await db.owner.execute("insert into subscriber (id, market, joined_on) values (1, 'DE', '2026-01-10')")
    await db.owner.execute("insert into subscription (id, subscriber_id, market, currency, plan_id, paid, price_minor, "
                           "started_on, billing_day) values (2, 1, 'DE', 'EUR', 'family', true, 1899, '2026-02-01', 1)")
    return migration


async def test_each_market_has_its_rules_and_the_choice_fits_the_law(db):
    rows = await db.app.fetch("select market, legal_requirement, window_days, after_window from price_change_policy order by market")
    assert [tuple(r) for r in rows] == [("DE", "consent", 45, "move_to_free"), ("FR", "notice", 30, "new_price"),
                                        ("GB", "notice", 30, "new_price"), ("IT", "notice", 30, "new_price")]
    # Without consent the price never rises; a notice market applies it.
    assert await sqlstate_of(db.owner.execute(
        "update price_change_policy set after_window = 'new_price' where market = 'DE'")) == "23514"
    assert await sqlstate_of(db.owner.execute(
        "update price_change_policy set after_window = 'move_to_free' where market = 'IT'")) == "23514"
    assert await sqlstate_of(db.owner.execute(
        "update price_change_policy set legal_sources = '[]' where market = 'DE'")) == "23514"
    # The engine reads the rules; changing them is not the engine's.
    assert await sqlstate_of(db.app.execute("update price_change_policy set window_days = 60 where market = 'DE'")) == "42501"
    sources = json.loads(await db.app.fetchval("select legal_sources::text from price_change_policy where market = 'DE'"))
    assert any("Kammergericht" in s for s in sources)


async def test_a_request_keeps_what_it_asked_to_whom_and_until_when(db):
    migration = await world(db)
    request = await db.app.fetchval(REQUEST, migration, "consent", 2099, T0)
    assert await sqlstate_of(db.app.execute(REQUEST, migration, "consent", 2099, T0)) == "23505"  # one per subscription
    assert await sqlstate_of(db.app.execute(
        "update price_change_request set new_price_minor = 2199 where id = $1", request)) == "42501"
    assert await sqlstate_of(db.owner.execute(
        "update price_change_request set window_ends_at = window_ends_at + interval '1 day' where id = $1", request)) == "RL011"
    assert await sqlstate_of(db.app.execute("delete from price_change_request")) == "42501"
    assert await sqlstate_of(db.owner.execute("delete from price_change_request")) == "RL011"


async def test_a_request_must_raise_the_price_and_its_window_end_after_it_was_sent(db):
    migration = await world(db)
    assert await sqlstate_of(db.app.execute(REQUEST, migration, "consent", 1899, T0)) == "23514"
    assert await sqlstate_of(db.app.execute(REQUEST, migration, "consent", 2099, T0.replace(year=2027))) == "23514"


async def test_an_answer_is_given_once_and_a_settled_request_stays_as_it_was_settled(db):
    migration = await world(db)
    request = await db.app.fetchval(REQUEST, migration, "consent", 2099, T0)
    # The states follow the answers: accepted is a yes with its date; a notice is never accepted.
    assert await sqlstate_of(db.app.execute(
        "update price_change_request set state = 'accepted', answer = 'yes', answered_at = now() where id = $1", request)) == "23514"
    assert await sqlstate_of(db.app.execute(
        "update price_change_request set state = 'lapsed', answer = 'no', answered_at = now() where id = $1", request)) == "23514"
    assert await sqlstate_of(db.app.execute(
        "update price_change_request set state = 'new_price', new_price_from = '2026-12-01' where id = $1", request)) == "23514"
    await db.app.execute("update price_change_request set state = 'accepted', answer = 'yes', answered_at = now(), "
                         "new_price_from = '2027-01-01' where id = $1", request)
    assert await sqlstate_of(db.app.execute(
        "update price_change_request set answer = 'no' where id = $1", request)) == "RL011"
    assert await sqlstate_of(db.app.execute(
        "update price_change_request set state = 'declined' where id = $1", request)) == "RL011"
    assert await sqlstate_of(db.app.execute(
        "update price_change_request set new_price_from = '2027-02-01' where id = $1", request)) == "RL011"
    await db.app.execute("update price_change_request set settled_at = now() where id = $1", request)
    assert await sqlstate_of(db.app.execute(
        "update price_change_request set settled_at = now() + interval '1 hour' where id = $1", request)) == "RL011"


async def test_the_inbox_only_counts_arrivals(db):
    migration = await world(db)
    request = await db.app.fetchval(REQUEST, migration, "consent", 2099, T0)
    message = await db.app.fetchval(
        "insert into outbox_message (topic, key, payload, created_at, request_id, available_at) "
        "values ('price_change.request', $1, $2, $3, 'launch-1', $3) returning id",
        f"request:{request}", json.dumps({"price_change": request, "subscriber": 1}), T0)
    await db.app.execute("insert into subscriber_notice (message_id, subscriber_id, kind, subject, body, received_at) "
                         "values ($1, 1, 'price_change.request', 'Your price', 'We ask for your consent.', $2)", message, T0)
    await db.app.execute("update subscriber_notice set arrivals = arrivals + 1 where message_id = $1", message)
    assert await sqlstate_of(db.app.execute(
        "update subscriber_notice set body = 'Something else.' where message_id = $1", message)) == "42501"
    assert await sqlstate_of(db.owner.execute(
        "update subscriber_notice set body = 'Something else.' where message_id = $1", message)) == "RL009"
    assert await sqlstate_of(db.app.execute("delete from subscriber_notice")) == "42501"
    assert await db.app.fetchval("select arrivals from subscriber_notice where message_id = $1", message) == 2
