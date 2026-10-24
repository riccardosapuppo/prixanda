"""Validation before approval (business book §6.4).

The engine reads what a version needs from the data (list prices in force,
eligible people, the other offers and prices), then hands it here: these
functions only compare, count and write. A report says whether the version
can be submitted, what blocks it, which signatures it needs (§7.3) and the
difference in business words (§6.5).

Checks, by the name a finding carries:
  price      the version sells something, at a price below the list price
  floor      an offer price, or a list price, below the market's floor (§5.4)
  conflict   another offer in the same non-combinability group reaches the
             same people in the same period (§6.1, §10.3)
  overlap    another price for the same plan and market (§4.1)
  dates      a start in the future, before the end; how long the offer lasts
  time_zone  a local time the clocks skip or repeat (§3.7)
  audience   who may take it is coherent (§6.4)
  page_text  every market it is sold in has its page
  signatures who must sign, and why (§7.3)

The simulated conditions (§7.3, conditions 3 and 4) use the book's default
assumptions, never values the author typed: otherwise an author could type
an optimistic retention and avoid finance's signature.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime

from commerce.domain.economics import (
    Book, Campaign, CampaignResult, FinanceCondition, SignatureNeed, finance_conditions, signatures_needed, simulate,
)
from commerce.domain.localtime import AmbiguousLocalTime, describe_local, format_local, to_instant
from commerce.domain.money import BASIS_POINTS, Money, format_money, round_half_up
from commerce.domain.offers import Audience, Content, ListPrice, Offer, OfferPeriod, OfferPrice
from commerce.domain.sentence import OfferClause, audience_short, list_price_sentence, offer_clause

BLOCKING, NEEDS_SIGNATURE, INFO = "blocking", "needs_signature", "info"
# A neighbour in one of these states can clash: it is on its way to the site, or there.
PENDING_OR_LIVE = ("validated", "in_approval", "approved", "scheduled", "active")


@dataclass(frozen=True)
class Finding:
    check: str
    severity: str
    market: str
    message: str
    facts: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class MarketFacts:
    """One market, as the engine read it for this version."""

    code: str
    name: str
    currency: str
    zone: str
    vat_bp: int
    list_price: Money | None  # of the version's plan, in force at its start in this market
    eligible: int  # people the offer reaches now; for a list price, the current subscribers of that plan


@dataclass(frozen=True)
class PlanFacts:
    id: str
    name: str
    paid: bool
    needs_student_check: bool


@dataclass(frozen=True)
class Neighbour:
    """Another change that may clash with this one."""

    change_id: int
    title: str
    state: str
    content: Content


@dataclass(frozen=True)
class Context:
    now: datetime
    book: Book
    markets: Mapping[str, MarketFacts]
    plans: Mapping[str, PlanFacts]
    artists: Mapping[int, str]
    neighbours: tuple[Neighbour, ...] = ()
    # For a list price: prices of the same plan and market already in the
    # price list from the version's start or later, as (local start, amount).
    later_prices: tuple[tuple[datetime, Money], ...] = ()


@dataclass(frozen=True)
class Report:
    valid: bool
    findings: tuple[Finding, ...]
    conditions: tuple[FinanceCondition, ...]
    signatures: tuple[SignatureNeed, ...]
    eligible: int
    sentence: str
    markets: Mapping[str, Mapping[str, object]]
    simulations: Mapping[str, CampaignResult] = field(default_factory=dict)


def resolve_price(price: OfferPrice, list_price: Money) -> Money:
    """A fixed amount, or the list price less a percentage, rounded half up (§6.1)."""
    if price.fixed is not None:
        return price.fixed
    if price.percent_off_bp is None:
        raise ValueError(f"the price in {price.market} is neither fixed nor a percentage")
    return Money(round_half_up(list_price.amount * (BASIS_POINTS - price.percent_off_bp), BASIS_POINTS), list_price.currency)


SEGMENTS_THAT_MEET = {
    frozenset({"never_paid"}), frozenset({"free_listeners"}), frozenset({"never_paid", "free_listeners"}),
}


def audiences_overlap(a: Audience, b: Audience) -> bool:
    """Whether some person can be in both audiences. A student check or a
    listening threshold narrows an audience without moving it elsewhere; two
    listening rules aim at different people only through different artists."""
    if a.segment is None or b.segment is None:
        return False
    if "anyone" not in (a.segment, b.segment):
        if a.segment == b.segment == "subscribers_of_plan":
            if a.current_plan != b.current_plan:
                return False
        elif frozenset({a.segment, b.segment}) not in SEGMENTS_THAT_MEET:
            return False
    if a.listening is not None and b.listening is not None and a.listening.artist_id != b.listening.artist_id:
        return False
    return True


def periods_overlap(a: OfferPeriod, b: OfferPeriod) -> bool:
    """Half-open periods of the same market's local time; no end is open."""
    if a.starts is None or b.starts is None:
        return False
    a_before_b_ends = b.ends is None or a.starts < b.ends
    b_before_a_ends = a.ends is None or b.starts < a.ends
    return a_before_b_ends and b_before_a_ends


