"""What a version of a change says: an offer (business book §6.1), a new
list price (§4.2) or a price migration (§8), and how it is kept in the
database.

A draft may be incomplete: a missing price, page or start is something the
validation reports (§6.4), not a reason to refuse saving. What is refused
on saving is a value that cannot mean anything: an unknown market, an amount
in the wrong currency, a time that is not a time. shape_problems() lists those.

The stored form is plain JSON with integers for money and the contract's
text for local times. PostgreSQL computes the fingerprint an approval names
from that JSON as jsonb writes it (migration V2), so equal content always has
the same fingerprint.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime

from commerce.domain.localtime import format_local, parse_local
from commerce.domain.money import Money

SCHEMA = 1
SEGMENTS = ("never_paid", "free_listeners", "subscribers_of_plan", "anyone")

# Limits of what a version may hold. Beyond them a value is refused on saving.
TITLE_MAX = 200
PAGE_TITLE_MAX = 120
PAGE_TEXT_MAX = 2_000
PAGE_TERMS_MAX = 4_000
TREATMENT_MAX = 40
MONTHS_MAX = 36
LISTENING_DAYS_MAX = 90
LISTENING_SECONDS_MAX = 90 * 86_400
GROUP = re.compile(r"^[a-z][a-z0-9-]{0,39}$")


@dataclass(frozen=True)
class ListeningRule:
    """Played an artist for more than min_seconds in the last within_days days (§14.2)."""

    artist_id: int
    min_seconds: int
    within_days: int


@dataclass(frozen=True)
class Audience:
    segment: str | None = None  # None: not chosen yet
    current_plan: str | None = None
    needs_student_check: bool = False
    listening: ListeningRule | None = None


@dataclass(frozen=True)
class OfferPrice:
    """A fixed amount, or a percentage off the list price in force (§6.1)."""

    market: str
    fixed: Money | None = None
    percent_off_bp: int | None = None


@dataclass(frozen=True)
class OfferPeriod:
    """When it can be taken in one market, in local time; no end: open."""

    market: str
    starts: datetime | None = None
    ends: datetime | None = None


@dataclass(frozen=True)
class OfferPage:
    market: str
    title: str = ""
    text: str = ""
    terms: str = ""
    treatment: str = ""


@dataclass(frozen=True)
class Offer:
    title: str
    plan: str | None = None
    audience: Audience = field(default_factory=Audience)
    prices: tuple[OfferPrice, ...] = ()
    months_at_offer_price: int = 0
    periods: tuple[OfferPeriod, ...] = ()
    group: str | None = None
    redemption_cap: int = 0
    pages: tuple[OfferPage, ...] = ()

    kind = "offer"

    def markets(self) -> list[str]:
        """The markets the offer is sold in: those with a price, in order."""
        return [p.market for p in self.prices]

    def price_in(self, market: str) -> OfferPrice | None:
        return next((p for p in self.prices if p.market == market), None)

    def period_in(self, market: str) -> OfferPeriod | None:
        return next((p for p in self.periods if p.market == market), None)

    def page_in(self, market: str) -> OfferPage | None:
        return next((p for p in self.pages if p.market == market), None)


@dataclass(frozen=True)
class ListPrice:
    """A new list price for one plan and market, from a local time (§4.2)."""

    title: str
    plan: str | None = None
    market: str | None = None
    amount: Money | None = None
    starts: datetime | None = None

    kind = "list_price"


@dataclass(frozen=True)
class PriceMigration:
    """A higher price for one plan in one market, for everyone (§8, §14.3): new
    subscribers pay it from starts; existing ones are asked, or told, from
    notices, by the rules of their market. The change starts at notices."""

    title: str
    plan: str | None = None
    market: str | None = None
    amount: Money | None = None
    notices: datetime | None = None
    starts: datetime | None = None

    kind = "price_migration"


Content = Offer | ListPrice | PriceMigration


@dataclass(frozen=True)
class Known:
    """The reference data a version is checked against."""

    markets: Mapping[str, str]  # code -> currency
    plans: Mapping[str, tuple[bool, bool]]  # id -> (paid, needs a student check)
    artists: frozenset[int]


def _text(value: str, limit: int, what: str, problems: list[str]) -> None:
    if len(value) > limit:
        problems.append(f"{what} is longer than {limit} characters")


def shape_problems(content: Content, known: Known) -> list[str]:
    """What makes a version meaningless, whatever its state: the reasons to
    refuse saving it."""
    problems: list[str] = []
    title = content.title.strip()
    if not title:
        problems.append("a change needs a title")
    _text(title, TITLE_MAX, "the title", problems)
    if content.plan is not None and (content.plan not in known.plans or not known.plans[content.plan][0]):
        problems.append(f"{content.plan!r} is not a paid plan")
    if isinstance(content, (ListPrice, PriceMigration)):
        if content.market is not None and content.market not in known.markets:
            problems.append(f"{content.market!r} is not a market")
        if content.amount is not None:
            if content.market in known.markets and content.amount.currency != known.markets[content.market]:
                problems.append(f"a price in {content.market} is in {known.markets[content.market]}, not {content.amount.currency}")
            if content.amount.amount <= 0:
                problems.append("a list price is more than zero")
        return problems

    audience = content.audience
    if audience.segment is not None and audience.segment not in SEGMENTS:
        problems.append(f"{audience.segment!r} is not an audience segment")
    if audience.current_plan is not None and (audience.current_plan not in known.plans or not known.plans[audience.current_plan][0]):
        problems.append(f"{audience.current_plan!r} is not a paid plan")
    if audience.listening is not None:
        rule = audience.listening
        if rule.artist_id not in known.artists:
            problems.append(f"artist {rule.artist_id} is not in the catalog")
        if not 1 <= rule.min_seconds <= LISTENING_SECONDS_MAX:
            problems.append(f"a listening rule counts between 1 second and {LISTENING_DAYS_MAX} days of listening")
        if not 1 <= rule.within_days <= LISTENING_DAYS_MAX:
            problems.append(f"a listening rule looks back between 1 and {LISTENING_DAYS_MAX} days")
    for what, entries in (("price", content.prices), ("period", content.periods), ("page", content.pages)):
        seen: set[str] = set()
        for entry in entries:
            if entry.market not in known.markets:
                problems.append(f"{entry.market!r} is not a market")
            if entry.market in seen:
                problems.append(f"two {what}s for {entry.market}")
            seen.add(entry.market)
    for price in content.prices:
        if (price.fixed is None) == (price.percent_off_bp is None):
            problems.append(f"the price in {price.market} is either a fixed amount or a percentage off")
        elif price.fixed is not None:
            if price.market in known.markets and price.fixed.currency != known.markets[price.market]:
                problems.append(f"a price in {price.market} is in {known.markets[price.market]}, not {price.fixed.currency}")
            if price.fixed.amount <= 0:
                problems.append(f"the price in {price.market} is more than zero")
        elif price.percent_off_bp is not None and not 1 <= price.percent_off_bp <= 9_999:
            problems.append(f"a percentage off in {price.market} is between 0.01% and 99.99%")
    for period in content.periods:
        if period.starts is None:
            problems.append(f"the period in {period.market} needs its start")
    for page in content.pages:
        _text(page.title, PAGE_TITLE_MAX, f"the page title in {page.market}", problems)
        _text(page.text, PAGE_TEXT_MAX, f"the page text in {page.market}", problems)
        _text(page.terms, PAGE_TERMS_MAX, f"the terms in {page.market}", problems)
        _text(page.treatment, TREATMENT_MAX, f"the treatment in {page.market}", problems)
    if not 0 <= content.months_at_offer_price <= MONTHS_MAX:
        problems.append(f"an offer lasts between 1 and {MONTHS_MAX} months at its price")
    if content.group is not None and not GROUP.match(content.group):
        problems.append("a non-combinability group is written in lower case, like student-offers")
    if content.redemption_cap < 0:
        problems.append("a cap on redemptions is zero (no cap) or more")
    return problems


def local_times(content: Content) -> list[tuple[str, datetime]]:
    """Every (market, local time) the version schedules, to check against the clocks."""
    if isinstance(content, ListPrice):
        return [(content.market, content.starts)] if content.market and content.starts else []
    if isinstance(content, PriceMigration):
        return [(content.market, moment) for moment in (content.notices, content.starts) if content.market and moment]
    found = []
    for period in content.periods:
        for moment in (period.starts, period.ends):
            if moment is not None:
                found.append((period.market, moment))
    return found


def _money(value: Money | None) -> dict | None:
    return None if value is None else {"amount": value.amount, "currency": value.currency}


def _local(value: datetime | None) -> str | None:
    return None if value is None else format_local(value)


def to_json(content: Content) -> dict:
    if isinstance(content, ListPrice):
        return {"schema": SCHEMA, "kind": "list_price", "title": content.title, "plan": content.plan,
                "market": content.market, "amount": _money(content.amount), "starts": _local(content.starts)}
    if isinstance(content, PriceMigration):
        return {"schema": SCHEMA, "kind": "price_migration", "title": content.title, "plan": content.plan,
                "market": content.market, "amount": _money(content.amount), "notices": _local(content.notices),
                "starts": _local(content.starts)}
    a = content.audience
    return {
        "schema": SCHEMA, "kind": "offer", "title": content.title, "plan": content.plan,
        "audience": {
            "segment": a.segment, "current_plan": a.current_plan, "needs_student_check": a.needs_student_check,
            "listening": None if a.listening is None else {
                "artist_id": a.listening.artist_id, "min_seconds": a.listening.min_seconds,
                "within_days": a.listening.within_days},
        },
        "prices": [{"market": p.market, "fixed": _money(p.fixed), "percent_off_bp": p.percent_off_bp}
                   for p in content.prices],
        "months_at_offer_price": content.months_at_offer_price,
        "periods": [{"market": p.market, "starts": _local(p.starts), "ends": _local(p.ends)} for p in content.periods],
        "group": content.group,
        "redemption_cap": content.redemption_cap,
        "pages": [{"market": p.market, "title": p.title, "text": p.text, "terms": p.terms, "treatment": p.treatment}
                  for p in content.pages],
    }


def _read_money(value: dict | None) -> Money | None:
    return None if value is None else Money(value["amount"], value["currency"])


def _read_local(value: str | None) -> datetime | None:
    return None if value is None else parse_local(value)


def from_json(data: Mapping) -> Content:
    if data.get("schema") != SCHEMA:
        raise ValueError(f"a version stored with schema {data.get('schema')!r}; this engine reads schema {SCHEMA}")
    if data["kind"] == "list_price":
        return ListPrice(title=data["title"], plan=data["plan"], market=data["market"],
                         amount=_read_money(data["amount"]), starts=_read_local(data["starts"]))
    if data["kind"] == "price_migration":
        return PriceMigration(title=data["title"], plan=data["plan"], market=data["market"],
                              amount=_read_money(data["amount"]), notices=_read_local(data["notices"]),
                              starts=_read_local(data["starts"]))
    if data["kind"] != "offer":
        raise ValueError(f"no content of kind {data['kind']!r}")
    a = data["audience"]
    rule = a["listening"]
    return Offer(
        title=data["title"], plan=data["plan"],
        audience=Audience(a["segment"], a["current_plan"], a["needs_student_check"],
                          None if rule is None else ListeningRule(rule["artist_id"], rule["min_seconds"], rule["within_days"])),
        prices=tuple(OfferPrice(p["market"], _read_money(p["fixed"]), p["percent_off_bp"]) for p in data["prices"]),
        months_at_offer_price=data["months_at_offer_price"],
        periods=tuple(OfferPeriod(p["market"], _read_local(p["starts"]), _read_local(p["ends"])) for p in data["periods"]),
        group=data["group"], redemption_cap=data["redemption_cap"],
        pages=tuple(OfferPage(p["market"], p["title"], p["text"], p["terms"], p["treatment"]) for p in data["pages"]),
    )
