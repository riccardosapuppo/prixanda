"""Markets, VAT rates and plans as the business book states them (§2, §3)."""

from __future__ import annotations

from helpers import sqlstate_of


async def test_four_markets_with_their_currency_and_time_zone(db):
    rows = await db.app.fetch("select code, currency, minor_units, time_zone from market order by code")
    assert [tuple(r) for r in rows] == [
        ("DE", "EUR", 2, "Europe/Berlin"),
        ("FR", "EUR", 2, "Europe/Paris"),
        ("GB", "GBP", 2, "Europe/London"),
        ("IT", "EUR", 2, "Europe/Rome"),
    ]


async def test_standard_vat_rates_in_basis_points_with_their_source(db):
    rows = await db.app.fetch("select market, rate_bp, source from vat_rate where upper_inf(valid) order by market")
    assert {r["market"]: r["rate_bp"] for r in rows} == {"DE": 1900, "FR": 2000, "GB": 2000, "IT": 2200}
    assert all(r["source"] for r in rows)


async def test_two_vat_rates_for_the_same_days_are_refused(db):
    statement = db.owner.execute(
        "insert into vat_rate (market, rate_bp, valid, source) values ('IT', 2000, daterange('2026-11-01', null), 'test')")
    assert await sqlstate_of(statement) == "23P01"


async def test_a_market_in_an_unknown_time_zone_is_refused(db):
    statement = db.owner.execute(
        "insert into market (code, name, currency, minor_units, time_zone) values ('XX', 'Nowhere', 'EUR', 2, 'Europe/Atlantis')")
    assert await sqlstate_of(statement) == "22023"


async def test_plans_and_what_needs_a_student_check(db):
    rows = await db.app.fetch("select id, paid, seats, needs_student_check from plan order by id")
    assert {r["id"]: (r["paid"], r["seats"], r["needs_student_check"]) for r in rows} == {
        "duo": (True, 2, False),
        "family": (True, 5, False),
        "free": (False, 1, False),
        "individual": (True, 1, False),
        "student": (True, 1, True),
    }


async def test_the_engine_cannot_change_reference_data(db):
    assert await sqlstate_of(db.app.execute("update market set time_zone = 'UTC' where code = 'IT'")) == "42501"
    assert await sqlstate_of(db.app.execute("delete from vat_rate")) == "42501"
