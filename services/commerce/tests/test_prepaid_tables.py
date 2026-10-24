"""The tables of prepaid passes (migration V15): a code keeps what was sold,
moves forward once (pending to ready or failed, ready to activated or
expired) and is never deleted; a payment and a receipt are for a
subscription from a quote or for a code, never both; a pass's subscription
costs nothing by the month, and every other paid one costs something."""

from __future__ import annotations

from helpers import T0, add_people, add_subscription, new_change, sqlstate_of

CODE = ("insert into prepaid_code (code, change_id, version, market, currency, plan_id, months, price_minor, net_minor, "
        "buyer_id, sold_at, valid_until, request_id) values ($1, $2, 1, 'IT', 'EUR', 'individual', 3, 2999, 2458, 1, $3, "
        "'2027-10-23', 'site-buy-00000001') returning id")
PAYMENT = ("insert into payment (id, quote_id, subscription_id, prepaid_code, subscriber_id, amount_minor, currency, provider, "
           "requested_at, request_id) values ($1, $2, $3, $4, 1, 2999, 'EUR', 'simulated', $5, 'site-buy-00000001')")


async def world(db) -> int:
    await add_people(db.owner)
    change = await new_change(db.app, kind="prepaid", author="commercial-lead-1",
                              content={"title": "Three-month gift pass", "market": "IT"})
    await db.owner.execute("insert into subscriber (id, market, joined_on) values (1, 'IT', '2026-01-10')")
    await db.owner.execute("insert into subscriber (id, market, joined_on) values (2, 'IT', '2026-01-10')")
    return change


async def test_a_code_keeps_what_was_sold_and_moves_forward_once(db):
    change = await world(db)
    await db.app.execute(CODE, "K7QM-3XTP-9WAD", change, T0)
    assert await sqlstate_of(db.app.execute(CODE, "K7QM-3XTP-9WA0", change, T0)) == "23514"  # a 0 is never written
    assert await sqlstate_of(db.app.execute("update prepaid_code set price_minor = 1999")) == "42501"
    assert await sqlstate_of(db.owner.execute("update prepaid_code set valid_until = '2028-01-01'")) == "RL012"
    assert await sqlstate_of(db.app.execute("update prepaid_code set state = 'expired', expired_at = now()")) == "RL012"
    await db.app.execute("update prepaid_code set state = 'ready'")
    assert await sqlstate_of(db.app.execute("update prepaid_code set state = 'failed'")) == "RL012"
    assert await sqlstate_of(db.app.execute("update prepaid_code set state = 'activated'")) == "23514"  # by whom, when, into what
    await db.app.execute("update prepaid_code set state = 'expired', expired_at = now()")
    assert await sqlstate_of(db.app.execute("update prepaid_code set state = 'ready', expired_at = null")) == "RL012"
    assert await sqlstate_of(db.app.execute("delete from prepaid_code")) == "42501"
    assert await sqlstate_of(db.owner.execute("delete from prepaid_code")) == "RL012"


async def test_a_payment_and_its_receipt_are_for_one_thing(db):
    change = await world(db)
    await db.app.execute(CODE, "K7QM-3XTP-9WAD", change, T0)
    assert await sqlstate_of(db.app.execute(PAYMENT, "p_" + "1" * 32, None, None, None, T0)) == "23514"  # for nothing
    await db.app.execute(PAYMENT, "p_" + "2" * 32, None, None, "K7QM-3XTP-9WAD", T0)
    assert await sqlstate_of(db.app.execute(PAYMENT, "p_" + "3" * 32, None, None, "K7QM-3XTP-9WAD", T0)) == "23505"  # once
    assert await sqlstate_of(db.app.execute("update payment set prepaid_code = null")) == "42501"
    assert await sqlstate_of(db.owner.execute("update payment set amount_minor = 1")) == "RL009"
    receipt = ("insert into receipt (id, subscription_id, quote_id, prepaid_code, subscriber_id, amount_minor, currency, "
               "issued_at, provider, provider_reference, note) values ($1, $2, null, $3, 1, 2999, 'EUR', $4, 'simulated', "
               "'sim-pay-0123456789abcdef', 'Demonstration receipt.')")
    subscription = await add_subscription(db.owner, 2, "IT", "free", 0, "2026-01-10")
    assert await sqlstate_of(db.app.execute(receipt, "r_" + "1" * 32, subscription, "K7QM-3XTP-9WAD", T0)) == "23514"
    await db.app.execute(receipt, "r_" + "2" * 32, None, "K7QM-3XTP-9WAD", T0)


async def test_a_pass_subscription_costs_nothing_by_the_month_and_no_other_paid_one_does(db):
    change = await world(db)
    await db.app.execute(CODE, "K7QM-3XTP-9WAD", change, T0)

    async def subscription(number: int, subscriber: int, code: str | None, price: int):
        async with db.app.transaction():
            await db.app.execute(
                "insert into subscription (id, subscriber_id, market, currency, plan_id, paid, started_on, ended_on, "
                "billing_day, prepaid_code) values ($1, $2, 'IT', 'EUR', 'individual', true, '2026-11-02', '2027-02-02', 2, $3)",
                number, subscriber, code)
            await db.app.execute("insert into subscription_price (subscription_id, from_on, price_minor) "
                                 "values ($1, '2026-11-02', $2)", number, price)

    assert await sqlstate_of(subscription(10, 1, "K7QM-3XTP-9WAD", 999)) == "RL010"  # a pass is never charged by the month
    assert await sqlstate_of(subscription(11, 2, None, 0)) == "RL010"  # any other paid subscription costs something
    await subscription(12, 1, "K7QM-3XTP-9WAD", 0)
    assert await sqlstate_of(subscription(13, 2, "K7QM-3XTP-9WAD", 0)) == "23505"  # one subscription per code