class _Findings:
    def __init__(self) -> None:
        self.items: list[Finding] = []

    def add(self, check: str, severity: str, market: str, message: str, **facts: object) -> None:
        self.items.append(Finding(check, severity, market, message, {k: str(v) for k, v in facts.items()}))

    def blocking(self) -> bool:
        return any(f.severity == BLOCKING for f in self.items)


def _check_times(found: _Findings, market: MarketFacts, period: OfferPeriod, now: datetime) -> None:
    instants = {}
    for name, moment in (("start", period.starts), ("end", period.ends)):
        if moment is None:
            continue
        try:
            instants[name] = to_instant(moment, market.zone)
        except AmbiguousLocalTime as clash:
            found.add("time_zone", BLOCKING, market.code, f"{market.name}: the {name} {clash}.",
                      local=format_local(moment), zone=market.zone, kind=clash.kind)
    if period.starts is not None and "start" in instants and instants["start"] <= now:
        found.add("dates", BLOCKING, market.code,
                  f"{market.name}: the start, {describe_local(period.starts, market.zone)}, is not in the future.",
                  starts=format_local(period.starts))
    if period.starts is not None and period.ends is not None and period.ends <= period.starts:
        found.add("dates", BLOCKING, market.code, f"{market.name}: the period ends before it starts.",
                  starts=format_local(period.starts), ends=format_local(period.ends))


def _signature_finding(found: _Findings, signatures: list[SignatureNeed]) -> None:
    for need in signatures:
        severity = NEEDS_SIGNATURE if need.role == "finance" else INFO
        found.add("signatures", severity, "", need.why, role=need.role,
                  conditions=",".join(str(n) for n in need.conditions))


