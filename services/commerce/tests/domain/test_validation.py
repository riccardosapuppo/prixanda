"""Validation before approval (business book §6.4), on plain values: every
check that can block a version, and the difference in business words (§6.5)."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import pytest

from commerce.domain.economics import Book
from commerce.domain.localtime import parse_local
from commerce.domain.money import Money
from commerce.domain.offers import Audience, ListeningRule, ListPrice, Offer, OfferPage, OfferPeriod, OfferPrice
from commerce.domain.sentence import audience_words
from commerce.domain.validation import (
    BLOCKING, INFO, NEEDS_SIGNATURE, Context, MarketFacts, Neighbour, PlanFacts, audiences_overlap, periods_overlap,
    report_to_json, resolve_price, validate,
)

NOW = datetime(2026, 10, 24, 8, 42, tzinfo=UTC)
BOOK = Book()
PLANS = {
    "free": PlanFacts("free", "Free", False, False), "individual": PlanFacts("individual", "Individual", True, False),
    "duo": PlanFacts("duo", "Duo", True, False), "family": PlanFacts("family", "Family", True, False),
    "student": PlanFacts("student", "Student", True, True),
}
ARTISTS = {4: "Doppelfenster", 7: "Halde"}


def market(code: str, *, list_price: int | None, eligible: int) -> MarketFacts:
    name, currency, zone, vat = {
        "IT": ("Italy", "EUR", "Europe/Rome", 2200), "FR": ("France", "EUR", "Europe/Paris", 2000),
        "DE": ("Germany", "EUR", "Europe/Berlin", 1900), "GB": ("United Kingdom", "GBP", "Europe/London", 2000),
    }[code]
    return MarketFacts(code, name, currency, zone, vat, None if list_price is None else Money(list_price, currency), eligible)


def context(**markets: MarketFacts) -> Context:
    return Context(now=NOW, book=BOOK, markets=markets, plans=PLANS, artists=ARTISTS)


def local(text: str) -> datetime:
    return parse_local(text)


def student_autumn(**changes) -> Offer:
    offer = Offer(
        title="Student Autumn Pass", plan="student",
        audience=Audience("never_paid", None, True, None),
        prices=(OfferPrice("IT", Money(299, "EUR")),), months_at_offer_price=3,
        periods=(OfferPeriod("IT", local("2026-10-26T09:00"), local("2026-11-30T00:00")),),
        group="student-offers", redemption_cap=0,
        pages=(OfferPage("IT", "Student Autumn Pass", "Three months of Student for 2,99 €.", "New subscribers only.", "autumn"),),
    )
    return replace(offer, **changes)


IT = market("IT", list_price=579, eligible=10_000)


def checks(report, severity: str = BLOCKING) -> list[str]:
    return [f.check for f in report.findings if f.severity == severity]


def test_the_student_autumn_pass_validates_and_needs_finance_for_conditions_2_and_4():
    report = validate(student_autumn(), context(IT=IT))
    assert report.valid, [f.message for f in report.findings if f.severity == BLOCKING]
    assert checks(report, NEEDS_SIGNATURE) == ["floor", "signatures"]
    assert [(s.role, s.conditions) for s in report.signatures] == [("finance", (2, 4))]
    assert report.sentence == ("Italy, Student: from €5.79 to €2.99 for 3 months, new subscribers only; "
                               "10,000 eligible; conflicts: none.")
    assert report.eligible == 10_000
    assert report.simulations["IT"].contribution == -187_751


def test_the_release_campaign_sentence_names_the_artist_and_the_cap():
    nordflur = Offer(
        title="Nordflur release", plan="individual",
        audience=Audience("free_listeners", None, False, ListeningRule(4, 3 * 3_600, 30)),
        prices=(OfferPrice("DE", Money(199, "EUR")),), months_at_offer_price=2,
        periods=(OfferPeriod("DE", local("2026-11-06T00:00"), local("2026-12-06T00:00")),),
        group="release-offers", redemption_cap=1_500,
        pages=(OfferPage("DE", "Nordflur is out on 6 November", "Two months of Individual.", "Free listeners only.", ""),),
    )
    report = validate(nordflur, context(DE=market("DE", list_price=1_099, eligible=3_840)))
    assert report.valid
    assert report.sentence == ("Germany, Individual: from €10.99 to €1.99 for 2 months, Free listeners with more than "
                               "3 hours of Doppelfenster in 30 days; 3,840 eligible; at most 1,500; conflicts: none.")


@pytest.mark.parametrize(("changes", "check"), [
    ({"plan": None}, "price"),
    ({"audience": Audience(None)}, "audience"),
    ({"audience": Audience("never_paid", None, False, None)}, "audience"),  # a Student offer without the student check
    ({"plan": "individual", "audience": Audience("subscribers_of_plan", None, False, None)}, "audience"),
    ({"audience": Audience("never_paid", "duo", True, None)}, "audience"),
    ({"audience": Audience("subscribers_of_plan", "duo", True, ListeningRule(4, 3_600, 30))}, "audience"),
    ({"prices": ()}, "price"),
    ({"months_at_offer_price": 0}, "dates"),
    ({"group": None}, "conflict"),
    ({"periods": ()}, "dates"),
    ({"periods": (OfferPeriod("IT", local("2026-10-24T09:00"), None),)}, "dates"),  # 07:00 UTC, before the clock
    ({"periods": (OfferPeriod("IT", local("2026-11-30T00:00"), local("2026-10-26T09:00")),)}, "dates"),
    ({"periods": (OfferPeriod("IT", local("2026-10-25T02:30"), None),)}, "time_zone"),  # the clocks repeat it
    ({"pages": ()}, "page_text"),
    ({"pages": (OfferPage("IT", "Student Autumn Pass", "Three months.", "  ", ""),)}, "page_text"),
    ({"prices": (OfferPrice("IT", Money(579, "EUR")),)}, "price"),  # not below the list price
])
def test_each_blocking_check_fires(changes, check):
    report = validate(student_autumn(**changes), context(IT=IT))
    assert not report.valid
    assert check in checks(report), [f.message for f in report.findings]


def test_a_period_or_page_for_a_market_without_a_price_blocks():
    offer = student_autumn(periods=(*student_autumn().periods, OfferPeriod("FR", local("2026-10-26T09:00"), None)))
    report = validate(offer, context(IT=IT, FR=market("FR", list_price=649, eligible=0)))
    assert "dates" in checks(report)
    offer = student_autumn(pages=(*student_autumn().pages, OfferPage("FR", "t", "x", "y", "")))
    assert "page_text" in checks(validate(offer, context(IT=IT, FR=market("FR", list_price=649, eligible=0))))


def test_nobody_eligible_is_said_but_does_not_block():
    report = validate(student_autumn(), context(IT=replace(IT, eligible=0)))
    assert report.valid
    assert "audience" in checks(report, INFO)


def test_a_percentage_off_is_taken_from_the_list_price_in_force():
    assert resolve_price(OfferPrice("IT", None, 2_000), Money(1_049, "EUR")) == Money(839, "EUR")  # 839.2
    assert resolve_price(OfferPrice("IT", None, 1_250), Money(579, "EUR")) == Money(507, "EUR")  # 506.625
    offer = student_autumn(prices=(OfferPrice("IT", None, 5_000),))
    report = validate(offer, context(IT=IT))
    assert "from €5.79 to €2.90 (50% off)" in report.sentence


def test_an_offer_above_the_floor_needs_no_finance_and_names_who_may_sign():
    offer = student_autumn(plan="individual", audience=Audience("never_paid", None, False, None),
                           prices=(OfferPrice("IT", Money(899, "EUR")),))
    report = validate(offer, context(IT=market("IT", list_price=1_049, eligible=200)))
    assert report.valid and "floor" not in checks(report, NEEDS_SIGNATURE)
    assert [(s.role, s.conditions) for s in report.signatures] == [("commercial_lead", ())]


def test_a_large_audience_puts_the_campaign_over_the_finance_threshold():
    report = validate(student_autumn(), context(IT=replace(IT, eligible=40_000)))
    met = [c.number for c in report.conditions if c.met]
    assert met == [2, 3, 4]


def test_markets_add_up_in_euros_at_the_declared_rate():
    offer = student_autumn(
        plan="individual", audience=Audience("never_paid", None, False, None),
        prices=(OfferPrice("IT", Money(799, "EUR")), OfferPrice("GB", Money(699, "GBP"))),
        periods=(OfferPeriod("IT", local("2026-10-26T09:00"), None), OfferPeriod("GB", local("2026-10-26T09:00"), None)),
        pages=(OfferPage("IT", "a", "b", "c", ""), OfferPage("GB", "a", "b", "c", "")))
    report = validate(offer, context(IT=market("IT", list_price=1_049, eligible=1_000),
                                     GB=market("GB", list_price=949, eligible=1_000)))
    assert report.valid
    gb = report.simulations["GB"]
    it = report.simulations["IT"]
    detail = next(c for c in report.conditions if c.number == 4).detail
    total = it.contribution + BOOK.exchange_rate.to_base(Money(gb.contribution, "GBP")).amount
    from commerce.domain.money import format_money
    assert detail.startswith(format_money(Money(total, "EUR")))
    assert report.sentence.count("conflicts: none.") == 2


def neighbour(offer: Offer, state: str = "scheduled", change_id: int = 12) -> Neighbour:
    return Neighbour(change_id, offer.title, state, offer)


def test_another_offer_in_the_same_group_for_the_same_people_and_period_is_a_conflict():
    black_friday = student_autumn(title="Student Black Friday",
                                  periods=(OfferPeriod("IT", local("2026-11-20T00:00"), local("2026-12-01T00:00")),))
    ctx = replace(context(IT=IT), neighbours=(neighbour(black_friday),))
    report = validate(student_autumn(), ctx)
    assert "conflict" in checks(report)
    assert "conflicts: Student Black Friday (#12)." in report.sentence


@pytest.mark.parametrize("other", [
    {"group": "black-friday"},  # another group: they may stack
    {"periods": (OfferPeriod("IT", local("2026-11-30T00:00"), None),)},  # starts when ours ends
    {"audience": Audience("subscribers_of_plan", "student", True, None)},  # people who pay already
])
def test_no_conflict_without_the_same_group_people_and_period(other):
    ctx = replace(context(IT=IT), neighbours=(neighbour(student_autumn(title="Other", **other)),))
    assert "conflict" not in checks(validate(student_autumn(), ctx))


def test_a_draft_next_door_does_not_block():
    ctx = replace(context(IT=IT), neighbours=(neighbour(student_autumn(title="Other"), state="draft"),))
    assert validate(student_autumn(), ctx).valid


def test_who_can_be_in_two_audiences():
    never, free, anyone = Audience("never_paid"), Audience("free_listeners"), Audience("anyone")
    duo, family = Audience("subscribers_of_plan", "duo"), Audience("subscribers_of_plan", "family")
    fans_of_4 = Audience("free_listeners", listening=ListeningRule(4, 3_600, 30))
    fans_of_7 = Audience("free_listeners", listening=ListeningRule(7, 3_600, 30))
    assert audiences_overlap(never, free) and audiences_overlap(anyone, duo) and audiences_overlap(duo, duo)
    assert not audiences_overlap(duo, family) and not audiences_overlap(never, duo) and not audiences_overlap(free, family)
    assert audiences_overlap(fans_of_4, free)
    assert audiences_overlap(fans_of_4, fans_of_7)  # one person can listen to both artists
    assert not audiences_overlap(Audience(None), anyone)


def release(artist: int, title: str = "Nordflur release") -> Offer:
    return Offer(
        title=title, plan="individual", audience=Audience("free_listeners", None, False, ListeningRule(artist, 3_600, 30)),
        prices=(OfferPrice("DE", Money(199, "EUR")),), months_at_offer_price=2,
        periods=(OfferPeriod("DE", local("2026-11-06T00:00"), local("2026-12-06T00:00")),),
        group="release-offers", redemption_cap=0,
        pages=(OfferPage("DE", title, "Two months of Individual.", "Free listeners only.", ""),),
    )


def released(*neighbours: Neighbour):
    ctx = replace(context(DE=market("DE", list_price=1_099, eligible=3_840)), neighbours=neighbours)
    return validate(release(4), ctx)


def test_campaigns_for_listeners_of_different_artists_clash_when_someone_is_in_both():
    report = released(Neighbour(12, "Abraum release", "approved", release(7, "Abraum release"), {"DE": 2}))
    [conflict] = [f for f in report.findings if f.check == "conflict"]
    assert not report.valid and conflict.facts == {"change": "12", "shared": "2"}
    assert "2 people are in both audiences" in conflict.message and "Abraum release (#12, approved)" in conflict.message


def test_campaigns_for_listeners_of_different_artists_with_nobody_in_both_do_not_clash():
    report = released(Neighbour(12, "Abraum release", "approved", release(7, "Abraum release"), {"DE": 0}))
    assert report.valid and "conflicts: none." in report.sentence


def test_a_count_that_could_not_be_made_is_a_clash():
    report = released(Neighbour(12, "Abraum release", "approved", release(7, "Abraum release")))
    [conflict] = [f for f in report.findings if f.check == "conflict"]
    assert not report.valid and conflict.facts == {"change": "12"} and "could not be counted" in conflict.message


def test_listeners_of_one_artist_clash_without_a_count():
    report = released(Neighbour(12, "Nordflur, second week", "approved", release(4, "Nordflur, second week"), {"DE": 0}))
    [conflict] = [f for f in report.findings if f.check == "conflict"]
    assert conflict.facts == {"change": "12"} and "reaches the same people" in conflict.message


def test_periods_are_half_open_and_an_open_end_runs_on():
    a = OfferPeriod("IT", local("2026-11-01T00:00"), local("2026-12-01T00:00"))
    assert periods_overlap(a, OfferPeriod("IT", local("2026-11-30T23:59"), None))
    assert not periods_overlap(a, OfferPeriod("IT", local("2026-12-01T00:00"), None))
    assert periods_overlap(OfferPeriod("IT", local("2026-01-01T00:00"), None), a)


DE = market("DE", list_price=1_899, eligible=8_412)


def family_rise(**changes) -> ListPrice:
    return replace(ListPrice("Family price, Germany", "family", "DE", Money(2_099, "EUR"), local("2026-12-01T00:00")), **changes)


def test_a_list_price_validates_and_always_needs_finance():
    report = validate(family_rise(), context(DE=DE))
    assert report.valid
    assert [(s.role, s.conditions) for s in report.signatures] == [("finance", (1,))]
    assert report.sentence == ("Germany, Family: from €18.99 to €20.99 for new subscribers from 1 December 2026, 00:00 "
                               "(Europe/Berlin); 8,412 current subscribers keep their price until a price migration "
                               "moves them; overlaps: none.")


@pytest.mark.parametrize(("changes", "check"), [
    ({"plan": None}, "price"), ({"market": None}, "price"), ({"amount": None}, "price"), ({"starts": None}, "dates"),
    ({"amount": Money(1_899, "EUR")}, "price"),  # the price in force already
    ({"starts": local("2026-10-01T00:00")}, "dates"),
    ({"starts": local("2027-03-28T02:30")}, "time_zone"),  # the clocks skip it
])
def test_each_blocking_check_of_a_list_price_fires(changes, check):
    report = validate(family_rise(**changes), context(DE=DE))
    assert not report.valid and check in checks(report)


def test_a_list_price_meets_the_prices_already_in_the_list_and_pending_changes():
    ctx = replace(context(DE=DE), later_prices=((local("2027-01-01T00:00"), Money(2_199, "EUR")),))
    assert "overlap" in checks(validate(family_rise(), ctx))
    pending = Neighbour(31, "Another Family rise", "in_approval", family_rise(amount=Money(1_999, "EUR")))
    report = validate(family_rise(), replace(context(DE=DE), neighbours=(pending,)))
    assert "overlap" in checks(report) and "overlaps: Another Family rise (#31)." in report.sentence


def test_a_list_price_below_the_floor_is_a_standing_exception_finance_signs():
    report = validate(family_rise(plan="student", amount=Money(549, "EUR")), context(DE=replace(DE, list_price=Money(599, "EUR"))))
    assert report.valid
    floor = next(f for f in report.findings if f.check == "floor")
    assert floor.severity == NEEDS_SIGNATURE and "§5.5" in floor.message


def test_the_stored_report_keeps_what_the_console_shows():
    stored = report_to_json(validate(student_autumn(), context(IT=IT)))
    assert stored["valid"] is True
    assert [s["role"] for s in stored["signatures"]] == ["finance"]
    assert stored["markets"]["IT"]["offer_price"] == 299
    assert stored["simulations"]["IT"]["contribution"] == -187_751


def test_an_audience_too_small_to_simulate_needs_finance():
    # Three eligible people at 12% take-up are 0 takers: the effect cannot be shown (§7.3).
    offer = student_autumn(plan="individual", audience=Audience("never_paid", None, False, None),
                           prices=(OfferPrice("IT", Money(899, "EUR")),))
    report = validate(offer, context(IT=market("IT", list_price=1_049, eligible=3)))
    assert report.valid and report.simulations["IT"].takers == 0
    assert [(s.role, s.conditions) for s in report.signatures] == [("finance", (4,))]


@pytest.mark.parametrize("months", [12, 13, 36])
def test_an_offer_longer_than_the_horizon_is_still_simulated_and_finance_signs(months):
    # Individual at €8.99 against €10.49 for a million people: the discount alone is far above the threshold,
    # however many months the offer lasts. An offer longer than the book's horizon used to skip the simulation
    # and with it conditions 3 and 4, leaving the signature to the commercial lead.
    offer = student_autumn(plan="individual", audience=Audience("never_paid", None, False, None),
                           prices=(OfferPrice("IT", Money(899, "EUR")),), months_at_offer_price=months)
    report = validate(offer, context(IT=market("IT", list_price=1_049, eligible=1_000_000)))
    assert report.valid and "IT" in report.simulations
    [need] = report.signatures
    assert need.role == "finance" and 3 in need.conditions


def test_a_simulation_that_cannot_run_counts_as_conditions_3_and_4():
    # No list price in force in France: the version is invalid, and its report never says that the
    # simulated conditions are not met.
    offer = student_autumn(plan="individual", audience=Audience("never_paid", None, False, None),
                           prices=(OfferPrice("IT", Money(899, "EUR")), OfferPrice("FR", Money(899, "EUR"))),
                           periods=(OfferPeriod("IT", local("2026-10-26T09:00"), None),
                                    OfferPeriod("FR", local("2026-10-26T09:00"), None)),
                           pages=(OfferPage("IT", "a", "b", "c", ""), OfferPage("FR", "a", "b", "c", "")))
    report = validate(offer, context(IT=market("IT", list_price=1_049, eligible=1_000),
                                     FR=market("FR", list_price=None, eligible=1_000)))
    assert not report.valid
    met = {c.number: c for c in report.conditions if c.met}
    assert {3, 4} <= set(met) and "cannot be simulated (France: no list price in force)" in met[3].detail


def test_a_percentage_that_brings_the_price_to_nothing_blocks_and_the_validation_still_reports():
    # 99.99% off the Student price of 5,79 € comes to 0,00 €: an offer has a price above zero.
    report = validate(student_autumn(prices=(OfferPrice("IT", None, 9_999),)), context(IT=IT))
    [price] = [f for f in report.findings if f.check == "price" and f.market == "IT"]
    assert not report.valid and price.severity == BLOCKING and "€0.00" in price.message
    assert price.facts == {"offer_price": "0", "list_price": "579"}
    assert report.simulations == {}
    simulated = {c.number: c for c in report.conditions if c.number in (3, 4)}
    assert all(c.met and "cannot be simulated" in c.detail for c in simulated.values())


def test_an_audience_in_the_middle_of_a_sentence_keeps_its_proper_names():
    def words(audience: Audience) -> str:
        return audience_words(audience, "Italy", plan_names={"duo": "Duo"}, artist_names={4: "Doppelfenster"}, in_sentence=True)

    assert words(Audience("never_paid", None, True)) == "verified students in Italy who have never had a paid plan"
    assert words(Audience("subscribers_of_plan", "duo")) == "Duo subscribers in Italy"
    assert words(Audience("free_listeners", listening=ListeningRule(4, 10_800, 30))) == (
        "free listeners in Italy, with more than 3 hours of Doppelfenster in the last 30 days")
