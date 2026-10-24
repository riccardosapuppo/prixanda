"""The invariants of a quote (business book §4.5, §5, §6.1, §6.2), on many
generated requests against a real PostgreSQL with offers published: whatever
is asked, a quote is in the market's currency, at the list price in force or
below it with an offer, with every cent of it accounted for, saved exactly as
answered, and the same when asked again with the same key; and a refusal
saves nothing."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from commerce.domain.economics import Book
from commerce.domain.localtime import format_instant
from commerce.engine.errors import InvalidArgument
from commerce.v1 import changes_pb2, common_pb2, quotes_pb2
from engine_support import FINANCE, MARKETING, PUBLIC, new_key, nordflur, scheduled, student_autumn

NOW = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
CURRENCY = {"IT": "EUR", "FR": "EUR", "DE": "EUR", "GB": "GBP"}
BOOK = Book()
SUBSCRIBERS = [0, 101, 102, 103, 104, 105, 106, 201, 202, 203, 204, 301, 401]


async def publish_offers(world) -> dict[str, int]:
    """Three offers live on 10 November: two in Italy, one in Germany."""
    if hasattr(world, "offers"):
        return world.offers
    autumn = await scheduled(world, student_autumn(), MARKETING, FINANCE)
    percent = await scheduled(world, student_autumn(
        title="Individual, a fifth off", plan="individual", non_combinability_group="individual-offers",
        audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_NEVER_PAID),
        prices=[changes_pb2.OfferPrice(market="IT", percent_off_bp=2_000)]), MARKETING, FINANCE)
    release = await scheduled(world, nordflur(), MARKETING, FINANCE)
    world.clock.at = datetime(2026, 11, 5, 23, 0, tzinfo=UTC)
    outcomes = await world.engine.activate_due()
    assert sorted(o.action for o in outcomes) == ["activated"] * 3
    world.clock.at = NOW
    world.offers = {"autumn": autumn.id, "percent": percent.id, "release": release.id}
    return world.offers


requests = st.fixed_dictionaries({
    "market": st.sampled_from(["IT", "FR", "DE", "GB"]),
    "plan": st.sampled_from(["individual", "duo", "family", "student"]),
    "offer": st.sampled_from([None, "autumn", "percent", "release"]),
    "subscriber": st.sampled_from(SUBSCRIBERS),
})


@settings(max_examples=60, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(asked=requests)
async def test_whatever_is_asked_a_quote_keeps_its_invariants(world, asked):
    offers = await publish_offers(world)
    offer_id = offers[asked["offer"]] if asked["offer"] else 0
    request = quotes_pb2.GetQuoteRequest(plan=asked["plan"], market=asked["market"], offer_id=offer_id,
                                         subscriber_id=asked["subscriber"])
    key = new_key()
    rows_before = await world.owner.fetchval("select count(*) from quote")
    try:
        response = await world.call("GetQuote", request, PUBLIC, key=key)
    except InvalidArgument:
        # The only malformed request this strategy can make: an offer for another plan.
        plan = await world.owner.fetchval("select content->>'plan' from change_version where change_id = $1", offer_id)
        assert offer_id and plan != asked["plan"]
        return

    if response.WhichOneof("outcome") == "refusal":
        code = response.refusal.code
        assert code in (common_pb2.REFUSAL_CODE_NOT_ELIGIBLE, common_pb2.REFUSAL_CODE_QUOTE_EXPIRED)
        if code == common_pb2.REFUSAL_CODE_QUOTE_EXPIRED:
            assert offer_id  # only an offer can be off sale
        else:
            assert asked["subscriber"]  # without a person, eligibility waits for the subscription
        assert await world.owner.fetchval("select count(*) from quote") == rows_before
        return

    q = response.quote
    currency = CURRENCY[asked["market"]]
    money = [q.price, q.list_price, q.then_price, q.breakdown.price, q.breakdown.vat, q.breakdown.net,
             q.breakdown.artists, q.breakdown.top_up, q.breakdown.payment_costs, q.breakdown.encore_keeps]
    assert {m.currency for m in money} == {currency}
    in_force = await world.owner.fetchval(
        "select p.amount_minor from list_price p join market m on m.code = p.market "
        "where p.plan_id = $1 and p.market = $2 and p.valid @> ($3::timestamptz at time zone m.time_zone)",
        asked["plan"], asked["market"], NOW)
    assert q.list_price.amount_minor == in_force
    if q.offer_id:
        assert q.offer_id == offer_id and 0 < q.price.amount_minor < q.list_price.amount_minor and q.months_at_price > 0
    else:
        assert not offer_id and q.price == q.list_price and q.months_at_price == 0
    b = q.breakdown
    assert b.price == q.price and b.price.amount_minor == b.vat.amount_minor + b.net.amount_minor
    assert b.net.amount_minor == b.artists.amount_minor + b.payment_costs.amount_minor + b.encore_keeps.amount_minor
    assert b.artists.amount_minor >= BOOK.minimum[currency]
    assert q.expires_at == format_instant(NOW + timedelta(seconds=BOOK.quote_validity_seconds))
    row = await world.owner.fetchrow("select price_minor, list_price_minor, months_at_price, then_price_minor, market, "
                                     "plan_id, coalesce(offer_change_id, 0) as offer from quote where id = $1", q.quote_id)
    assert tuple(row) == (q.price.amount_minor, q.list_price.amount_minor, q.months_at_price, q.then_price.amount_minor,
                          asked["market"], asked["plan"], q.offer_id)
    again = await world.call("GetQuote", request, PUBLIC, key=key)
    assert again == response
