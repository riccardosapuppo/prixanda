"""The price list (business book §4): one price per paid plan, market and
period of local time, never edited once in force."""

from __future__ import annotations

from datetime import UTC, datetime

from helpers import sqlstate_of

INSERT = ("insert into list_price (plan_id, market, currency, amount_minor, valid) "
          "values ($1, $2, $3, $4, tsrange($5::text::timestamp, $6::text::timestamp)) returning id")


async def price(conn, plan="individual", market="IT", amount=1049, start="2026-11-01 00:00", end=None, currency=None):
    currency = currency or ("GBP" if market == "GB" else "EUR")
    return await conn.fetchval(INSERT, plan, market, currency, amount, start, end)


async def test_two_prices_for_the_same_plan_and_market_cannot_overlap(db):
    await price(db.app, start="2026-11-01 00:00")
    assert await sqlstate_of(price(db.app, amount=1099, start="2026-12-01 00:00")) == "23P01"


async def test_periods_that_touch_do_not_overlap(db):
    await price(db.app, start="2026-01-01 00:00", end="2026-11-01 00:00")
    assert await price(db.app, amount=1099, start="2026-11-01 00:00")


async def test_the_same_period_is_fine_for_another_market_or_plan(db):
    await price(db.app, start="2026-11-01 00:00")
    assert await price(db.app, market="FR", amount=1099, start="2026-11-01 00:00")
    assert await price(db.app, plan="duo", amount=1449, start="2026-11-01 00:00")


async def test_the_free_plan_has_no_price(db):
    assert await sqlstate_of(price(db.app, plan="free", amount=1)) == "23503"


async def test_a_price_is_in_the_currency_of_its_market(db):
    assert await sqlstate_of(price(db.app, market="GB", currency="EUR", amount=949)) == "23503"


async def test_a_price_is_more_than_zero(db):
    assert await sqlstate_of(price(db.app, amount=0)) == "23514"


async def test_a_price_in_force_is_never_edited(db):
    price_id = await price(db.owner, start="2026-11-01 00:00")
    assert await sqlstate_of(db.owner.execute("update list_price set amount_minor = 999 where id = $1", price_id)) == "RL001"
    assert await sqlstate_of(db.owner.execute(
        "update list_price set valid = tsrange('2026-10-01', null) where id = $1", price_id)) == "RL001"
    assert await sqlstate_of(db.owner.execute("delete from list_price where id = $1", price_id)) == "RL001"


async def test_an_open_period_can_be_closed_once(db):
    price_id = await price(db.app, start="2026-11-01 00:00")
    await db.app.execute("update list_price set valid = tsrange(lower(valid), '2027-01-01') where id = $1", price_id)
    assert await sqlstate_of(db.app.execute(
        "update list_price set valid = tsrange(lower(valid), '2027-02-01') where id = $1", price_id)) == "RL001"
    assert await sqlstate_of(db.app.execute(
        "update list_price set valid = tsrange(lower(valid), null) where id = $1", price_id)) == "RL001"


async def test_the_engine_can_add_and_close_prices_but_not_delete_or_reprice(db):
    price_id = await price(db.app, start="2026-11-01 00:00")
    assert await sqlstate_of(db.app.execute("delete from list_price where id = $1", price_id)) == "42501"
    assert await sqlstate_of(db.app.execute("update list_price set amount_minor = 1 where id = $1", price_id)) == "42501"


async def test_an_instant_is_read_in_the_local_time_of_the_market(db):
    # A price from 09:00 in Italy on Monday 26 October 2026, the day after the
    # clocks go back: 09:00 in Rome is then 08:00 UTC, not 07:00.
    await price(db.app, start="2026-10-26 09:00")
    in_force = """select count(*) from list_price p join market m on m.code = p.market
                  where p.plan_id = 'individual' and p.market = 'IT' and p.valid @> ($1::timestamptz at time zone m.time_zone)"""
    assert await db.app.fetchval(in_force, datetime(2026, 10, 26, 7, 59, tzinfo=UTC)) == 0
    assert await db.app.fetchval(in_force, datetime(2026, 10, 26, 8, 0, tzinfo=UTC)) == 1
