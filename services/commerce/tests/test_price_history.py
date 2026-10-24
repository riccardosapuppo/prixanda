"""A subscription's price as a history (migrations V12 and V14, a change made
in two times): a subscription is written with the price it starts at, the
first row of its history, in the same transaction, which the database checks
when the transaction commits; a later price names the price migration that
set it, is charged only while the subscription runs, and is written once.

How V12 filled the history from the old column, and kept the two together
while both lasted, is checked on the migrations of that time by the
compatibility check (src/commerce/compat.py, the compat suite of the check)."""

from __future__ import annotations

from datetime import date

from helpers import T0, add_people, add_subscription, new_change, sqlstate_of

SUBSCRIBER = "insert into subscriber (id, market, joined_on) values ($1, 'DE', '2026-01-10')"
ALONE = ("insert into subscription (id, subscriber_id, market, currency, plan_id, paid, started_on, billing_day) "
         "values ($1, $2, 'DE', 'EUR', 'duo', true, '2026-03-01', 1)")
PRICE = "insert into subscription_price (subscription_id, from_on, price_minor, change_id) values ($1, $2, $3, $4)"


async def test_a_subscription_is_written_with_its_first_price_or_not_at_all(db):
    await db.owner.execute(SUBSCRIBER, 1)
    await db.owner.execute(SUBSCRIBER, 2)
    await add_subscription(db.app, 1, "DE", "free", 0, "2026-01-10", subscription=1, ended="2026-02-01")
    await add_subscription(db.app, 1, "DE", "family", 1899, "2026-02-01", subscription=2)
    rows = await db.app.fetch("select subscription_id, from_on::text as from_on, price_minor, change_id from subscription_price "
                              "order by subscription_id")
    assert [tuple(r.values()) for r in rows] == [(1, "2026-01-10", 0, None), (2, "2026-02-01", 1899, None)]
    # Without its first price the transaction is refused when it commits, by the engine's role and by the owner.
    assert await sqlstate_of(db.app.execute(ALONE, 3, 2)) == "RL010"
    assert await sqlstate_of(db.owner.execute(ALONE, 3, 2)) == "RL010"

    async def priced_from_another_day():
        async with db.app.transaction():
            await db.app.execute(ALONE, 3, 2)
            await db.app.execute(PRICE, 3, date(2026, 3, 2), 1499, None)

    assert await sqlstate_of(priced_from_another_day()) == "RL010"
    assert await db.app.fetchval("select count(*) from subscription where id = 3") == 0
    # The old column is gone (V14): the price is the history's alone.
    assert await sqlstate_of(db.app.execute("select price_minor from subscription")) == "42703"


async def test_a_later_price_names_its_migration_and_is_charged_while_the_subscription_runs(db):
    await add_people(db.owner)
    migration = await new_change(db.app, kind="price_migration", author="commercial-lead-1",
                                 content={"title": "Family price, Germany", "market": "DE"})
    await db.owner.execute(SUBSCRIBER, 1)
    await add_subscription(db.owner, 1, "DE", "free", 0, "2026-01-10", subscription=1, ended="2026-02-01")
    await add_subscription(db.owner, 1, "DE", "family", 1899, "2026-02-01", subscription=2)
    assert await sqlstate_of(db.app.execute(PRICE, 2, T0.date(), 2099, None)) == "RL010"  # names no migration
    assert await sqlstate_of(db.app.execute(PRICE, 2, T0.date().replace(month=1), 2099, migration)) == "RL010"  # before it runs
    assert await sqlstate_of(db.app.execute(PRICE, 2, T0.date(), 0, migration)) == "RL010"  # a paid plan costs something
    assert await sqlstate_of(db.app.execute(PRICE, 1, T0.date().replace(month=1, day=20), 100, migration)) == "RL010"  # free
    assert await sqlstate_of(db.app.execute(PRICE, 1, T0.date().replace(month=2, day=15), 0, migration)) == "RL010"  # ended
    await db.app.execute(PRICE, 2, T0.date(), 2099, migration)
    assert await sqlstate_of(db.owner.execute("update subscription_price set price_minor = 1999 where from_on = $1",
                                              T0.date())) == "RL005"
    assert await sqlstate_of(db.app.execute("delete from subscription_price")) == "42501"
