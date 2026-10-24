"""Properties of the arithmetic a quote is made of, over many generated
cases (business book §3.4, §3.5, §5, §6.1, §6.6): the one rounding rule,
where a price goes, the floor, a percentage off, the simulation's identities,
and local times."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
from fractions import Fraction

from hypothesis import given, settings
from hypothesis import strategies as st

from commerce.domain.economics import Campaign, MarketTerms, break_even_retention, simulate
from commerce.domain.localtime import classify, to_instant, to_local
from commerce.domain.money import Money, round_half_up
from commerce.domain.offers import OfferPrice
from commerce.domain.validation import resolve_price

terms = st.builds(MarketTerms, currency=st.just("EUR"), vat_bp=st.integers(0, 3_000), minimum=st.integers(0, 2_000),
                  pool_share_bp=st.integers(1, 10_000), payment_fee_bp=st.integers(0, 1_000))
prices = st.integers(1, 200_000)


@given(st.integers(-10**12, 10**12), st.integers(1, 10**6))
def test_division_lands_on_the_nearest_integer_with_ties_away_from_zero(numerator, denominator):
    rounded = round_half_up(numerator, denominator)
    exact = Fraction(numerator, denominator)
    assert abs(exact - rounded) <= Fraction(1, 2)
    if abs(exact - rounded) == Fraction(1, 2):
        assert abs(rounded) > abs(exact)
    assert round_half_up(-numerator, denominator) == -rounded


@given(terms, prices)
def test_every_cent_of_a_price_goes_somewhere(t, price):
    b = t.breakdown(price)
    assert b.price == b.vat + b.net and 0 <= b.net <= b.price
    assert b.net == b.artists + b.payment_costs + b.keeps
    assert b.artists == max(b.pool, t.minimum) and b.top_up == b.artists - b.pool >= 0


@given(terms, prices)
def test_the_floor_is_exactly_where_the_top_up_stops(t, price):
    assert (t.top_up(t.net(price)) == 0) == (price >= t.floor())


@given(terms, prices, prices)
def test_a_higher_price_never_nets_less(t, a, b):
    low, high = sorted((a, b))
    assert t.net(low) <= t.net(high) and t.pool(t.net(low)) <= t.pool(t.net(high))


@given(prices, st.integers(1, 9_999))
def test_a_percentage_off_is_the_list_price_less_that_share_rounded_once(list_price, percent):
    offered = resolve_price(OfferPrice("IT", None, percent), Money(list_price, "EUR"))
    assert 0 <= offered.amount <= list_price
    assert abs(Fraction(list_price * (10_000 - percent), 10_000) - offered.amount) <= Fraction(1, 2)


campaigns = st.builds(
    lambda t, list_price, offer, d, extra, eligible, u, i, r: Campaign(t, list_price, min(offer, list_price), d, d + extra,
                                                                       eligible, u, i, r),
    terms, st.integers(100, 3_000), st.integers(1, 3_000), st.integers(1, 6), st.integers(0, 24),
    st.integers(0, 200_000), st.integers(0, 10_000), st.integers(0, 10_000), st.integers(0, 10_000))


@given(campaigns)
def test_the_simulation_s_identities_hold(c):
    r = simulate(c)
    assert 0 <= r.stayers <= r.takers and 0 <= r.cannibalized <= r.takers
    assert r.contribution == r.difference.revenue - r.difference.artists - r.difference.payment_costs
    assert r.contribution == r.with_offer.contribution - r.without_offer.contribution
    assert r.discount_cost == r.cannibalized * c.months_at_offer * (r.net_list - r.net_offer)
    if c.incremental_bp == 10_000:
        assert r.cannibalized == 0 and r.without_offer.revenue == 0


@settings(max_examples=60)
@given(campaigns)
def test_the_break_even_retention_is_the_first_that_does_not_lose_money(c):
    expected = next((r for r in range(0, 10_001) if simulate(replace(c, retention_bp=r)).contribution >= 0), None)
    assert break_even_retention(c) == expected


zones = st.sampled_from(["Europe/Rome", "Europe/Paris", "Europe/Berlin", "Europe/London"])
# Every minute of 2026 and 2027, the night of 25 October 2026 included.
minutes = st.integers(0, 2 * 365 * 24 * 60).map(lambda n: datetime(2026, 1, 1) + timedelta(minutes=n))


@given(zones, minutes)
def test_a_local_time_has_one_instant_or_is_refused(zone, local):
    if classify(local, zone) == "single":
        assert to_local(to_instant(local, zone), zone) == local
    else:
        assert local.month in (3, 10) and local.weekday() == 6  # the last Sunday of March or of October
