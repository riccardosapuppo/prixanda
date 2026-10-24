"""Where a price goes, the floor, the simulation of a campaign and who signs
(business book §5, §6.6, §7.3), beyond the golden cases."""

from __future__ import annotations

from dataclasses import replace

import pytest

from commerce.domain.economics import (
    Book, Campaign, ExchangeRate, break_even_retention, finance_conditions, recognize_monthly, signatures_needed,
    simulate,
)
from commerce.domain.money import BASIS_POINTS, Money

BOOK = Book()
MARKETS = {"IT": ("EUR", 2200), "FR": ("EUR", 2000), "DE": ("EUR", 1900), "GB": ("GBP", 2000)}


def student_autumn(**changes) -> Campaign:
    base = Campaign(BOOK.terms("EUR", 2200), 579, 299, 3, 12, 10_000, 1_200, 6_000, 5_500)
    return replace(base, **changes)


def brute_force_break_even(campaign: Campaign) -> int | None:
    for retention in range(BASIS_POINTS + 1):
        if simulate(replace(campaign, retention_bp=retention)).contribution >= 0:
            return retention
    return None


@pytest.mark.parametrize("market", MARKETS)
def test_a_price_splits_into_vat_artists_payment_and_what_is_kept(market):
    terms = BOOK.terms(*MARKETS[market])
    for price in (199, 579, 610, 949, 1099, 2099):
        b = terms.breakdown(price)
        assert b.price == b.vat + b.net
        assert b.net == b.artists + b.payment_costs + b.keeps
        assert b.artists == b.pool + b.top_up == max(b.pool, terms.minimum)


@pytest.mark.parametrize("market", MARKETS)
def test_the_floor_is_the_first_price_whose_pool_covers_the_minimum(market):
    terms = BOOK.terms(*MARKETS[market])
    floor = terms.floor()
    assert terms.top_up(terms.net(floor)) == 0
    assert terms.top_up(terms.net(floor - 1)) > 0


def test_the_minimum_is_per_currency_and_must_exist():
    assert BOOK.terms("GBP", 2000).minimum == 260
    with pytest.raises(ValueError):
        BOOK.terms("JPY", 1000)


def test_terms_refuse_shares_outside_zero_and_one_hundred_percent():
    with pytest.raises(ValueError):
        replace(BOOK.terms("EUR", 2200), vat_bp=-1)
    with pytest.raises(ValueError):
        replace(BOOK.terms("EUR", 2200), pool_share_bp=10_001)


def test_a_prepaid_pass_is_recognized_in_equal_parts_the_last_taking_the_remainder():
    assert recognize_monthly(2_458, 3) == [819, 819, 820]
    assert recognize_monthly(2_457, 3) == [819, 819, 819]
    assert sum(recognize_monthly(1_001, 12)) == 1_001
    with pytest.raises(ValueError):
        recognize_monthly(100, 0)


def test_the_declared_rate_converts_pounds_and_leaves_euros_alone():
    rate = BOOK.exchange_rate
    assert rate.to_base(Money(949, "GBP")) == Money(1_133, "EUR")
    assert rate.to_base(Money(-949, "GBP")) == Money(-1_133, "EUR")
    assert rate.to_base(Money(1_049, "EUR")) == Money(1_049, "EUR")
    with pytest.raises(ValueError):
        rate.to_base(Money(1_000, "JPY"))
    assert ExchangeRate("EUR", "GBP", 85_000, 100_000, "test").note() == "1 EUR = 0.85 GBP (test)"


def test_the_simulation_adds_up():
    r = simulate(student_autumn())
    assert r.contribution == r.difference.revenue - r.difference.artists - r.difference.payment_costs
    assert r.contribution == r.with_offer.contribution - r.without_offer.contribution
    assert 0 <= r.stayers <= r.takers and 0 <= r.cannibalized <= r.takers


