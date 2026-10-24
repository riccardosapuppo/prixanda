"""A subscription's price as a history (migration V12, the expanding half of
a change in two times): every subscription has the price it started at as the
first row of its history, copied by the migration for the rows before it and
by a trigger for the rows written since, by an engine of either version; a
later price names the price migration that set it, is charged only while the
subscription runs, and is written once."""

from __future__ import annotations

from helpers import T0, add_people, new_change, sqlstate_of

SUBSCRIBER = "insert into subscriber (id, market, joined_on) values ($1, 'DE', '2026-01-10')"
SUBSCRIPTION = ("insert into subscription (id, subscriber_id, market, currency, plan_id, paid, price_minor, started_on, "
                "ended_on, billing_day) values ($1, $2, 'DE', 'EUR', $3, $4, $5, $6::text::date, $7::text::date, 10)")
PRICE = "insert into subscription_price (subscription_id, from_on, price_minor, change_id) values ($1, $2, $3, $4)"


async def test_a_subscription_written_with_its_price_gets_the_first_row_of_its_history(db):
    await db.owner.execute(SUBSCRIBER, 1)
    await db.owner.execute(SUBSCRIPTION, 1, 1, "free", False, 0, "2026-01-10", "2026-02-01")
    await db.owner.execute(SUBSCRIPTION, 2, 1, "family", True, 1899, "2026-02-01", None)
    rows = await db.app.fetch("select subscription_id, from_on::text as from_on, price_minor, change_id from subscription_price "
                              "order by subscription_id")
    assert [tuple(r.values()) for r in rows] == [(1, "2026-01-10", 0, None), (2, "2026-02-01", 1899, None)]


async def test_a_later_price_names_its_migration_and_is_charged_while_the_subscription_runs(db):
    await add_people(db.owner)
    migration = await new_change(db.app, kind="price_migration", author="commercial-lead-1",
                                 content={"title": "Family price, Germany", "market": "DE"})
    await db.owner.execute(SUBSCRIBER, 1)
    await db.owner.execute(SUBSCRIPTION, 1, 1, "free", False, 0, "2026-01-10", "2026-02-01")
    await db.owner.execute(SUBSCRIPTION, 2, 1, "family", True, 1899, "2026-02-01", None)
    assert await sqlstate_of(db.app.execute(PRICE, 2, T0.date(), 2099, None)) == "RL010"  # names no migration
    assert await sqlstate_of(db.app.execute(PRICE, 2, T0.date().replace(month=1), 2099, migration)) == "RL010"  # before it runs
    assert await sqlstate_of(db.app.execute(PRICE, 2, T0.date(), 0, migration)) == "RL010"  # a paid plan costs something
    assert await sqlstate_of(db.app.execute(PRICE, 1, T0.date().replace(month=1, day=20), 100, migration)) == "RL010"  # free
    assert await sqlstate_of(db.app.execute(PRICE, 1, T0.date().replace(month=2, day=15), 0, migration)) == "RL010"  # ended
    await db.app.execute(PRICE, 2, T0.date(), 2099, migration)
    assert await sqlstate_of(db.owner.execute("update subscription_price set price_minor = 1999 where from_on = $1",
                                              T0.date())) == "RL005"
    assert await sqlstate_of(db.app.execute("delete from subscription_price")) == "42501"
