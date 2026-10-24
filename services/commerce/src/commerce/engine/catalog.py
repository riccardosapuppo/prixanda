"""What is sold (business book §2 to §6.2): markets, plans with their prices,
the price list, and the offers the published catalog holds.

The site shows an offer if and only if its prices are in force (§7.5): an
offer is listed when it is in the live snapshot, its period in that market
contains the instant, and its price, worked out from the list price in force
at that instant (§6.2), is below that list price.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime

from commerce.domain.economics import Book
from commerce.domain.localtime import format_instant, format_local, parse_local, to_local
from commerce.domain.money import Money
from commerce.domain.offers import OfferPrice
from commerce.domain.validation import resolve_price
from commerce.engine import contract, reference
from commerce.engine.call import Call, Clock
from commerce.engine.database import Connection, local_text, utc_text
from commerce.engine.errors import InvalidArgument, NotFound
from commerce.engine.publication import Publisher
from commerce.v1 import catalog_pb2, common_pb2

CODE = re.compile(r"^[A-Z]{2}$")
PLAN = re.compile(r"^[a-z][a-z0-9-]{0,30}$")


def market_code(text: str, *, required: bool = True) -> str | None:
    if not text:
        if required:
            raise InvalidArgument("name the market: IT, FR, DE or GB")
        return None
    if not CODE.match(text):
        raise InvalidArgument(f"{text!r} is not a market code")
    return text


def plan_id(text: str, *, required: bool = True) -> str | None:
    if not text:
        if required:
            raise InvalidArgument("name the plan")
        return None
    if not PLAN.match(text):
        raise InvalidArgument(f"{text!r} is not a plan")
    return text


def breakdown(book: Book, market: reference.Market, price: int) -> catalog_pb2.PriceBreakdown:
    b = market.terms(book).breakdown(price)
    m = lambda amount: common_pb2.Money(amount_minor=amount, currency=market.currency)  # noqa: E731
    return catalog_pb2.PriceBreakdown(price=m(b.price), vat=m(b.vat), net=m(b.net), artists=m(b.artists),
                                      top_up=m(b.top_up), payment_costs=m(b.payment_costs), encore_keeps=m(b.keeps))


async def list_price_at(tx: Connection, plan: str, market: reference.Market, local: datetime) -> Money | None:
    amount = await tx.fetchval(
        "select amount_minor from list_price where plan_id = $1 and market = $2 and valid @> $3::text::timestamp",
        plan, market.code, format_local(local))
    return None if amount is None else Money(amount, market.currency)


@dataclass(frozen=True)
class LiveOffer:
    change_id: int
    version: int
    market: str
    plan: str
    price_rule: OfferPrice
    months: int
    starts_at: str
    ends_at: str | None
    ends_local: str | None
    title: str
    body: str
    terms: str
    audience: dict
    audience_words: str
    needs_student_check: bool
    snapshot_id: int


LIVE_OFFER = (
    "select o.change_id, o.version, o.market, o.plan_id, o.currency, o.fixed_minor, o.percent_off_bp, o.months, "
    f"{utc_text('o.starts_at')} as starts_at, {utc_text('o.ends_at')} as ends_at, {local_text('o.ends_local')} as ends_local, "
    "o.title, o.body, o.terms, o.audience::text as audience, o.audience_words, o.needs_student_check, o.snapshot_id "
    "from catalog_offer o where o.snapshot_id = $1 and o.market = $2 "
    "and o.starts_at <= $3::text::timestamptz and (o.ends_at is null or $3::text::timestamptz < o.ends_at)")


def live_offer(row) -> LiveOffer:
    fixed = Money(row["fixed_minor"], row["currency"]) if row["fixed_minor"] is not None else None
    return LiveOffer(row["change_id"], row["version"], row["market"], row["plan_id"],
                     OfferPrice(row["market"], fixed, row["percent_off_bp"]), row["months"], row["starts_at"],
                     row["ends_at"], row["ends_local"], row["title"], row["body"], row["terms"], json.loads(row["audience"]),
                     row["audience_words"], row["needs_student_check"], row["snapshot_id"])


class Catalog:
    def __init__(self, clock: Clock, book: Book, publisher: Publisher) -> None:
        self.clock = clock
        self.book = book
        self.publisher = publisher

    def _at(self, text: str) -> datetime:
        return contract.instant_from_proto(text, "at") or self.clock.now()

    async def list_markets(self, tx: Connection, call: Call, request: catalog_pb2.ListMarketsRequest) -> catalog_pb2.ListMarketsResponse:
        ref = await reference.load(tx, self.clock.now())
        markets = []
        for m in ref.markets.values():
            terms = m.terms(self.book)
            markets.append(catalog_pb2.Market(
                code=m.code, name=m.name, currency=m.currency, minor_units=m.minor_units, time_zone=m.zone, vat_bp=m.vat_bp,
                artists_minimum=contract.money(Money(terms.minimum, m.currency)),
                floor=contract.money(Money(terms.floor(), m.currency))))
        return catalog_pb2.ListMarketsResponse(markets=markets)

    async def list_plans(self, tx: Connection, call: Call, request: catalog_pb2.ListPlansRequest) -> catalog_pb2.ListPlansResponse:
        code = market_code(request.market)
        at = self._at(request.at)
        ref = await reference.load(tx, at)
        market = ref.market(code)
        local = format_local(to_local(at, market.zone))
        rows = await tx.fetch(
            "select p.id, p.name, p.paid, p.seats, p.needs_student_check, e.skips_per_hour, e.audio, e.offline, lp.amount_minor "
            "from plan p left join plan_entitlement e on e.plan_id = p.id and e.market = $1 and e.valid @> $2::text::timestamp "
            "left join list_price lp on lp.plan_id = p.id and lp.market = $1 and lp.valid @> $2::text::timestamp "
            f"order by {reference.PLAN_ORDER}", code, local)
        plans = []
        for row in rows:
            if row["audio"] is None or (row["paid"] and row["amount_minor"] is None):
                continue  # not on sale in this market at that instant
            plan = catalog_pb2.Plan(
                id=row["id"], name=row["name"], paid=row["paid"],
                entitlements=catalog_pb2.Entitlements(
                    skips_per_hour=row["skips_per_hour"] or 0, audio=row["audio"], offline=row["offline"],
                    seats=row["seats"], needs_student_check=row["needs_student_check"]))
            if row["paid"]:
                plan.list_price.CopyFrom(contract.money(Money(row["amount_minor"], market.currency)))
                plan.breakdown.CopyFrom(breakdown(self.book, market, row["amount_minor"]))
            plans.append(plan)
        return catalog_pb2.ListPlansResponse(plans=plans)

    async def get_price_list(self, tx: Connection, call: Call, request: catalog_pb2.GetPriceListRequest) -> catalog_pb2.GetPriceListResponse:
        code = market_code(request.market, required=False)
        plan = plan_id(request.plan, required=False)
        ref = await reference.load(tx, self.clock.now())
        if code is not None:
            ref.market(code)
        if plan is not None:
            ref.plan(plan)
        rows = await tx.fetch(
            "select lp.id, lp.plan_id, lp.market, lp.currency, lp.amount_minor, lp.change_id, "
            f"{local_text('lower(lp.valid)')} as valid_from, {local_text('upper(lp.valid)')} as valid_until, "
            "(select v.rate_bp from vat_rate v where v.market = lp.market and v.valid @> lower(lp.valid)::date) as vat_bp "
            "from list_price lp where ($1::text is null or lp.market = $1) and ($2::text is null or lp.plan_id = $2) "
            "order by lp.market, lp.plan_id, lower(lp.valid)", code, plan)
        entries = []
        for row in rows:
            market = ref.markets[row["market"].strip()]
            terms = self.book.terms(market.currency, row["vat_bp"] if row["vat_bp"] is not None else market.vat_bp)
            amount = row["amount_minor"]
            entries.append(catalog_pb2.PriceListEntry(
                id=row["id"], plan=row["plan_id"], market=market.code,
                amount=contract.money(Money(amount, market.currency)),
                valid_from_local=format_local(parse_local(row["valid_from"])),
                valid_until_local=format_local(parse_local(row["valid_until"])) if row["valid_until"] else "",
                change_id=row["change_id"] or 0, below_floor=amount < terms.floor(),
                top_up=contract.money(Money(terms.top_up(terms.net(amount)), market.currency))))
        return catalog_pb2.GetPriceListResponse(entries=entries)

    async def live_offers(self, tx: Connection, market: reference.Market, at: datetime) -> list[tuple[LiveOffer, Money, Money]]:
        """The offers the site may show at an instant, each with its price and the list price, both in force."""
        snapshot = await self.publisher.live_snapshot(tx, at)
        if snapshot is None:
            return []
        local = to_local(at, market.zone)
        found = []
        for row in await tx.fetch(LIVE_OFFER + " order by o.starts_at, o.change_id", snapshot, market.code, format_instant(at)):
            offer = live_offer(row)
            list_price = await list_price_at(tx, offer.plan, market, local)
            if list_price is None:
                continue
            price = resolve_price(offer.price_rule, list_price)
            if price < list_price:
                found.append((offer, price, list_price))
        return found

    async def list_offers(self, tx: Connection, call: Call, request: catalog_pb2.ListOffersRequest) -> catalog_pb2.ListOffersResponse:
        code = market_code(request.market)
        at = self._at(request.at)
        ref = await reference.load(tx, at)
        market = ref.market(code)
        offers = []
        for offer, price, list_price in await self.live_offers(tx, market, at):
            published = catalog_pb2.PublishedOffer(
                offer_id=offer.change_id, version=offer.version, market=offer.market, plan=offer.plan, title=offer.title,
                text=offer.body, terms=offer.terms, price=contract.money(price), list_price=contract.money(list_price),
                months_at_offer_price=offer.months, audience=offer.audience_words,
                needs_student_check=offer.needs_student_check)
            if offer.ends_at is not None:
                published.takeable_until.CopyFrom(common_pb2.LocalTime(
                    market=offer.market, local=format_local(parse_local(offer.ends_local)), utc=format_instant_text(offer.ends_at)))
            offers.append(published)
        return catalog_pb2.ListOffersResponse(offers=offers)


def format_instant_text(text: str) -> str:
    return format_instant(datetime.fromisoformat(text.replace("Z", "+00:00")))
