"""What the database holds on its own about launches, the outbox and payments
(migration V11): a step that is done is never done again, and the publish step
is done only with its change active; a launch moves only as the job moves it;
an incident is open once per launch and stays as it closed; an outbox message
is delivered once and keeps what it says; a notice of the site or an event of
the payment provider only counts its arrivals; a payment settles once; and a
snapshot prepared with an offer being launched goes live only once the offer
is active."""

from __future__ import annotations

import json

from helpers import T0, add_people, approve, move, new_change, sqlstate_of

LAUNCH = ("insert into launch (change_id, version, kind, starts_market, starts_local, starts_at, due_at, started_at) "
          "values ($1, 1, 'offer', 'IT', '2026-10-26 09:00', '2026-10-26 08:00+00', '2026-10-26 07:59+00', $2) returning id")
STEPS = ("insert into launch_step (launch_id, position, name) values ($1, 1, 'check'), ($1, 2, 'prepare'), "
         "($1, 3, 'publish'), ($1, 4, 'notify'), ($1, 5, 'verify')")
START = "update launch_step set state = 'running', started_at = $3, attempts = attempts + 1 where launch_id = $1 and name = $2"
DONE = "update launch_step set state = 'done', finished_at = $3, error = null where launch_id = $1 and name = $2"


async def scheduled_offer(db) -> int:
    await add_people(db.owner)
    change = await new_change(db.app)
    await move(db.app, change, "validated", "in_approval")
    await approve(db.app, change, "finance-1", "finance")
    await move(db.app, change, "approved", "scheduled")
    return change


async def launch_of(db, change: int) -> int:
    launch = await db.app.fetchval(LAUNCH, change, T0)
    await db.app.execute(STEPS, launch)
    return launch


async def done(db, launch: int, *names: str) -> None:
    for name in names:
        await db.app.execute(START, launch, name, T0)
        await db.app.execute(DONE, launch, name, T0)


async def test_a_step_that_is_done_is_never_done_again(db):
    launch = await launch_of(db, await scheduled_offer(db))
    await done(db, launch, "check")
    assert await sqlstate_of(db.app.execute(START, launch, "check", T0)) == "RL008"
    assert await sqlstate_of(db.owner.execute("update launch_step set facts = '{}' where name = 'check'")) == "RL008"
    await db.app.execute(START, launch, "prepare", T0)
    back = "update launch_step set state = 'pending', started_at = null, attempts = 0 where name = 'prepare'"
    assert await sqlstate_of(db.app.execute(back)) == "RL008"
    assert await sqlstate_of(db.owner.execute("delete from launch_step")) == "RL008"


async def test_the_publish_step_is_done_only_with_its_change_active(db):
    change = await scheduled_offer(db)
    launch = await launch_of(db, change)
    await done(db, launch, "check", "prepare")
    await db.app.execute(START, launch, "publish", T0)
    assert await sqlstate_of(db.app.execute(DONE, launch, "publish", T0)) == "RL008"
    await move(db.app, change, "active")
    await db.app.execute(DONE, launch, "publish", T0)


async def test_a_launch_moves_only_as_the_job_moves_it(db):
    change = await scheduled_offer(db)
    launch = await launch_of(db, change)
    stop = "update launch set state = $2, finished_at = $3 where id = $1"
    assert await sqlstate_of(db.app.execute(stop, launch, "done", T0)) == "RL008"  # its steps are not done
    await db.app.execute(stop, launch, "failed", T0)
    assert await sqlstate_of(db.app.execute(stop, launch, "done", T0)) == "RL008"  # a failed launch runs again first
    await db.app.execute("update launch set state = 'running', finished_at = null where id = $1", launch)
    assert await sqlstate_of(db.owner.execute("update launch set version = 2")) == "RL008"
    await done(db, launch, "check", "prepare")
    await move(db.app, change, "active")
    await done(db, launch, "publish")
    assert await sqlstate_of(db.app.execute(stop, launch, "cancelled", T0)) == "RL008"  # it published
    await done(db, launch, "notify", "verify")
    await db.app.execute(stop, launch, "done", T0)
    assert await sqlstate_of(db.app.execute("update launch set state = 'running', finished_at = null")) == "RL008"
    assert await sqlstate_of(db.app.execute("delete from launch")) == "42501"
    assert await sqlstate_of(db.owner.execute("delete from launch")) == "RL008"


