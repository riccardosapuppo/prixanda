"""Prepaid passes on plain values (business book §9): how long a code waits,
how a pass's net amount is earned, what finance counts, and the validation
of a pass. The book's and the maquette's numbers are golden cases
(tests/golden); these tests hold the rules around them."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime

import pytest

from commerce.domain.economics import Book
from commerce.domain.localtime import parse_local
from commerce.domain.money import Money
from commerce.domain.offers import Known, OfferPage, OfferPeriod, OfferPrice, PrepaidPass, from_json, shape_problems, to_json
from commerce.domain.prepaid import CODE, Sold, earned, normal_code, pass_ends, valid_until, value
from commerce.domain.validation import BLOCKING, NEEDS_SIGNATURE, Context, MarketFacts, PlanFacts, validate

NOW = datetime(2026, 10, 24, 8, 42, tzinfo=UTC)


@pytest.mark.parametrize(("sold", "months", "until"), [
    (date(2026, 10, 24), 12, date(2027, 10, 23)),
    (date(2026, 10, 31), 4, date(2027, 2, 27)),  # February has no 31st: its last day, less one
    (date(2027, 1, 1), 1, date(2027, 1, 31)),
    (date(2028, 2, 29), 12, date(2029, 2, 27)),
])
def test_a_code_waits_until_the_day_before_the_same_date(sold, months, until):
    assert valid_until(sold, months) == until


def test_a_pass_runs_its_months_as_charges_fall_and_earns_a_part_on_each_of_their_days():
    assert pass_ends(date(2026, 11, 2), 3) == date(2027, 2, 2)
    assert pass_ends(date(2026, 10, 31), 3) == date(2027, 1, 28)  # a start late in the month counts from the 28th
    days = [date(2026, 11, 1), date(2026, 11, 2), date(2026, 12, 1), date(2026, 12, 2), date(2027, 1, 2), date(2028, 1, 1)]
    assert [earned(2458, 3, date(2026, 11, 2), day) for day in days] == [0, 819, 819, 1638, 2458, 2458]
    assert earned(2458, 3, None, date(2027, 1, 1)) == 0


def test_finance_counts_what_was_paid_for_and_what_is_not_yet_earned():
    codes = [Sold(2458, 3, "ready"), Sold(2458, 3, "activated", date(2026, 11, 2)), Sold(2458, 3, "expired")]
    assert value(codes, date(2026, 12, 2)) == replace(value([], date(2026, 12, 2)), sold=3, activated=1, expired=1,
                                                     unearned=2458 + 820)
    with pytest.raises(ValueError):
        value([Sold(2458, 3, "pending")], date(2026, 12, 2))


@pytest.mark.parametrize(("typed", "kept"), [("k7qm 3xtp 9wad", "K7QM-3XTP-9WAD"), ("K7QM-3XTP-9WAD", "K7QM-3XTP-9WAD"),
                                             ("k7qm3xtp9wad", "K7QM-3XTP-9WAD")])
def test_a_code_is_read_as_people_type_it(typed, kept):
    assert normal_code(typed) == kept and CODE.match(kept)


@pytest.mark.parametrize("wrong", ["K7QM-3XTP-9WA0", "K7QM-3XTP-9WAO", "K7QM-3XTP", "K7QM-3XTP-9WAD-ABCD", ""])
def test_a_code_never_holds_a_character_people_misread(wrong):
    assert not CODE.match(normal_code(wrong))


# -- the pass as a change -------------------------------------------------------------------------

KNOWN = Known(markets={"IT": "EUR", "DE": "EUR"}, plans={"individual": (True, False), "student": (True, True),
                                                        "free": (False, False)}, artists=frozenset())
PLANS = {"individual": PlanFacts("individual", "Individual", True, False), "student": PlanFacts("student", "Student", True, True)}
IT = MarketFacts("IT", "Italy", "EUR", "Europe/Rome", 2200, Money(1049, "EUR"), 0)


def gift(**changes) -> PrepaidPass:
    content = PrepaidPass("Three-month gift pass", "individual", 3, (OfferPrice("IT", Money(2999, "EUR")),),
                          (OfferPeriod("IT", parse_local("2026-11-01T00:00")),), 12,
                          (OfferPage("IT", "Three months of Individual", "Paid once, to keep or to give.", "Single use."),))
    return replace(content, **changes)


def report(content: PrepaidPass):
    return validate(content, Context(now=NOW, book=Book(), markets={"IT": IT}, plans=PLANS, artists={}))


def test_a_pass_is_kept_and_read_back_as_it_was_written():
    assert from_json(to_json(gift())) == gift()
    assert shape_problems(gift(), KNOWN) == []


@pytest.mark.parametrize(("changes", "problem"), [
    ({"prices": (OfferPrice("IT", None, 1_000),)}, "a pass has a fixed price"),
    ({"prices": (OfferPrice("IT", Money(0, "EUR")),)}, "more than zero"),
    ({"prices": (OfferPrice("ES", Money(2999, "EUR")),)}, "'ES' is not a market"),
    ({"months": 25}, "between 1 and 24 months"),
    ({"code_valid_months": 37}, "between 1 and 36 months"),
    ({"plan": "free"}, "not a paid plan"),
])
def test_a_pass_that_cannot_mean_anything_is_not_saved(changes, problem):
    assert any(problem in p for p in shape_problems(gift(**changes), KNOWN))


def test_a_pass_validates_and_finance_signs_it_as_a_price():
    r = report(gift())
    assert r.valid
    assert [(s.role, s.conditions) for s in r.signatures] == [("finance", (1,))]
    assert r.sentence == ("Three-month gift pass: Individual for 3 months, paid in advance and never renewed; Italy: €29.99 "
                          "(€10.49 a month at the list price), on sale from 1 November 2026, 00:00 (Europe/Rome); a code "
                          "waits up to 12 months to be activated.")


@pytest.mark.parametrize(("changes", "check"), [
    ({"plan": None}, "price"), ({"plan": "student"}, "audience"), ({"months": 0}, "dates"), ({"code_valid_months": 0}, "dates"),
    ({"prices": ()}, "price"), ({"periods": ()}, "dates"), ({"pages": ()}, "page_text"),
    ({"periods": (OfferPeriod("IT", parse_local("2026-10-01T00:00")),)}, "dates"),  # in the past
])
def test_each_blocking_check_of_a_pass_fires(changes, check):
    r = report(gift(**changes))
    assert not r.valid and check in [f.check for f in r.findings if f.severity == BLOCKING]


def test_a_pass_below_the_floor_for_its_months_is_a_standing_exception_finance_signs():
    r = report(gift(prices=(OfferPrice("IT", Money(1500, "EUR")),)))  # €5.00 a month against a floor of €6.10
    assert r.valid
    [floor] = [f for f in r.findings if f.check == "floor"]
    assert floor.severity == NEEDS_SIGNATURE and "below the floor of €6.10 a month" in floor.message
    assert [(s.role, s.conditions) for s in r.signatures] == [("finance", (1, 2))]
