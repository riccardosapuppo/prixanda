"""ListMarkets, ListPlans, GetPriceList and ListOffers (business book §2 to
§6.2, §6.8): what is sold, at what price, where each price goes, and who is
shown an offer for an artist's listeners; and ListArtists (§14.2), the
artists a campaign for an album release aims at."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from commerce.engine.errors import InvalidArgument, NotFound, PermissionDenied
from commerce.v1 import catalog_pb2, changes_pb2, common_pb2
from engine_support import (
    AUDITOR, CATALOG, FINANCE, LEAD, MARKETING, ON_CALL, PUBLIC, family_rise, nordflur, scheduled, student_autumn,
)


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
    with pytest.raises(InvalidArgument):
        await world.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT", subscriber_id=-1), PUBLIC)


async def listed_to(world, market: str, subscriber: int) -> list:
    request = catalog_pb2.ListOffersRequest(market=market, subscriber_id=subscriber)
    return list((await world.call("ListOffers", request, PUBLIC)).offers)


async def test_an_offer_for_an_artists_listeners_is_listed_only_to_its_audience(world):
    # §14.2 and §6.8: the Nordflur release goes to the Free listeners in Germany with more than 3 hours of
    # Doppelfenster in the last 30 days, and to nobody else; without a listener, nobody is told of it.
    change = await scheduled(world, nordflur(), MARKETING, FINANCE)
    world.clock.at = datetime(2026, 11, 5, 23, 0, tzinfo=UTC)  # midnight in Berlin, 6 November: the window is 7 Oct to 5 Nov
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated"
    [offer] = await listed_to(world, "DE", 201)
    assert (offer.offer_id, offer.price.amount_minor, offer.months_at_offer_price) == (change.id, 199, 2)
    rule = offer.listening
    assert (rule.artist_id, rule.artist_name, rule.min_seconds, rule.within_days) == (4, "Doppelfenster", 10_800, 30)
    assert offer.audience == "Free listeners in Germany, with more than 3 hours of Doppelfenster in the last 30 days"
    # Two hours; five hours before the 30 days; a Family subscriber; a listener of another market; nobody.
    for subscriber in (202, 204, 203, 101, 0):
        assert await listed_to(world, "DE", subscriber) == [], subscriber
    # The window moves with the day: three weeks later, the fan's hours are behind it.
    world.clock.at = datetime(2026, 11, 30, 11, 0, tzinfo=UTC)
    assert await listed_to(world, "DE", 201) == []


async def test_the_other_offers_are_listed_to_everyone(world):
    await scheduled(world, student_autumn(), MARKETING, FINANCE)
    world.clock.at = datetime(2026, 10, 26, 8, 0, tzinfo=UTC)
    await world.engine.activate_due()
    # Nobody; a verified student; one who paid before, outside the audience; a listener of another market.
    for subscriber in (0, 101, 104, 201):
        [offer] = await listed_to(world, "IT", subscriber)
        assert offer.title == "Student Autumn Pass" and not offer.HasField("listening"), subscriber


async def test_the_struck_through_price_is_the_list_price_in_force_that_day(world):
    content = student_autumn(plan="individual", audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_NEVER_PAID),
                             prices=[changes_pb2.OfferPrice(market="IT", percent_off_bp=2_000)])
    await scheduled(world, content, MARKETING, FINANCE)
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


async def test_an_offer_says_where_its_price_goes_with_the_top_up_below_the_floor(world):
    # §14.1: of the Student Autumn Pass's 2,99 € the subscriber's share for the artists is 1,47 €, and the
    # music service adds 1,53 € so that the artists get their 3,00 € minimum.
    await scheduled(world, student_autumn(), MARKETING, FINANCE)
    world.clock.at = datetime(2026, 10, 26, 7, 59, 30, tzinfo=UTC)
    await world.engine.activate_due()
    [offer] = (await world.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT", at="2026-10-26T08:00:00Z"),
                                PUBLIC)).offers
    b = offer.breakdown
    assert (b.price.amount_minor, b.vat.amount_minor, b.net.amount_minor) == (299, 54, 245)
    assert (b.artists.amount_minor, b.top_up.amount_minor, b.artists.amount_minor - b.top_up.amount_minor) == (300, 153, 147)
    assert b.price == offer.price and b.artists.currency == "EUR"
    plans = {p.id: p for p in (await world.call("ListPlans", catalog_pb2.ListPlansRequest(market="IT"), PUBLIC)).plans}
    assert plans["student"].breakdown.price.amount_minor == 579  # the list price's own breakdown, as before


# -- the artists (§14.2) ---------------------------------------------------------

BY_NAME = ["Ciel Fendu", "Corale Ferrovia", "Doppelfenster", "Halde", "Ottoline Marr", "Pinewire", "Velluto Basso"]


async def artists(world, who=MARKETING, **fields) -> catalog_pb2.ListArtistsResponse:
    return await world.call("ListArtists", catalog_pb2.ListArtistsRequest(**fields), who)


async def test_the_artists_by_name_with_their_label_country_and_latest_record(world):
    listed = await artists(world)
    assert [a.name for a in listed.artists] == BY_NAME and listed.page.next == ""
    doppelfenster = listed.artists[2]
    assert (doppelfenster.id, doppelfenster.label, doppelfenster.country) == (4, "Kellerlicht", "DE")
    assert (doppelfenster.latest_release, doppelfenster.latest_release_on) == ("Nordflur", "2026-11-06")
    # The latest record is the newest one; an artist without any has none.
    await world.owner.execute("insert into release (id, artist_id, title, released_on) values (8, 4, 'Kellerband', '2025-03-07')")
    await world.owner.execute("insert into label (id, name, country) values (9, 'Treppenhaus', 'DE')")
    await world.owner.execute("insert into artist (id, name, label_id, country) values (9, 'Zinnober', 9, 'DE')")
    listed = await artists(world)
    assert listed.artists[2].latest_release == "Nordflur"
    assert (listed.artists[-1].name, listed.artists[-1].latest_release, listed.artists[-1].latest_release_on) == ("Zinnober", "", "")


async def test_a_search_finds_a_part_of_the_name_in_any_case_and_ids_name_the_chosen_ones(world):
    assert [a.name for a in (await artists(world, search="DOPPEL")).artists] == ["Doppelfenster"]
    assert [a.name for a in (await artists(world, search=" fe ")).artists] == ["Ciel Fendu", "Corale Ferrovia", "Doppelfenster"]
    assert list((await artists(world, search="Nobody of that name")).artists) == []
    # A saved version names its artist by id: the console asks for that one.
    assert [a.name for a in (await artists(world, ids=[7, 4])).artists] == ["Doppelfenster", "Halde"]
    assert [a.name for a in (await artists(world, ids=[7, 4], search="halde")).artists] == ["Halde"]
    assert list((await artists(world, ids=[999])).artists) == []


async def test_the_artists_a_page_at_a_time_by_name_then_id(world):
    seen, after, pages = [], "", 0
    while True:
        page = await artists(world, page=common_pb2.PageRequest(size=3, after=after))
        seen += [a.name for a in page.artists]
        pages += 1
        if not page.page.next:
            break
        after = page.page.next
    assert seen == BY_NAME and pages == 3
    # Two artists may share a name's start; the page goes on after the last one it gave, whatever comes next.
    searched = await artists(world, search="e", page=common_pb2.PageRequest(size=2))
    rest = await artists(world, search="e", page=common_pb2.PageRequest(size=100, after=searched.page.next))
    assert [a.name for a in [*searched.artists, *rest.artists]] == [n for n in BY_NAME if "e" in n.lower()]


@pytest.mark.parametrize("who", [MARKETING, LEAD, FINANCE])
async def test_whoever_writes_or_signs_an_offer_reads_the_artists(world, who):
    assert len((await artists(world, who)).artists) == 7


@pytest.mark.parametrize("who", [CATALOG, ON_CALL, AUDITOR, PUBLIC])
async def test_the_other_roles_do_not_read_the_artists(world, who):
    with pytest.raises(PermissionDenied):
        await artists(world, who)


@pytest.mark.parametrize("fields", [
    {"search": "x" * 81}, {"ids": list(range(101))}, {"page": common_pb2.PageRequest(size=-1)},
    {"page": common_pb2.PageRequest(after="not-a-cursor")}, {"page": common_pb2.PageRequest(after="WyJIYWxkZSIsICI0Il0")},
])
async def test_artist_errors(world, fields):
    with pytest.raises(InvalidArgument):
        await artists(world, **fields)


async def test_a_page_of_artists_holds_at_most_a_hundred(world):
    for n in range(100, 230):
        await world.owner.execute("insert into artist (id, name, label_id, country) values ($1, $2, 3, 'DE')", n, f"Act {n}")
    page = await artists(world, page=common_pb2.PageRequest(size=500))
    assert len(page.artists) == 100 and page.page.next != ""


async def test_a_statement_takes_plain_values_on_either_database(world):
    """engine/database.py: the browser's PGlite takes plain values only, and the server's adapter refuses what it
    refuses, so that a statement the server's tests pass runs in the browser as well: ListArtists once sent its ids as
    an array, which only the browser refused."""
    async with world.engine.db.transaction(readonly=True) as tx:
        with pytest.raises(TypeError, match="plain values"):
            await tx.fetch("select $1::int[] as ids", [4, 7])
        assert await tx.fetchval("select jsonb_array_length($1::text::jsonb)", json.dumps([4, 7])) == 2
