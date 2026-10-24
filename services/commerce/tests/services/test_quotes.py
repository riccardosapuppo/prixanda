"""GetQuote (business book §4.5): the engine's price, saved with its expiry,
refused for an offer that is not on sale and for a person outside its
audience."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from commerce.engine.errors import InvalidArgument, NotFound
from commerce.v1 import catalog_pb2, changes_pb2, common_pb2, quotes_pb2, subscriptions_pb2
from engine_support import (
    FINANCE, LEAD, MARKETING, ON_CALL, PUBLIC, nordflur, past_validation_by_hand, scheduled, student_autumn,
)

REFUSAL = common_pb2.RefusalCode


def at(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


async def quote(world, **fields):
    return await world.call("GetQuote", quotes_pb2.GetQuoteRequest(**fields), PUBLIC)


async def live_offer(world, content=None, start=at(2026, 10, 26, 8, 0)) -> int:
    change = await scheduled(world, content or student_autumn(), MARKETING, FINANCE)
    world.clock.at = start
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated"
    return change.id


async def test_a_list_price_quote_is_saved_with_its_expiry(world):
    q = (await quote(world, plan="individual", market="GB")).quote
    assert (q.price.amount_minor, q.price.currency, q.months_at_price, q.offer_id) == (949, "GBP", 0, 0)
    assert q.then_price == q.price == q.list_price
    assert q.expires_at == "2026-10-24T09:12:00Z"
    b = q.breakdown
    assert (b.vat.amount_minor, b.net.amount_minor, b.artists.amount_minor, b.payment_costs.amount_minor) == (158, 791, 475, 17)
    row = await world.owner.fetchrow("select price_minor, request_id, expires_at - created_at as validity from quote where id = $1",
                                     q.quote_id)
    assert row["price_minor"] == 949 and row["request_id"].startswith("req-") and row["validity"].seconds == 1_800


async def test_an_offer_quote_says_from_when_the_full_price_applies(world):
    offer = await live_offer(world)
    q = (await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=101)).quote
    assert (q.price.amount_minor, q.months_at_price, q.then_price.amount_minor, q.offer_id) == (299, 3, 579, offer)
    snapshot = await world.owner.fetchval("select snapshot_id from quote where id = $1", q.quote_id)
    assert snapshot == await world.owner.fetchval("select max(id) from catalog_snapshot")


async def test_the_price_after_the_offer_is_the_list_price_in_force_then(world):
    offer = await live_offer(world)
    # A Student price rise already in the price list for January 2027.
    await world.owner.execute("update list_price set valid = tsrange(lower(valid), '2027-01-01') "
                              "where plan_id = 'student' and market = 'IT'")
    await world.owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                              "values ('student', 'IT', 'EUR', 599, tsrange('2027-01-01', null))")
    q = (await quote(world, plan="student", market="IT", offer_id=offer)).quote
    assert (q.price.amount_minor, q.list_price.amount_minor, q.then_price.amount_minor) == (299, 579, 599)


async def test_a_percentage_off_follows_the_list_price_in_force(world):
    content = nordflur(prices=[changes_pb2.OfferPrice(market="DE", percent_off_bp=5_000)])
    offer = await live_offer(world, content, start=at(2026, 11, 5, 23, 0))
    q = (await quote(world, plan="individual", market="DE", offer_id=offer, subscriber_id=201)).quote
    assert (q.price.amount_minor, q.list_price.amount_minor) == (550, 1_099)  # 549.5 rounds half up


@pytest.mark.parametrize(("subscriber", "why"), [(102, "not verified"), (104, "paid before"), (105, "verification over")])
async def test_a_person_outside_the_audience_is_not_quoted_the_offer(world, subscriber, why):
    offer = await live_offer(world)
    response = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=subscriber)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE, why
    assert await world.owner.fetchval("select count(*) from quote") == 0


async def test_listening_decides_the_release_campaign(world):
    offer = await live_offer(world, nordflur(), start=at(2026, 11, 5, 23, 0))
    assert (await quote(world, plan="individual", market="DE", offer_id=offer, subscriber_id=201)).quote.price.amount_minor == 199
    for subscriber in (202, 204, 203):  # two hours; hours outside the 30 days; a Family subscriber
        response = await quote(world, plan="individual", market="DE", offer_id=offer, subscriber_id=subscriber)
        assert response.refusal.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE, subscriber


async def test_a_subscriber_of_another_market_or_without_a_student_check(world):
    response = await quote(world, plan="individual", market="IT", subscriber_id=301)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE and response.refusal.facts["market"] == "GB"
    student = await quote(world, plan="student", market="IT", subscriber_id=102)
    assert student.refusal.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE
    assert (await quote(world, plan="student", market="IT", subscriber_id=101)).quote.price.amount_minor == 579


async def test_an_offer_not_on_sale_is_refused(world):
    change = await scheduled(world, student_autumn(), MARKETING, FINANCE)
    early = await quote(world, plan="student", market="IT", offer_id=change.id)
    assert early.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED  # scheduled, not yet published
    world.clock.at = at(2026, 10, 26, 7, 59, 30)
    await world.engine.activate_due()
    not_yet = await quote(world, plan="student", market="IT", offer_id=change.id)
    assert not_yet.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED  # published, starts at 08:00 UTC
    world.clock.at = at(2026, 11, 29, 23, 0)
    over = await quote(world, plan="student", market="IT", offer_id=change.id)
    assert over.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED  # the period ended at midnight in Rome
    elsewhere = await quote(world, plan="student", market="FR", offer_id=change.id)
    assert elsewhere.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED


async def test_a_suspended_offer_is_no_longer_quoted(world):
    offer = await live_offer(world)
    await world.call("SuspendChange", changes_pb2.SuspendChangeRequest(change_id=offer, reason="Wrong page."), ON_CALL)
    response = await quote(world, plan="student", market="IT", offer_id=offer)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED


async def test_quote_errors(world):
    offer = await live_offer(world)
    with pytest.raises(NotFound):
        await quote(world, plan="student", market="IT", offer_id=9_999)
    with pytest.raises(InvalidArgument):
        await quote(world, plan="individual", market="IT", offer_id=offer)  # the offer sells Student
    with pytest.raises(InvalidArgument):
        await quote(world, plan="free", market="IT")
    with pytest.raises(InvalidArgument):
        await quote(world, plan="student")
    with pytest.raises(InvalidArgument):
        await quote(world, plan="student", market="Italy")
    with pytest.raises(NotFound):
        await quote(world, plan="student", market="ES")
    with pytest.raises(NotFound):
        await quote(world, plan="platinum", market="IT")
    with pytest.raises(NotFound):
        await quote(world, plan="student", market="IT", subscriber_id=4_242)
    assert await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="duo", market="DE"), LEAD)


async def test_an_offer_that_comes_to_nothing_is_not_on_sale(world):
    # 99.99% off 5,79 € is 0,00 €. Validation blocks such a version; this one got past it by hand, and went live.
    change = await past_validation_by_hand(world, student_autumn(
        prices=[changes_pb2.OfferPrice(market="IT", percent_off_bp=9_999)]), MARKETING)
    await world.owner.execute("update change set state = 'scheduled' where id = $1", change.id)
    world.clock.at = datetime(2026, 10, 26, 7, 59, 30, tzinfo=UTC)
    await world.engine.run_launches()
    assert await world.owner.fetchval("select state from change where id = $1", change.id) == "active"
    world.clock.at = datetime(2026, 10, 26, 8, 0, tzinfo=UTC)
    assert list((await world.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT"), PUBLIC)).offers) == []
    refused = await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="student", market="IT", offer_id=change.id), PUBLIC)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED and "€0.00" in refused.refusal.reason


async def test_the_price_after_the_offer_is_the_one_the_account_will_charge(world):
    # The pass taken on 31 October: charged that day, then on the 28th of each month (a start late in the month bills
    # on the 28th), so after its three months the list price begins on 28 January 2027, read as that day begins. A new
    # Student price from 30 January does not concern it, though 31 January, three calendar months on, would.
    change = await scheduled(world, student_autumn(), MARKETING, FINANCE)
    world.clock.at = at(2026, 10, 26, 7, 59, 30)
    await world.engine.run_launches()
    await world.owner.execute("update list_price set valid = tsrange(lower(valid), '2027-01-30') "
                              "where plan_id = 'student' and market = 'IT'")
    await world.owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                              "values ('student', 'IT', 'EUR', 629, tsrange('2027-01-30', null))")
    world.clock.at = at(2026, 10, 31, 9, 0)  # 10:00 in Rome
    q = (await quote(world, plan="student", market="IT", offer_id=change.id, subscriber_id=101)).quote
    assert (q.months_at_price, q.then_price.amount_minor) == (3, 579)
    await world.call("ConfirmQuote", subscriptions_pb2.ConfirmQuoteRequest(quote_id=q.quote_id, subscriber_id=101), PUBLIC)
    s = (await world.call("GetAccount", subscriptions_pb2.GetAccountRequest(subscriber_id=101), PUBLIC)).account.subscription
    assert (s.full_price_from, s.full_price) == ("2027-01-28", q.then_price)


async def test_a_refusal_names_the_market_as_it_is_written_and_keeps_the_listener_s_number_in_its_facts(world):
    change = await scheduled(world, student_autumn(), MARKETING, FINANCE)
    world.clock.at = at(2026, 10, 26, 7, 59, 30)
    await world.engine.run_launches()
    world.clock.at = at(2026, 10, 26, 8, 0)
    outside = (await quote(world, plan="student", market="IT", offer_id=change.id, subscriber_id=104)).refusal  # has paid
    assert outside.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE
    assert outside.reason == "This listener is not among verified students in Italy who have never had a paid plan."
    assert outside.facts["subscriber"] == "104"
    elsewhere = (await quote(world, plan="individual", market="IT", subscriber_id=401)).refusal  # in France
    assert elsewhere.reason == "This listener is in France, and the quote is for Italy."
    assert (elsewhere.facts["subscriber"], elsewhere.facts["market"]) == ("401", "FR")