async def test_a_launch_has_one_open_incident_and_a_closed_one_stays_as_it_closed(db):
    launch = await launch_of(db, await scheduled_offer(db))
    incident = "insert into incident (launch_id, kind, summary, opened_at) values ($1, 'late', 'Not live at 09:05.', $2) returning id"
    first = await db.app.fetchval(incident, launch, T0)
    assert await sqlstate_of(db.app.execute(incident, launch, T0)) == "23505"
    close = "update incident set state = $2, closed_at = $3, closed_by = $4, resolution = 'Published at 09:06.' where id = $1"
    assert await sqlstate_of(db.app.execute(close, first, "recovered", T0, "on-call-1")) == "23514"  # recovered: nobody acted
    await db.app.execute(close, first, "resolved", T0, "on-call-1")
    assert await sqlstate_of(db.app.execute("update incident set state = 'open', closed_at = null, closed_by = null, "
                                            "resolution = null")) == "RL008"
    assert await sqlstate_of(db.owner.execute("update incident set summary = 'Something else.'")) == "RL008"
    await db.app.fetchval(incident, launch, T0)  # closed, so another may open


async def test_an_outbox_message_is_delivered_once_and_keeps_what_it_says(db):
    message = await db.app.fetchval(
        "insert into outbox_message (topic, key, payload, created_at, request_id, available_at) "
        "values ('catalog.published', 'publication:1', '{\"snapshot\": 1}', $1, 'launch-1', $1) returning id", T0)
    deliver = "update outbox_message set delivered_at = $2, attempts = attempts + 1 where id = $1"
    await db.app.execute(deliver, message, T0)
    assert await sqlstate_of(db.app.execute(deliver, message, T0.replace(hour=10))) == "RL009"
    assert await sqlstate_of(db.owner.execute("update outbox_message set payload = '{\"snapshot\": 2}'")) == "RL009"
    assert await sqlstate_of(db.owner.execute("update outbox_message set attempts = 0")) == "RL009"
    assert await sqlstate_of(db.app.execute("delete from outbox_message")) == "42501"
    assert await sqlstate_of(db.owner.execute("delete from outbox_message")) == "RL009"
    again = ("insert into outbox_message (topic, key, payload, created_at, request_id, available_at) "
             "values ('catalog.published', 'publication:1', '{}', $1, 'launch-2', $1)")
    assert await sqlstate_of(db.app.execute(again, T0)) == "23505"  # one message per publication


async def payment(db) -> str:
    """A subscription of listener 401 in France confirmed from a quote, and its payment, pending."""
    await add_people(db.owner)
    await db.owner.execute("insert into subscriber (id, market, joined_on) values (401, 'FR', '2026-01-10')")
    await db.owner.execute("insert into quote (id, created_at, expires_at, market, currency, plan_id, price_minor, list_price_minor, "
                           "months_at_price, then_price_minor, subscriber_id, request_id) values ($1, $2, $3, 'FR', 'EUR', "
                           "'individual', 1099, 1099, 0, 1099, 401, 'req-00000001')", "q_" + "a" * 32, T0,
                           T0.replace(hour=9))
    await db.owner.execute("insert into subscription (id, subscriber_id, market, currency, plan_id, paid, price_minor, started_on, "
                           "billing_day, quote_id) values (7, 401, 'FR', 'EUR', 'individual', true, 1099, '2026-10-24', 24, $1)",
                           "q_" + "a" * 32)
    await db.app.execute("insert into payment (id, quote_id, subscription_id, subscriber_id, amount_minor, currency, provider, "
                         "requested_at, request_id) values ($1, $2, 7, 401, 1099, 'EUR', 'simulated', $3, 'req-00000001')",
                         "p_" + "b" * 32, "q_" + "a" * 32, T0)
    return "p_" + "b" * 32