def validate_offer(offer: Offer, ctx: Context) -> Report:
    found = _Findings()
    book = ctx.book
    plan = ctx.plans.get(offer.plan) if offer.plan else None
    audience = offer.audience
    if plan is None:
        found.add("price", BLOCKING, "", "Choose the plan the offer sells.")
    if audience.segment is None:
        found.add("audience", BLOCKING, "", "Choose who may take the offer.")
    if plan is not None and plan.needs_student_check and not audience.needs_student_check:
        found.add("audience", BLOCKING, "", f"{plan.name} offers need a student verification (§6.4).")
    if audience.segment == "subscribers_of_plan" and audience.current_plan is None:
        found.add("audience", BLOCKING, "", "An offer for existing subscribers names the plan they are on (§6.4).")
    if audience.current_plan is not None and audience.segment != "subscribers_of_plan":
        found.add("audience", BLOCKING, "", "Only an offer for existing subscribers names their current plan.")
    if audience.listening is not None and audience.segment not in ("free_listeners", "never_paid"):
        found.add("audience", BLOCKING, "", "A listening rule aims at people who do not pay yet (§14.2).")
    if not offer.prices:
        found.add("price", BLOCKING, "", "Set the price in at least one market.")
    if offer.months_at_offer_price < 1:
        found.add("dates", BLOCKING, "", "Say how many months the offer price lasts.")
    if not offer.group:
        found.add("conflict", BLOCKING, "", "Name its non-combinability group: offers in the same group never stack (§6.1).")
    sold = set(offer.markets())
    for entry in (*offer.periods, *offer.pages):
        if entry.market not in sold:
            check = "dates" if isinstance(entry, OfferPeriod) else "page_text"
            found.add(check, BLOCKING, entry.market, f"{ctx.markets[entry.market].name} has no price: remove it, or price it.")

    below_floor: list[str] = []
    simulations: dict[str, CampaignResult] = {}
    per_market: dict[str, dict[str, object]] = {}
    clauses: list[str] = []
    eligible_total = 0
    for code in offer.markets():
        market = ctx.markets[code]
        terms = book.terms(market.currency, market.vat_bp)
        floor = Money(terms.floor(), market.currency)
        price = offer.price_in(code)
        assert price is not None
        offer_price: Money | None = None
        if market.list_price is None:
            if plan is not None:
                found.add("price", BLOCKING, code, f"{market.name}: no list price of {plan.name} is in force at the start.")
        else:
            offer_price = resolve_price(price, market.list_price)
            if offer_price >= market.list_price:
                found.add("price", BLOCKING, code,
                          f"{market.name}: an offer costs less than the list price in force, {format_money(market.list_price)}.",
                          offer_price=offer_price.amount, list_price=market.list_price.amount)
            elif offer_price < floor:
                top_up = terms.top_up(terms.net(offer_price.amount))
                below_floor.append(f"{market.name}: {format_money(offer_price)} against a floor of {format_money(floor)}")
                found.add("floor", NEEDS_SIGNATURE, code,
                          f"{market.name}: {format_money(offer_price)} is below the floor of {format_money(floor)}; "
                          f"the artists' minimum costs {format_money(Money(top_up, market.currency))} a month per subscription.",
                          offer_price=offer_price.amount, floor=floor.amount, top_up=top_up)
        period = offer.period_in(code)
        if period is None:
            found.add("dates", BLOCKING, code, f"{market.name}: set when the offer can be taken.")
        else:
            _check_times(found, market, period, ctx.now)
        page = offer.page_in(code)
        missing = [] if page is None else [name for name in ("title", "text", "terms") if not getattr(page, name).strip()]
        if page is None or missing:
            what = "a page" if page is None else "its page " + " and ".join(missing)
            found.add("page_text", BLOCKING, code, f"{market.name} needs {what}.")
        if market.eligible == 0 and audience.segment is not None:
            found.add("audience", INFO, code, f"{market.name}: nobody is eligible right now.")
        eligible_total += market.eligible

        conflicts = []
        for other in ctx.neighbours:
            if not isinstance(other.content, Offer) or other.state not in PENDING_OR_LIVE:
                continue
            theirs = other.content.period_in(code)
            if (period is not None and theirs is not None and offer.group and other.content.group == offer.group
                    and audiences_overlap(audience, other.content.audience) and periods_overlap(period, theirs)):
                conflicts.append(f"{other.title} (#{other.change_id})")
                found.add("conflict", BLOCKING, code,
                          f"{market.name}: {other.title} (#{other.change_id}, {other.state.replace('_', ' ')}) reaches "
                          f"the same people in the same period, in the same group {offer.group}: they never stack.",
                          change=other.change_id)

        simulation = None
        if (plan is not None and market.list_price is not None and offer_price is not None
                and offer_price < market.list_price and offer.months_at_offer_price >= 1
                and book.horizon_months >= offer.months_at_offer_price):
            simulation = simulate(Campaign(terms, market.list_price.amount, offer_price.amount, offer.months_at_offer_price,
                                           book.horizon_months, market.eligible, book.take_up_bp, book.incremental_bp,
                                           book.retention_bp))
            simulations[code] = simulation
        per_market[code] = {
            "eligible": market.eligible,
            "list_price": None if market.list_price is None else market.list_price.amount,
            "offer_price": None if offer_price is None else offer_price.amount,
            "floor": floor.amount,
            "currency": market.currency,
        }
        clauses.append(offer_clause(OfferClause(
            market_name=market.name, plan_name=plan.name if plan else "no plan", list_price=market.list_price,
            offer_price=offer_price, percent_off_bp=price.percent_off_bp, months=offer.months_at_offer_price,
            audience=audience_short(audience, plan_needs_student_check=bool(plan and plan.needs_student_check),
                                    plan_names={p.id: p.name for p in ctx.plans.values()}, artist_names=dict(ctx.artists)),
            eligible=market.eligible, cap=offer.redemption_cap, conflicts=conflicts)))

    rate = book.exchange_rate
    cost = contribution = None
    if simulations:
        cost = Money.zero(rate.base)
        contribution = Money.zero(rate.base)
        for code, result in simulations.items():
            currency = ctx.markets[code].currency
            cost += rate.to_base(Money(result.discount_cost + result.top_up_cost, currency))
            contribution += rate.to_base(Money(result.contribution, currency))
    conditions = finance_conditions(book, sets_list_price=False, below_floor=below_floor, discount_and_top_up=cost,
                                    contribution=contribution, horizon_months=book.horizon_months)
    signatures = signatures_needed(conditions)
    _signature_finding(found, signatures)
    sentence = " ".join(clauses) if clauses else f"{offer.title}: not priced in any market yet."
    return Report(not found.blocking(), tuple(found.items), tuple(conditions), tuple(signatures), eligible_total,
                  sentence, per_market, simulations)


