"""Quotes (business book §4.5): the price is always the engine's.

A quote is worked out from the price list and the live catalog at the
engine's clock, saved with its expiry, and returned with where its money
goes. A quote for an offer that is not on sale (not yet started, over,
suspended, never published) is refused, and so is one for a person outside
the offer's audience. Without a subscriber, eligibility waits for the moment
they subscribe (stage 5).

Not yet checked, because nobody can take an offer before stage 5 records
subscriptions through the site: the cap on redemptions (§6.1), and one offer
per non-combinability group per subscriber (§10.3).
"""

from __future__ import annotations

import secrets
from datetime import timedelta

from commerce.domain.economics import Book
from commerce.domain import billing
from commerce.domain.localtime import format_instant, to_local
from commerce.domain.offers import Audience, ListeningRule
from commerce.domain.money import format_money
from commerce.domain.validation import on_sale, resolve_price
from commerce.engine import charging, contract, eligibility, reference
from commerce.engine.call import Call, Clock
from commerce.engine.catalog import LIVE_OFFER, Catalog, breakdown, list_price_at, live_offer, market_code, plan_id
from commerce.engine.database import Connection
from commerce.engine.errors import FailedPrecondition, InvalidArgument, NotFound, Refused
from commerce.v1 import quotes_pb2


def audience_of(stored: dict) -> Audience:
    rule = stored.get("listening")
    return Audience(stored.get("segment"), stored.get("current_plan"), bool(stored.get("needs_student_check")),
                    None if rule is None else ListeningRule(rule["artist_id"], rule["min_seconds"], rule["within_days"]))


class Quotes:
    def __init__(self, clock: Clock, book: Book, catalog: Catalog) -> None:
        self.clock = clock
        self.book = book
        self.catalog = catalog

    async def get_quote(self, tx: Connection, call: Call, request: quotes_pb2.GetQuoteRequest) -> quotes_pb2.GetQuoteResponse:
        code = market_code(request.market)
        plan_name = plan_id(request.plan)
        now = self.clock.now()
        ref = await reference.load(tx, now)
        market = ref.market(code)
        plan = ref.plan(plan_name)
        if not plan.paid:
            raise InvalidArgument(f"{plan.name} has no price to quote")
        local_now = to_local(now, market.zone)
        today = local_now.date()
        list_price = await list_price_at(tx, plan.id, market, local_now)
        if list_price is None:
            raise FailedPrecondition(f"no {plan.name} price is in force in {market.name}")

        subscriber = request.subscriber_id
        if subscriber:
            home = await tx.fetchval("select market from subscriber where id = $1", subscriber)
            if home is None:
                raise NotFound(f"no subscriber #{subscriber}")
            if home.strip() != market.code:
                raise Refused("NOT_ELIGIBLE", f"Subscriber #{subscriber} is in {ref.markets[home.strip()].name}, "
                                              f"and this quote is for {market.name}.", {"market": home.strip()})
            if plan.needs_student_check and not await eligibility.has_valid_student_check(tx, subscriber, today):
                raise Refused("NOT_ELIGIBLE", f"{plan.name} needs a valid student verification (§10).", {"check": "student"})

        offer = None
        if request.offer_id:
            snapshot = await self.catalog.publisher.live_snapshot(tx, now)
            row = None
            if snapshot is not None:
                row = await tx.fetchrow(LIVE_OFFER + " and o.change_id = $4", snapshot, market.code, format_instant(now),
                                        request.offer_id)
            if row is None:
                kind = await tx.fetchval("select kind from change where id = $1", request.offer_id)
                if kind != "offer":
                    raise NotFound(f"no offer #{request.offer_id}")
                raise Refused("QUOTE_EXPIRED", f"Offer #{request.offer_id} is not on sale in {market.name} now.",
                              {"offer_id": request.offer_id, "market": market.code})
            offer = live_offer(row)
            if offer.plan != plan.id:
                raise InvalidArgument(f"offer #{offer.change_id} sells {ref.plans[offer.plan].name}, not {plan.name}")
            price = resolve_price(offer.price_rule, list_price)
            if price.amount <= 0:
                raise Refused("QUOTE_EXPIRED", f"Offer #{offer.change_id} comes to {format_money(price)} in {market.name}: "
                                               "an offer with no price is not on sale.", {"offer_id": offer.change_id})
            if not on_sale(price, list_price):
                raise Refused("QUOTE_EXPIRED", f"Offer #{offer.change_id} no longer costs less than the list price in "
                                               f"{market.name}.", {"offer_id": offer.change_id})
            if subscriber and not await eligibility.includes(tx, audience_of(offer.audience), market.code, today, subscriber):
                raise Refused("NOT_ELIGIBLE", f"Subscriber #{subscriber} is not among {offer.audience_words.lower()}.",
                              {"offer_id": offer.change_id, "audience": offer.audience_words})
            months = offer.months
            # The list price the account will charge after the offer's months: from the charge that ends them, on
            # the billing day of a subscription starting today, read as that day begins (charging.py).
            ends = billing.billing_date(today, billing.billing_day_for(today), months)
            then = await charging.full_price(tx, market, plan.id, ends)
        else:
            price, months, then = list_price, 0, list_price

        quote_id = f"q_{secrets.token_hex(16)}"
        expires = now + timedelta(seconds=self.book.quote_validity_seconds)
        await tx.execute(
            "insert into quote (id, created_at, expires_at, market, currency, plan_id, price_minor, list_price_minor, "
            "months_at_price, then_price_minor, offer_change_id, offer_version, snapshot_id, subscriber_id, request_id) "
            "values ($1, $2::text::timestamptz, $3::text::timestamptz, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
            quote_id, format_instant(now), format_instant(expires), market.code, market.currency, plan.id, price.amount,
            list_price.amount, months, then.amount, offer.change_id if offer else None, offer.version if offer else None,
            offer.snapshot_id if offer else None, subscriber or None, call.request_id)
        return quotes_pb2.GetQuoteResponse(quote=quotes_pb2.Quote(
            quote_id=quote_id, plan=plan.id, market=market.code, price=contract.money(price),
            list_price=contract.money(list_price), months_at_price=months, then_price=contract.money(then),
            expires_at=format_instant(expires), offer_id=offer.change_id if offer else 0,
            breakdown=breakdown(self.book, market, price.amount)))