async def test_a_payment_settles_once_and_keeps_what_was_asked_for(db):
    paid = await payment(db)
    assert await sqlstate_of(db.app.execute("update payment set state = 'succeeded' where id = $1", paid)) == "23514"
    settle = "update payment set state = $2, settled_at = $3, provider_reference = 'sim-pay-1', failure_reason = $4 where id = $1"
    await db.app.execute(settle, paid, "succeeded", T0, None)
    assert await sqlstate_of(db.app.execute(settle, paid, "failed", T0, "Declined.")) == "RL009"
    assert await sqlstate_of(db.owner.execute("update payment set amount_minor = 1")) == "RL009"
    assert await sqlstate_of(db.app.execute("delete from payment")) == "42501"


async def test_an_event_of_the_provider_only_counts_its_arrivals(db):
    paid = await payment(db)
    await db.app.execute("insert into payment_event (provider, event_id, payment_id, type, occurred_at, received_at, applied) "
                         "values ('simulated', 'evt_000000000001', $1, 'charge.succeeded', $2, $2, true)", paid, T0)
    await db.app.execute("update payment_event set arrivals = arrivals + 1")
    assert await db.app.fetchval("select arrivals from payment_event") == 2
    assert await sqlstate_of(db.app.execute("update payment_event set arrivals = 1")) == "RL009"
    assert await sqlstate_of(db.owner.execute("update payment_event set applied = false")) == "RL009"
    assert await sqlstate_of(db.owner.execute("delete from payment_event")) == "RL009"


SNAPSHOT = ("insert into catalog_snapshot (created_at, created_by, request_id, cause) "
            "values ($1, 'activation', 'launch-1', '{}'::jsonb) returning id")
OFFER = """insert into catalog_offer (snapshot_id, change_id, version, market, currency, plan_id, fixed_minor, months,
             starts_local, ends_local, starts_at, ends_at, title, body, terms, treatment, audience, audience_words,
             needs_student_check, group_name, redemption_cap)
           values ($1, $2, 1, 'IT', 'EUR', 'student', 299, 3, '2026-10-26 09:00', '2026-11-30 00:00',
                   '2026-10-26 08:00+00', '2026-11-29 23:00+00', 'Student Autumn Pass', 'Three months.', 'New only.', '',
                   $3::jsonb, 'Verified students in Italy who have never had a paid plan', true, 'student-offers', 0)"""
PUBLISH = ("insert into catalog_publication (snapshot_id, published_at, published_by, request_id) "
           "values ($1, $2, 'activation', 'launch-1')")


async def test_a_snapshot_prepared_with_an_offer_being_launched_goes_live_only_once_it_is_active(db):
    change = await scheduled_offer(db)
    snapshot = await db.app.fetchval(SNAPSHOT, T0)
    await db.app.execute(OFFER, snapshot, change, json.dumps({"segment": "never_paid"}))  # prepared ahead
    assert await sqlstate_of(db.app.execute(PUBLISH, snapshot, T0)) == "RL007"
    await move(db.app, change, "active")
    await db.app.execute(PUBLISH, snapshot, T0)
    site = await db.app.fetchval(
        "insert into outbox_message (topic, key, payload, created_at, request_id, available_at) "
        "values ('catalog.published', 'publication:1', '{}', $1, 'launch-1', $1) returning id", T0)
    seq = await db.app.fetchval("select seq from catalog_publication")
    await db.app.execute("insert into site_notice (message_id, snapshot_id, publication, received_at) values ($1, $2, $3, $4)",
                         site, snapshot, seq, T0)
    await db.app.execute("update site_notice set arrivals = arrivals + 1")
    assert await sqlstate_of(db.app.execute("update site_notice set received_at = $1", T0.replace(hour=11))) == "42501"
    assert await sqlstate_of(db.owner.execute("update site_notice set received_at = $1", T0.replace(hour=11))) == "RL009"
