"""The business book's numbers, case by case (tests/golden/business_book.json),
through the engine's own functions."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from commerce.domain.economics import (
    Book, Campaign, break_even_retention, finance_conditions, recognize_monthly, signatures_needed, simulate,
)
from commerce.domain.money import Money, format_money
from commerce.domain.offers import Audience, ListeningRule, Offer, OfferPage, OfferPeriod, OfferPrice
from commerce.domain.validation import Context, MarketFacts, PlanFacts, validate

CASES = json.loads((Path(__file__).parent / "business_book.json").read_text(encoding="utf-8"))["cases"]
BOOK = Book()

# The sections the stage-2 brief names; each must have at least one case.
REQUIRED_SECTIONS = ["§3.5", "§3.6", "§5.4", "§5.5", "§6.5", "§6.7", "§8.7", "§9.2", "§14.2"]


def campaign(given: dict) -> Campaign:
    return Campaign(BOOK.terms(given["currency"], given["vat_bp"]), given["list_price"], given["offer_price"],
                    given["months_at_offer"], given["horizon_months"], given["eligible"], given["take_up_bp"],
                    given["incremental_bp"], given["retention_bp"])


MARKETS = {"IT": ("Italy", "EUR", "Europe/Rome", 2200), "DE": ("Germany", "EUR", "Europe/Berlin", 1900)}
PLANS = {"student": PlanFacts("student", "Student", True, True), "individual": PlanFacts("individual", "Individual", True, False)}


def sentence(given: dict) -> str:
    """The sentence of a version as validation writes it, for an offer that starts after the clock."""
    name, currency, zone, vat = MARKETS[given["market"]]
    listening = given.get("listening")
    offer = Offer(
        title="golden", plan=given["plan"],
        audience=Audience(given["segment"], None, given["needs_student_check"],
                          ListeningRule(1, listening["min_seconds"], listening["within_days"]) if listening else None),
        prices=(OfferPrice(given["market"], Money(given["offer_price"], currency)),),
        months_at_offer_price=given["months"],
        periods=(OfferPeriod(given["market"], datetime(2026, 11, 6, 9, 0), None),),
        group="golden", redemption_cap=given["cap"],
        pages=(OfferPage(given["market"], "t", "x", "y", ""),),
    )
    market = MarketFacts(given["market"], name, currency, zone, vat, Money(given["list_price"], currency), given["eligible"])
    ctx = Context(now=datetime(2026, 10, 24, 8, 42, tzinfo=UTC), book=BOOK, markets={given["market"]: market},
                  plans=PLANS, artists={1: listening["artist"]} if listening else {})
    return validate(offer, ctx).sentence


def run(case: dict) -> dict:
    given = case["input"]
    kind = case["kind"]
    if kind == "net":
        return {"net": BOOK.terms("EUR", given["vat_bp"]).net(given["price"])}
    if kind == "floor":
        floor = BOOK.terms(given["currency"], given["vat_bp"]).floor()
        return {"floor": floor, "console": format_money(Money(floor, given["currency"]))}
    if kind == "breakdown":
        terms = BOOK.terms(given["currency"], given["vat_bp"])
        b = terms.breakdown(given["price"])
        return {"net": b.net, "pool": b.pool, "top_up": b.top_up, "artists": b.artists,
                "below_floor": given["price"] < terms.floor()}
    if kind == "campaign":
        c = campaign(given)
        r = simulate(c)
        amounts = {
            "revenue_with": r.with_offer.revenue, "revenue_without": r.without_offer.revenue,
            "revenue_difference": r.difference.revenue,
            "artists_with": r.with_offer.artists, "artists_without": r.without_offer.artists,
            "artists_difference": r.difference.artists,
            "fees_with": r.with_offer.payment_costs, "fees_without": r.without_offer.payment_costs,
            "fees_difference": r.difference.payment_costs,
            "contribution": r.contribution, "discount_cost": r.discount_cost, "top_up_cost": r.top_up_cost,
        }
        return {
            "takers": r.takers, "stayers": r.stayers, "cannibalized": r.cannibalized,
            "net_offer": r.net_offer, "pool_offer": r.pool_offer, "top_up_offer": r.top_up_offer,
            "net_list": r.net_list, "pool_list": r.pool_list, "top_up_list": r.top_up_list,
            **amounts,
            "break_even_retention_bp": break_even_retention(c),
            "console": {k: format_money(Money(v, given["currency"])) for k, v in amounts.items()},
        }
    if kind == "finance_conditions":
        c = campaign(given)
        r = simulate(c)
        terms = c.terms
        below = [f"{format_money(Money(c.offer_price, terms.currency))} against a floor of "
                 f"{format_money(Money(terms.floor(), terms.currency))}"] if c.offer_price < terms.floor() else []
        conditions = finance_conditions(
            BOOK, sets_list_price=False, below_floor=below,
            discount_and_top_up=Money(r.discount_cost + r.top_up_cost, "EUR"),
            contribution=Money(r.contribution, "EUR"), horizon_months=c.horizon_months)
        needs = signatures_needed(conditions)
        return {"met": [x.number for x in conditions if x.met], "not_met": [x.number for x in conditions if not x.met],
                "signs": needs[0].role if len(needs) == 1 else [n.role for n in needs]}
    if kind == "sentence":
        return {"sentence": sentence(given)}
    if kind == "price_change":
        terms = BOOK.terms(given["currency"], given["vat_bp"])
        before, after = terms.net(given["from"]), terms.net(given["to"])
        return {"net_from": before, "net_to": after, "pool_from": terms.pool(before), "pool_to": terms.pool(after)}
    if kind == "prepaid":
        net = BOOK.terms(given["currency"], given["vat_bp"]).net(given["price"])
        monthly = recognize_monthly(net, given["months"])
        return {"net": net, "monthly": monthly, "console": [format_money(Money(m, given["currency"])) for m in monthly]}
    if kind == "exchange":
        eur = BOOK.exchange_rate.to_base(Money(given["amount"], given["currency"]))
        return {"eur": eur.amount, "console": format_money(eur), "note": BOOK.exchange_rate.note()}
    raise AssertionError(f"no runner for the golden kind {kind!r}")


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_golden_case(case):
    got = run(case)
    for key, expected in case["expect"].items():
        assert key in got, f"{case['id']}: the runner does not compute {key}"
        assert got[key] == expected, f"{case['id']} ({case['section']}): {key} is {got[key]!r}, the book says {expected!r}"


def test_every_section_the_brief_names_has_its_case():
    covered = {section for case in CASES for section in REQUIRED_SECTIONS if section in case["section"]}
    assert covered == set(REQUIRED_SECTIONS), set(REQUIRED_SECTIONS) - covered
    assert len(CASES) >= 25


def test_a_wrong_number_in_a_case_fails():
    # The comparison above is what the cases rest on: a case that disagrees
    # with the engine by one cent must not pass.
    case = next(c for c in CASES if c["id"] == "student-autumn-worked-example")
    altered = {**case, "expect": {**case["expect"], "contribution": case["expect"]["contribution"] + 1}}
    with pytest.raises(AssertionError):
        test_golden_case(altered)
