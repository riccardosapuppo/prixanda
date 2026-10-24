"""The tables the engine adds in stage 2, and what the database holds on its
own: validations and submissions belong to the current version and are
written once (V6), an idempotent call records its outcome once (V7), only
an active offer is published and snapshots are kept (V8), a quote is at the
list price or below it with an offer (V9)."""

from __future__ import annotations

import json
from datetime import date

from helpers import T0, add_people, approve, audit, move, new_change, new_version, sqlstate_of

VALIDATION = ("insert into change_validation (change_id, version, validated_at, validated_by, valid, eligible, sentence, report) "
              "values ($1, $2, $3, 'marketing-1', true, 10, 'Italy, Student: ...', '{}'::jsonb)")
SUBMISSION = ("insert into change_submission (change_id, version, submitted_at, submitted_by, author_reason) "
              "values ($1, $2, $3, 'marketing-1', null)")


async def test_a_change_written_without_its_last_move_starts_with_its_creation_time(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    assert await db.app.fetchval("select updated_at = created_at from change where id = $1", change)
    await db.app.execute("update change set updated_at = $2 where id = $1", change, T0.replace(hour=12))
    assert await db.app.fetchval("select extract(hour from updated_at at time zone 'UTC') from change where id = $1", change) == 12


async def test_a_validation_looks_at_the_current_version_of_a_draft(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    await db.app.execute(VALIDATION, change, 1, T0)
    await new_version(db.app, change, author="marketing-1", content={"title": "v2"})
    assert await sqlstate_of(db.app.execute(VALIDATION, change, 1, T0)) == "RL005"
    await move(db.app, change, "validated")
    assert await sqlstate_of(db.app.execute(VALIDATION, change, 2, T0)) == "RL005"


async def test_a_submission_sends_the_current_version_of_a_validated_change(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    assert await sqlstate_of(db.app.execute(SUBMISSION, change, 1, T0)) == "RL005"
    await move(db.app, change, "validated")
    await db.app.execute(SUBMISSION, change, 1, T0)
    assert await db.app.fetchval("select count(*) from change_submission where change_id = $1", change) == 1


async def test_validations_and_submissions_are_written_once(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    await db.app.execute(VALIDATION, change, 1, T0)
    await move(db.app, change, "validated")
    await db.app.execute(SUBMISSION, change, 1, T0)
    for table in ("change_validation", "change_submission"):
        assert await sqlstate_of(db.owner.execute(f"update {table} set change_id = change_id")) == "RL005"
        assert await sqlstate_of(db.owner.execute(f"delete from {table}")) == "RL005"
        assert await sqlstate_of(db.owner.execute(f"truncate {table} cascade")) == "RL005"
        assert await sqlstate_of(db.app.execute(f"delete from {table}")) == "42501"


CLAIM = ("insert into idempotent_call (scope, key, method, request_hash, started_at, request_id) "
         "values ($1, $2, 'commerce.v1.ChangeService/CreateChange', $3, $4, 'req-00000001')")


async def test_an_idempotency_key_has_the_gateway_s_shape(db):
    await db.app.execute(CLAIM, "marketing-1", "7f3a9c1e-2b44-4f0e-9d1a-6c5b8e2f0a11", bytes(32), T0)
    for key in ("short", "-starts-with-a-dash", "has a space in it", "x" * 101):
        assert await sqlstate_of(db.app.execute(CLAIM, "marketing-1", key, bytes(32), T0)) == "23514", key
    assert await sqlstate_of(db.app.execute(CLAIM, "Not-A-Person", "key-00000001", bytes(32), T0)) == "23514"
    await db.app.execute(CLAIM, "(public)", "key-00000001", bytes(32), T0)


async def test_an_idempotent_call_records_its_outcome_once_and_keeps_its_request(db):
    await db.app.execute(CLAIM, "finance-1", "key-00000001", bytes(32), T0)
    complete = ("update idempotent_call set response = $1, outcome = 'answer', completed_at = $2 "
                "where scope = 'finance-1' and key = 'key-00000001'")
    await db.app.execute(complete, b"\x0a\x00", T0)
    assert await sqlstate_of(db.app.execute(complete, b"\x0a\x01", T0)) == "RL006"
    assert await sqlstate_of(db.owner.execute("update idempotent_call set request_hash = $1", b"\x01" * 32)) == "RL006"


async def test_only_the_key_of_a_finished_call_is_pruned(db):
    await db.app.execute(CLAIM, "finance-1", "key-00000001", bytes(32), T0)
    await db.app.execute(CLAIM, "finance-1", "key-00000002", bytes(32), T0)
    await db.app.execute("update idempotent_call set response = $1, outcome = 'answer', completed_at = $2 "
                         "where key = 'key-00000001'", b"\x0a\x00", T0)
    running = "delete from idempotent_call where key = 'key-00000002'"
    assert await sqlstate_of(db.app.execute(running)) == "RL006"
    assert await sqlstate_of(db.owner.execute(running)) == "RL006"
    await db.app.execute("delete from idempotent_call where key = 'key-00000001'")
    assert await db.app.fetchval("select array_agg(key) from idempotent_call") == ["key-00000002"]


async def test_an_outcome_comes_whole(db):
    await db.app.execute(CLAIM, "finance-1", "key-00000002", bytes(32), T0)
    half = "update idempotent_call set response = $1 where key = 'key-00000002'"
    assert await sqlstate_of(db.app.execute(half, b"\x0a")) == "23514"


async def active_offer(db) -> int:
    await add_people(db.owner)
    change = await new_change(db.app)
    await move(db.app, change, "validated", "in_approval")
    await approve(db.app, change, "finance-1", "finance")
    await move(db.app, change, "approved", "scheduled", "active")
    return change


SNAPSHOT = ("insert into catalog_snapshot (created_at, created_by, request_id, cause) "
            "values ($1, 'activation', 'req-00000001', '{}'::jsonb) returning id")
OFFER = """insert into catalog_offer (snapshot_id, change_id, version, market, currency, plan_id, fixed_minor, months,
             starts_local, ends_local, starts_at, ends_at, title, body, terms, treatment, audience, audience_words,
             needs_student_check, group_name, redemption_cap)
           values ($1, $2, $3, 'IT', 'EUR', 'student', 299, 3, '2026-10-26 09:00', '2026-11-30 00:00',
                   '2026-10-26 08:00+00', '2026-11-29 23:00+00', 'Student Autumn Pass', 'Three months.', 'New only.', '',
                   $4::jsonb, 'Verified students in Italy who have never had a paid plan', true, 'student-offers', 0)"""


async def test_only_the_current_version_of_an_active_offer_is_published(db):
    change = await active_offer(db)
    snapshot = await db.app.fetchval(SNAPSHOT, T0)
    audience = json.dumps({"segment": "never_paid"})
    await db.app.execute(OFFER, snapshot, change, 1, audience)
    draft = await new_change(db.app)
    assert await sqlstate_of(db.app.execute(OFFER, snapshot, draft, 1, audience)) == "RL007"
    await move(db.app, change, "suspended", reason="The publish step failed twice.")
    other = await db.app.fetchval(SNAPSHOT, T0)
    assert await sqlstate_of(db.app.execute(OFFER, other, change, 1, audience)) == "RL007"


async def test_snapshots_and_publications_are_kept_as_written(db):
    change = await active_offer(db)
    snapshot = await db.app.fetchval(SNAPSHOT, T0)
    await db.app.execute(OFFER, snapshot, change, 1, json.dumps({}))
    await db.app.execute("insert into catalog_publication (snapshot_id, published_at, published_by, request_id) "
                         "values ($1, $2, 'activation', 'req-00000001')", snapshot, T0)
    for table in ("catalog_offer", "catalog_publication", "catalog_snapshot"):
        assert await sqlstate_of(db.owner.execute(f"update {table} set request_id = request_id"
                                                  if table != "catalog_offer" else "update catalog_offer set months = 4")) == "RL005"
        assert await sqlstate_of(db.owner.execute(f"delete from {table}")) == "RL005"
        assert await sqlstate_of(db.app.execute(f"delete from {table}")) == "42501"


QUOTE = """insert into quote (id, created_at, expires_at, market, currency, plan_id, price_minor, list_price_minor,
             months_at_price, then_price_minor, offer_change_id, offer_version, snapshot_id, subscriber_id, request_id)
           values ($1, $2, $3, 'IT', 'EUR', 'student', $4, 579, $5, 579, $6, $7, $8, null, 'req-00000001')"""


async def test_a_quote_is_at_the_list_price_or_below_it_with_an_offer(db):
    change = await active_offer(db)
    snapshot = await db.app.fetchval(SNAPSHOT, T0)
    later = T0.replace(hour=9)
    await db.app.execute(QUOTE, "q_" + "0" * 32, T0, later, 579, 0, None, None, None)
    await db.app.execute(QUOTE, "q_" + "1" * 32, T0, later, 299, 3, change, 1, snapshot)
    assert await sqlstate_of(db.app.execute(QUOTE, "q_" + "2" * 32, T0, later, 299, 0, None, None, None)) == "23514"
    assert await sqlstate_of(db.app.execute(QUOTE, "q_" + "3" * 32, T0, later, 579, 3, change, 1, snapshot)) == "23514"
    assert await sqlstate_of(db.app.execute(QUOTE, "q_" + "4" * 32, T0, T0, 579, 0, None, None, None)) == "23514"
    assert await sqlstate_of(db.app.execute(QUOTE, "not-a-quote-id", T0, later, 579, 0, None, None, None)) == "23514"
    assert await sqlstate_of(db.owner.execute("update quote set price_minor = 1")) == "RL005"
    assert await sqlstate_of(db.app.execute("delete from quote")) == "42501"


# V10: the subscriber's side.

async def test_a_subscriber_is_an_author_of_the_audit_log_and_nobody_else_new_is(db):
    await audit(db.app, "student.verified", actor="subscriber-101", role="subscriber", subject="subscriber:101")
    assert await sqlstate_of(audit(db.app, actor="someone", role="visitor")) == "23514"


async def a_listener_with_a_quote(db, price: int = 299) -> str:
    await db.owner.execute("insert into subscriber (id, market, joined_on) values (1, 'IT', '2026-01-10')")
    quote_id = "q_" + "b" * 32
    await db.app.execute(QUOTE, quote_id, T0, T0.replace(hour=9), price, 0, None, None, None)
    return quote_id


SUBSCRIPTION = ("insert into subscription (id, subscriber_id, market, currency, plan_id, paid, price_minor, started_on, "
                "billing_day, quote_id, offer_change_id, offer_months) "
                "values (nextval('subscription_id_seq'), 1, 'IT', 'EUR', 'student', true, $1, $2, 26, $3, $4, $5) returning id")


async def test_engine_subscriptions_are_numbered_above_the_generated_ones_and_a_quote_is_confirmed_once(db):
    quote_id = await a_listener_with_a_quote(db, price=579)
    first = await db.app.fetchval(SUBSCRIPTION, 579, date(2026, 10, 26), quote_id, None, None)
    assert first >= 1_000_000_000
    await db.app.execute("update subscription set ended_on = '2027-01-26' where id = $1", first)
    assert await sqlstate_of(db.app.fetchval(SUBSCRIPTION, 579, date(2027, 1, 26), quote_id, None, None)) == "23505"


async def test_an_offer_on_a_subscription_comes_with_its_months_and_its_quote(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    quote_id = await a_listener_with_a_quote(db, price=579)
    assert await sqlstate_of(db.app.fetchval(SUBSCRIPTION, 299, date(2026, 10, 26), quote_id, change, None)) == "23514"
    assert await sqlstate_of(db.app.fetchval(SUBSCRIPTION, 299, date(2026, 10, 26), None, change, 3)) == "23514"
    assert await sqlstate_of(db.app.fetchval(SUBSCRIPTION, 299, date(2026, 10, 26), quote_id, change, 37)) == "23514"


RECEIPT = ("insert into receipt (id, subscription_id, quote_id, subscriber_id, amount_minor, currency, issued_at, provider, "
           "provider_reference, demonstration, note) values ($1, $2, $3, 1, 579, 'EUR', $4, $5, 'sim-pay-0123456789abcdef', "
           "$6, 'Demonstration receipt.')")


async def test_a_receipt_is_a_demonstration_of_the_simulated_provider_written_once(db):
    quote_id = await a_listener_with_a_quote(db, price=579)
    subscription = await db.app.fetchval(SUBSCRIPTION, 579, date(2026, 10, 26), quote_id, None, None)
    assert await sqlstate_of(db.app.execute(RECEIPT, "r_" + "1" * 32, subscription, quote_id, T0, "simulated", False)) == "23514"
    assert await sqlstate_of(db.app.execute(RECEIPT, "r_" + "2" * 32, subscription, quote_id, T0, "a-real-bank", True)) == "23514"
    await db.app.execute(RECEIPT, "r_" + "3" * 32, subscription, quote_id, T0, "simulated", True)
    assert await sqlstate_of(db.owner.execute("update receipt set amount_minor = 1")) == "RL005"
    assert await sqlstate_of(db.app.execute("delete from receipt")) == "42501"


async def test_a_demo_listener_is_labelled_as_simulated_and_only_the_owner_writes_them(db):
    await db.owner.execute("insert into subscriber (id, market, joined_on) values (1, 'IT', '2026-01-10')")
    statement = "insert into demo_listener (subscriber_id, position, title, label, student) values (1, 1, 'A student', $1, true)"
    assert await sqlstate_of(db.owner.execute(statement, "A student in Italy.")) == "23514"
    await db.owner.execute(statement, "Simulated listener. A student in Italy.")
    assert await sqlstate_of(db.app.execute("update demo_listener set student = false")) == "42501"


async def test_a_verification_reference_has_the_provider_s_shape(db):
    await db.owner.execute("insert into subscriber (id, market, joined_on) values (1, 'IT', '2026-01-10')")
    statement = ("insert into student_verification (subscriber_id, verified_on, valid_until, provider, reference) "
                 "values (1, $1, $2, 'simulated', $3)")
    assert await sqlstate_of(db.app.execute(statement, date(2026, 10, 24), date(2027, 10, 24), "anything")) == "23514"
    await db.app.execute(statement, date(2026, 10, 24), date(2027, 10, 24), "sim-student-0123456789abcdef")