def test_a_campaign_states_only_what_can_happen():
    with pytest.raises(ValueError):
        student_autumn(horizon_months=2)  # shorter than the three months at the offer price
    with pytest.raises(ValueError):
        student_autumn(take_up_bp=10_001)
    with pytest.raises(ValueError):
        student_autumn(eligible=-1)
    with pytest.raises(ValueError):
        student_autumn(months_at_offer=0)
    with pytest.raises(ValueError):
        student_autumn(offer_price=0)


def test_nobody_eligible_costs_and_earns_nothing():
    r = simulate(student_autumn(eligible=0))
    assert (r.takers, r.contribution, r.discount_cost, r.top_up_cost) == (0, 0, 0, 0)


@pytest.mark.parametrize("changes", [
    {},
    {"offer_price": 199, "retention_bp": 4_000},
    {"terms": BOOK.terms("EUR", 1900), "list_price": 1_099, "offer_price": 199, "months_at_offer": 2},
    {"terms": BOOK.terms("GBP", 2000), "list_price": 949, "offer_price": 499, "horizon_months": 24},
    {"list_price": 620, "offer_price": 600, "incremental_bp": 0},
])
def test_the_break_even_retention_is_the_first_one_that_does_not_lose_money(changes):
    campaign = student_autumn(**changes)
    assert break_even_retention(campaign) == brute_force_break_even(campaign)


def test_a_campaign_that_pays_at_any_retention_breaks_even_at_zero():
    # Everyone who takes it is new, and its price covers the artists: no loss to recover.
    campaign = Campaign(BOOK.terms("EUR", 1900), 1_099, 999, 2, 12, 1_000, 1_000, BASIS_POINTS, 0)
    assert break_even_retention(campaign) == 0


def test_a_campaign_that_loses_at_every_retention_has_no_break_even():
    # Nothing after the offer months: retention cannot pay anything back.
    campaign = student_autumn(offer_price=99, horizon_months=3)
    assert simulate(campaign).contribution < 0
    assert break_even_retention(campaign) is None


def finance(**overrides):
    given = {"sets_list_price": False, "below_floor": [], "discount_and_top_up": Money(882_000, "EUR"),
             "contribution": Money(10, "EUR"), "horizon_months": 12}
    return finance_conditions(BOOK, **{**given, **overrides})


def met(conditions) -> list[int]:
    return [c.number for c in conditions if c.met]


def test_finance_signs_for_each_condition_of_the_book_and_otherwise_the_commercial_lead_may():
    assert met(finance()) == []
    assert signatures_needed(finance())[0].role == "commercial_lead"
    assert met(finance(sets_list_price=True)) == [1]
    assert met(finance(below_floor=["Italy: €2.99 against a floor of €6.10"])) == [2]
    assert met(finance(discount_and_top_up=Money(2_000_001, "EUR"))) == [3]
    assert met(finance(contribution=Money(-1, "EUR"))) == [4]
    assert met(finance(asks_consent=True)) == [5]
    need = signatures_needed(finance(below_floor=["x"], contribution=Money(-1, "EUR")))
    assert [(n.role, n.conditions) for n in need] == [("finance", (2, 4))]
    assert "conditions 2 and 4" in need[0].why


def test_the_threshold_itself_does_not_call_finance():
    # "above €20,000": exactly the threshold is not above it.
    assert met(finance(discount_and_top_up=Money(2_000_000, "EUR"))) == []


def test_a_commercial_lead_need_is_met_by_finance_too_but_a_finance_need_only_by_finance():
    lead, money = signatures_needed(finance())[0], signatures_needed(finance(sets_list_price=True))[0]
    assert lead.met_by({"commercial_lead"}) and lead.met_by({"finance"}) and not lead.met_by(set())
    assert money.met_by({"finance"}) and not money.met_by({"commercial_lead"})


def test_takers_rounded_to_zero_count_as_condition_4():
    # §7.3: a simulation with no takers shows no effect either way; finance signs for it.
    conditions = finance(contribution=Money(0, "EUR"), no_takers=["Italy"])
    assert met(conditions) == [4]
    assert "round to zero in Italy" in conditions[3].detail
    assert signatures_needed(conditions)[0].role == "finance"
