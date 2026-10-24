"""ListMarkets, ListPlans, GetPriceList and ListOffers (business book §2 to
§6.2): what is sold, at what price, and where each price goes."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from commerce.engine.errors import InvalidArgument, NotFound
from commerce.v1 import catalog_pb2, changes_pb2, common_pb2
from engine_support import FINANCE, LEAD, MARKETING, PUBLIC, family_rise, scheduled, student_autumn


async def test_the_markets_with_their_vat_minimum_and_floor(world):
    markets = {m.code: m for m in (await world.call("ListMarkets", catalog_pb2.ListMarketsRequest(), PUBLIC)).markets}
    assert sorted(markets) == ["DE", "FR", "GB", "IT"]
    it, gb = markets["IT"], markets["GB"]
    assert (it.currency, it.minor_units, it.time_zone, it.vat_bp) == ("EUR", 2, "Europe/Rome", 2200)
    assert (it.artists_minimum.amount_minor, it.floor.amount_minor) == (300, 610)
    assert (gb.currency, gb.artists_minimum.amount_minor, gb.floor.amount_minor) == ("GBP", 260, 519)


async def test_the_plans_of_a_market_with_what_they_include_and_where_the_price_goes(world):
    plans = (await world.call("ListPlans", catalog_pb2.ListPlansRequest(market="IT"), PUBLIC)).plans
    assert [p.id for p in plans] == ["free", "individual", "duo", "family", "student"]
    free, student = plans[0], plans[-1]
    assert not free.paid and not free.HasField("list_price") and free.entitlements.skips_per_hour == 6
    assert free.entitlements.audio == "standard" and not free.entitlements.offline
    assert student.list_price.amount_minor == 579 and student.entitlements.needs_student_check
    b = student.breakdown
    assert (b.vat.amount_minor, b.net.amount_minor, b.artists.amount_minor, b.top_up.amount_minor) == (104, 475, 300, 15)
    assert b.price.amount_minor == b.vat.amount_minor + b.artists.amount_minor + b.payment_costs.amount_minor \
        + b.encore_keeps.amount_minor


async def test_plans_before_the_price_list_began_are_not_on_sale(world):
    plans = (await world.call("ListPlans", catalog_pb2.ListPlansRequest(market="DE", at="2024-06-01T00:00:00Z"), PUBLIC)).plans
    assert list(plans) == []


@pytest.mark.parametrize(("request_", "error"), [
    (catalog_pb2.ListPlansRequest(), InvalidArgument), (catalog_pb2.ListPlansRequest(market="it"), InvalidArgument),
    (catalog_pb2.ListPlansRequest(market="ES"), NotFound),
    (catalog_pb2.ListPlansRequest(market="IT", at="tomorrow"), InvalidArgument),
])
async def test_plan_errors(world, request_, error):
    with pytest.raises(error):
        await world.call("ListPlans", request_, PUBLIC)


async def test_the_price_list_shows_the_standing_exception_and_its_cost(world):
    entries = (await world.call("GetPriceList", catalog_pb2.GetPriceListRequest(market="IT"), PUBLIC)).entries
    assert len(entries) == 4
    student = next(e for e in entries if e.plan == "student")
    assert student.below_floor and student.top_up.amount_minor == 15 and student.change_id == 0
    assert student.valid_from_local == "2025-01-01T00:00" and student.valid_until_local == ""
    assert all(not e.below_floor for e in entries if e.plan != "student")
    everything = (await world.call("GetPriceList", catalog_pb2.GetPriceListRequest(), FINANCE)).entries
    assert len(everything) == 16


async def test_the_price_list_keeps_its_history(world):
    change = await scheduled(world, family_rise(), LEAD, FINANCE)
    world.clock.at = datetime(2026, 11, 30, 22, 59, 30, tzinfo=UTC)
    await world.engine.activate_due()
    entries = (await world.call("GetPriceList", catalog_pb2.GetPriceListRequest(market="DE", plan="family"), PUBLIC)).entries
    assert [(e.amount.amount_minor, e.valid_from_local, e.valid_until_local, e.change_id) for e in entries] == [
        (1899, "2025-01-01T00:00", "2026-12-01T00:00", 0), (2099, "2026-12-01T00:00", "", change.id)]


async def test_price_list_filters_that_name_nothing(world):
    with pytest.raises(NotFound):
        await world.call("GetPriceList", catalog_pb2.GetPriceListRequest(plan="platinum"), PUBLIC)
    with pytest.raises(NotFound):
        await world.call("GetPriceList", catalog_pb2.GetPriceListRequest(market="ES"), PUBLIC)


async def test_no_offer_before_anything_is_published(world):
    assert list((await world.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT"), PUBLIC)).offers) == []
    with pytest.raises(InvalidArgument):
        await world.call("ListOffers", catalog_pb2.ListOffersRequest(), PUBLIC)


async def test_the_struck_through_price_is_the_list_price_in_force_that_day(world):
    content = student_autumn(plan="individual", audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_NEVER_PAID),
                             prices=[changes_pb2.OfferPrice(market="IT", percent_off_bp=2_000)])
    await scheduled(world, content, MARKETING, LEAD)
    world.clock.at = datetime(2026, 10, 26, 7, 59, 30, tzinfo=UTC)
    await world.engine.activate_due()
    [offer] = (await world.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT", at="2026-10-27T10:00:00Z"),
                                PUBLIC)).offers
    assert (offer.price.amount_minor, offer.list_price.amount_minor) == (839, 1_049)
    # The list price rises from 1 November: the struck-through price and 20% off it follow.
    await world.owner.execute("update list_price set valid = tsrange(lower(valid), '2026-11-01') "
                              "where plan_id = 'individual' and market = 'IT'")
    await world.owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                              "values ('individual', 'IT', 'EUR', 1149, tsrange('2026-11-01', null))")
    [later] = (await world.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT", at="2026-11-02T10:00:00Z"),
                                PUBLIC)).offers
    assert (later.price.amount_minor, later.list_price.amount_minor) == (919, 1_149)
    assert later.list_price.currency == later.price.currency == "EUR"
