"""Price migrations on plain values (business book §8): the window, the days
the new price applies and a subscription leaves, the simulation, and the
validation of a migration. The golden cases (tests/golden) hold the book's and
the maquette's numbers; these tests hold the rules around them."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime

import pytest

from commerce.domain.economics import Book
from commerce.domain.localtime import parse_local
from commerce.domain.migration import Charges, Policy, first_charge_from, leaving_day, new_price_from, simulate_migration
from commerce.domain.money import Money
from commerce.domain.offers import ListPrice, PriceMigration
from commerce.domain.validation import BLOCKING, NEEDS_SIGNATURE, Context, MarketFacts, Neighbour, PlanFacts, validate

NOW = datetime(2026, 10, 24, 8, 42, tzinfo=UTC)
BOOK = Book()
TERMS = BOOK.terms("EUR", 1900)
GERMANY = Policy("DE", "consent", "Consent is needed.", ("Kammergericht, 15 November 2023",), 45, "move_to_free",
                 "When the period already paid at the consent deadline runs out, the account moves to the free plan.",
                 ("End the paid subscription at the end of the billing period",))
ITALY = Policy("IT", "notice", "Notice and a right to withdraw.", ("Consumer Code, art. 33",), 30, "new_price",
               "Thirty days of notice.", ())
DEADLINE = date(2026, 12, 17)
STARTS = date(2026, 12, 1)


def test_a_window_ends_at_23_59_of_its_last_day_whatever_the_hour_it_opened():
    assert GERMANY.window_ends(datetime(2026, 11, 2, 9, 0)) == datetime(2026, 12, 17, 23, 59)
    assert GERMANY.window_ends(datetime(2026, 11, 2, 23, 30)) == datetime(2026, 12, 17, 23, 59)
    assert ITALY.window_ends(datetime(2026, 11, 2, 9, 0)) == datetime(2026, 12, 2, 23, 59)


def test_the_first_charge_from_a_day_counts_that_day():
    assert first_charge_from(date(2026, 3, 17), 17, date(2026, 12, 17)) == date(2026, 12, 17)
    assert first_charge_from(date(2026, 3, 17), 17, date(2026, 12, 18)) == date(2027, 1, 17)
    # Before the subscription began, its first charge is its first day.
    assert first_charge_from(date(2026, 3, 17), 17, date(2026, 1, 1)) == date(2026, 3, 17)


@pytest.mark.parametrize("day", range(1, 29))
def test_a_month_already_paid_is_never_cut_short_and_nothing_is_charged_on_the_leaving_day(day):
    """Whatever the billing day: the subscription leaves on a billing date, the first on or after the deadline's
    day, so the period paid before it runs to its end; and a yes never charges the new price before new
    subscribers pay it."""
    charges = Charges(date(2026, 1, day), day)
    leaves = leaving_day(GERMANY, charges, starts=STARTS, window_ends=DEADLINE)
    assert leaves is not None and leaves.day == day and DEADLINE <= leaves < date(2027, 1, 18)
    assert first_charge_from(charges.started_on, day, DEADLINE) == leaves
    applies = new_price_from(GERMANY, charges, starts=STARTS, window_ends=DEADLINE, yes_on=date(2026, 11, 2))
    assert applies.day == day and STARTS <= applies < date(2027, 1, 1)


def test_the_old_price_kept_is_not_a_leaving_day_and_a_yes_follows_its_day():
    keeping = replace(GERMANY, after_window="keep_old_price")
    assert leaving_day(keeping, Charges(date(2026, 3, 17), 17), starts=STARTS, window_ends=DEADLINE) is None
    with pytest.raises(ValueError):
        new_price_from(GERMANY, Charges(date(2026, 3, 17), 17), starts=STARTS, window_ends=DEADLINE)


def test_a_notice_applies_the_new_price_and_a_no_leaves_on_the_same_day():
    charges = Charges(date(2026, 3, 17), 17)
    ends = date(2026, 12, 2)
    assert new_price_from(ITALY, charges, starts=STARTS, window_ends=ends) == date(2026, 12, 17)
    assert leaving_day(ITALY, charges, starts=STARTS, window_ends=ends) == date(2026, 12, 17)


def test_the_simulation_s_numbers_follow_the_formulas():
    r = simulate_migration(TERMS, 1899, 2099, 8412, 9300, GERMANY)
    assert (r.before.net, r.after.net, r.before.artists, r.after.artists) == (1596, 1764, 958, 1058)
    assert (r.before.contribution, r.after.contribution) == (604, 668)
    assert r.revenue_change == r.accepting * (1764 - 1596) - r.not_accepting * 1596
    assert r.contribution_change == r.accepting * (668 - 604) - r.not_accepting * 604
    # At the break-even acceptance the revenue neither rises nor falls, to the rounding of one subscriber.
    at_break_even = simulate_migration(TERMS, 1899, 2099, 10_000, r.break_even_revenue_bp, GERMANY)
    assert abs(at_break_even.revenue_change) <= 1764
    everyone = simulate_migration(TERMS, 1899, 2099, 8412, 10_000, GERMANY)
    assert (everyone.not_accepting, everyone.revenue_at_risk) == (0, 0)


@pytest.mark.parametrize(("args", "words"), [
    ((1899, 1899, 10, 9000), "raises the price"), ((1899, 1799, 10, 9000), "raises the price"),
    ((1899, 2099, -1, 9000), "counted from zero"), ((1899, 2099, 10, 10_001), "counted from zero"),
])
def test_the_simulation_refuses_what_is_not_a_migration(args, words):
    with pytest.raises(ValueError, match=words):
        simulate_migration(TERMS, *args, GERMANY)


# -- validation ----------------------------------------------------------------------------

PLANS = {"family": PlanFacts("family", "Family", True, False)}
DE = MarketFacts("DE", "Germany", "EUR", "Europe/Berlin", 1900, Money(1899, "EUR"), 8412)


def rise(**changes) -> PriceMigration:
    migration = PriceMigration("Family price rise, Germany", "family", "DE", Money(2099, "EUR"),
                               parse_local("2026-11-02T09:00"), parse_local("2026-12-01T00:00"))
    return replace(migration, **changes)


def context(**changes) -> Context:
    return replace(Context(now=NOW, book=BOOK, markets={"DE": DE}, plans=PLANS, artists={}, policy=GERMANY), **changes)


def blocking(report) -> list[str]:
    return [f.check for f in report.findings if f.severity == BLOCKING]


def test_a_migration_validates_and_finance_signs_for_conditions_1_and_5():
    report = validate(rise(), context())
    assert report.valid, report.findings
    assert [(s.role, s.conditions) for s in report.signatures] == [("finance", (1, 5))]
    assert report.sentence == (
        "Germany, Family: from €18.99 to €20.99 for new subscribers from 1 December 2026, 00:00 (Europe/Berlin); "
        "8,412 current subscribers asked for their consent from 2 November 2026, 09:00 (Europe/Berlin), within 45 days; "
        "without it: when the period already paid at the consent deadline runs out, the account moves to the free plan "
        "(the music service's choice); overlaps: none.")


def test_in_a_notice_market_the_sentence_says_they_are_told():
    report = validate(rise(), context(policy=ITALY))
    assert "8,412 current subscribers told from 2 November 2026, 09:00 (Europe/Berlin), 30 days before the new price " \
           "applies to them; they may leave before it" in report.sentence


@pytest.mark.parametrize(("changes", "check"), [
    ({"plan": None}, "price"), ({"market": None}, "price"), ({"amount": None}, "price"), ({"notices": None}, "dates"),
    ({"starts": None}, "dates"),
    ({"amount": Money(1899, "EUR")}, "price"),  # not above the price in force
    ({"starts": parse_local("2026-11-01T00:00")}, "dates"),  # new subscribers before the existing ones are told
    ({"notices": parse_local("2026-10-01T09:00")}, "dates"),  # in the past
])
def test_each_blocking_check_of_a_migration_fires(changes, check):
    report = validate(rise(**changes), context())
    assert not report.valid and check in blocking(report), report.findings


def test_a_market_without_rules_for_existing_subscribers_blocks():
    report = validate(rise(), context(policy=None))
    assert not report.valid and any("no rules yet" in f.message for f in report.findings)


def test_a_migration_below_the_floor_is_a_standing_exception_finance_signs():
    report = validate(rise(plan="family", amount=Money(549, "EUR")), context(markets={"DE": replace(DE, list_price=Money(499, "EUR"))}))
    assert report.valid and any(f.check == "floor" and f.severity == NEEDS_SIGNATURE for f in report.findings)


def test_another_change_of_the_same_price_blocks_until_it_is_live_and_its_window_ended():
    pending = Neighbour(31, "Family list price", "approved", ListPrice("Family list price", "family", "DE", Money(1999, "EUR"),
                                                                       parse_local("2027-01-01T00:00")))
    assert "overlap" in blocking(validate(rise(), context(neighbours=(pending,))))
    active = Neighbour(32, "Family rise of the spring", "active", rise(notices=parse_local("2026-10-20T09:00")))
    report = validate(rise(), context(neighbours=(active,)))  # its window runs to 4 December at 23:59
    assert "overlap" in blocking(report)
    assert any("until 4 December 2026, 23:59 (Europe/Berlin)" in f.message for f in report.findings)
    later = rise(notices=parse_local("2026-12-05T09:00"), starts=parse_local("2027-01-01T00:00"))
    assert blocking(validate(later, context(neighbours=(active,)))) == []
    elsewhere = Neighbour(33, "Duo rise", "active", rise(plan="duo", notices=parse_local("2026-10-20T09:00")))
    assert blocking(validate(rise(), context(neighbours=(elsewhere,)))) == []
