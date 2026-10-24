"""Money as integers, the one rounding rule, and how the console writes
amounts (business book §3.4)."""

from __future__ import annotations

import pytest

from commerce.domain.economics import Book
from commerce.domain.money import (
    CurrencyMismatch, Money, apply_bp, format_count, format_money, format_percent, round_half_up,
)


@pytest.mark.parametrize(("numerator", "denominator", "rounded"), [
    (5, 2, 3), (7, 2, 4), (1, 3, 0), (2, 3, 1), (4, 2, 2),
    (5_790_000, 12_200, 475),  # §3.5: 474.59 is 475 cents
    (-5, 2, -3), (-7, 2, -4), (-1, 3, 0), (-2, 3, -1), (0, 7, 0),
])
def test_division_rounds_half_up_with_ties_away_from_zero(numerator, denominator, rounded):
    assert round_half_up(numerator, denominator) == rounded


def test_a_loss_rounds_to_the_same_magnitude_as_a_gain():
    for numerator in range(-50, 51):
        assert round_half_up(-numerator, 4) == -round_half_up(numerator, 4)


def test_division_refuses_what_is_not_an_integer_or_a_positive_divisor():
    with pytest.raises(ValueError):
        round_half_up(10, 0)
    with pytest.raises(ValueError):
        round_half_up(10, -3)
    with pytest.raises(TypeError):
        round_half_up(10.5, 2)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        round_half_up(True, 2)  # type: ignore[arg-type]


def test_a_share_in_basis_points():
    assert apply_bp(475, 6_000) == 285
    assert apply_bp(4_515_660, 180) == 81_282  # §6.7, payment costs with the offer


def test_amounts_add_only_in_one_currency():
    assert Money(579, "EUR") + Money(21, "EUR") == Money(600, "EUR")
    assert Money(579, "EUR") - Money(600, "EUR") == Money(-21, "EUR")
    assert -Money(5, "GBP") == Money(-5, "GBP")
    assert Money(3, "EUR").times(4) == Money(12, "EUR")
    with pytest.raises(CurrencyMismatch):
        Money(949, "GBP") + Money(1049, "EUR")
    with pytest.raises(CurrencyMismatch):
        assert Money(949, "GBP") < Money(1049, "EUR")
    with pytest.raises(TypeError):
        Money(1, "EUR") + 1  # type: ignore[operator]


def test_an_amount_is_an_integer_in_a_real_currency_code():
    with pytest.raises(TypeError):
        Money(5.79, "EUR")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        Money(579, "eur")
    with pytest.raises(ValueError):
        Money(579, "EURO")


@pytest.mark.parametrize(("money", "written"), [
    (Money(579, "EUR"), "€5.79"),
    (Money(949, "GBP"), "£9.49"),
    (Money(5, "EUR"), "€0.05"),
    (Money(-187_751, "EUR"), "−€1,877.51"),
    (Money(100_000_000, "EUR"), "€1,000,000.00"),
    (Money(1_000, "JPY"), "¥1,000"),
    (Money(0, "JPY"), "¥0"),
])
def test_box_office_writes_amounts_one_way(money, written):
    assert format_money(money) == written


def test_an_unknown_currency_is_not_written_with_a_guessed_number_of_decimals():
    with pytest.raises(ValueError):
        format_money(Money(100, "CHF"))


def test_counts_and_shares_in_words():
    assert format_count(10_000) == "10,000"
    assert format_count(7) == "7"
    assert format_percent(2_000) == "20%"
    assert format_percent(1_250) == "12.5%"
    assert format_percent(25) == "0.25%"


def test_a_currency_without_decimals_works_through_the_same_rules():
    # The yen has no minor unit: nothing may assume two decimals (§3.4).
    yen = Book(minimum={"JPY": 300}).terms("JPY", 1_000)
    b = yen.breakdown(1_000)
    assert (b.vat, b.net, b.pool, b.top_up, b.payment_costs) == (91, 909, 545, 0, 18)
    assert yen.floor() == 550
    assert yen.pool(yen.net(550)) >= 300 > yen.pool(yen.net(549))
    assert format_money(Money(yen.floor(), "JPY")) == "¥550"