def validate_list_price(change: ListPrice, ctx: Context) -> Report:
    found = _Findings()
    book = ctx.book
    plan = ctx.plans.get(change.plan) if change.plan else None
    market = ctx.markets.get(change.market) if change.market else None
    if plan is None:
        found.add("price", BLOCKING, "", "Choose the plan.")
    if market is None:
        found.add("price", BLOCKING, "", "Choose the market.")
    if change.amount is None:
        found.add("price", BLOCKING, change.market or "", "Set the new price.")
    if change.starts is None:
        found.add("dates", BLOCKING, change.market or "", "Set when the new price starts.")
    starts_words = None
    per_market: dict[str, dict[str, object]] = {}
    if market is not None:
        code = market.code
        if change.starts is not None:
            starts_words = describe_local(change.starts, market.zone)
            _check_times(found, market, OfferPeriod(code, change.starts, None), ctx.now)
        if change.amount is not None:
            terms = book.terms(market.currency, market.vat_bp)
            floor = Money(terms.floor(), market.currency)
            if market.list_price is not None and change.amount == market.list_price:
                found.add("price", BLOCKING, code, f"{market.name}: the price in force is already {format_money(change.amount)}.")
            if change.amount < floor:
                top_up = terms.top_up(terms.net(change.amount.amount))
                found.add("floor", NEEDS_SIGNATURE, code,
                          f"{market.name}: {format_money(change.amount)} is below the floor of {format_money(floor)}. "
                          f"As a standing exception (§5.5) the artists' minimum would cost "
                          f"{format_money(Money(top_up, market.currency))} a month per subscription.",
                          amount=change.amount.amount, floor=floor.amount, top_up=top_up)
            per_market[code] = {"eligible": market.eligible, "list_price": None if market.list_price is None else market.list_price.amount,
                                "new_price": change.amount.amount, "floor": floor.amount, "currency": market.currency}
        overlaps = []
        for later_start, amount in ctx.later_prices:
            overlaps.append(f"{format_money(amount)} from {format_local(later_start)}")
            found.add("overlap", BLOCKING, code,
                      f"{market.name}: the price list already holds {format_money(amount)} from {describe_local(later_start, market.zone)}.",
                      starts=format_local(later_start), amount=amount.amount)
        for other in ctx.neighbours:
            content = other.content
            if (isinstance(content, ListPrice) and other.state in PENDING_OR_LIVE and other.state != "active"
                    and content.plan == change.plan and content.market == change.market):
                overlaps.append(f"{other.title} (#{other.change_id})")
                found.add("overlap", BLOCKING, code,
                          f"{market.name}: {other.title} (#{other.change_id}, {other.state.replace('_', ' ')}) "
                          f"already changes this price.", change=other.change_id)
        sentence = list_price_sentence(market_name=market.name, plan_name=plan.name if plan else "no plan",
                                       current=market.list_price, new=change.amount, starts=starts_words,
                                       subscribers=market.eligible, overlaps=overlaps)
    else:
        sentence = f"{change.title}: market not chosen yet."
    conditions = finance_conditions(book, sets_list_price=True, below_floor=[], discount_and_top_up=None,
                                    contribution=None, horizon_months=book.horizon_months)
    signatures = signatures_needed(conditions)
    _signature_finding(found, signatures)
    eligible = market.eligible if market is not None else 0
    return Report(not found.blocking(), tuple(found.items), tuple(conditions), tuple(signatures), eligible, sentence,
                  per_market)


def validate(content: Content, ctx: Context) -> Report:
    return validate_offer(content, ctx) if isinstance(content, Offer) else validate_list_price(content, ctx)


def report_to_json(report: Report) -> dict:
    """The stored report: what GetChange shows until the next validation."""
    return {
        "valid": report.valid,
        "findings": [{"check": f.check, "severity": f.severity, "market": f.market, "message": f.message,
                      "facts": dict(f.facts)} for f in report.findings],
        "conditions": [{"number": c.number, "rule": c.rule, "met": c.met, "detail": c.detail} for c in report.conditions],
        "signatures": [{"role": s.role, "conditions": list(s.conditions), "why": s.why} for s in report.signatures],
        "markets": {code: dict(values) for code, values in report.markets.items()},
        "simulations": {code: {"contribution": r.contribution, "discount_cost": r.discount_cost,
                               "top_up_cost": r.top_up_cost, "takers": r.takers} for code, r in report.simulations.items()},
    }
