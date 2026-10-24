"""A second company, in tests only (business book §14.7): Quillbase, an
invented maker of shared notebooks for teams, sells seat-based plans in the
same four markets, through the same flows as the music service: an offer
written by marketing, signed, scheduled and launched; a quote; a
subscription, its payment through the outbox, and the account; the home.

Nothing here is music: no artists, so no pool and no minimum to pay them,
and no floor; a free plan called Starter rather than Free; plans of 5 and 25
seats. The engine is the same, given the company's book."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

import asyncpg
import pytest_asyncio

from commerce.domain.economics import Book
from commerce.engine.providers import FAILED, ChargeResult, ProviderEvent
from commerce.v1 import catalog_pb2, changes_pb2, overview_pb2, quotes_pb2, subscriptions_pb2
from conftest import ADMIN_URL, APP_URL, TEMPLATE, _admin, on_database
from engine_support import FINANCE, MARKETING, PUBLIC, World, apply, eur, scheduled, student_autumn
from helpers import T0, add_people, add_subscription, sqlstate_of

# A software company pays no artists: no pool, no minimum, so no floor (§5 is the music service's).
SOFTWARE = Book(pool_share_bp=0, minimum={"EUR": 0, "GBP": 0})
PLANS = [("starter", "Starter", False, 1), ("team", "Team", True, 5), ("business", "Business", True, 25)]
PRICES = {"IT": {"team": 4_900, "business": 19_900}, "DE": {"team": 4_900, "business": 19_900},
          "FR": {"team": 4_900, "business": 19_900}, "GB": {"team": 4_200, "business": 16_900}}
CURRENCY = {"IT": "EUR", "DE": "EUR", "FR": "EUR", "GB": "GBP"}
# customer: market, joined
CUSTOMERS = {11: ("IT", date(2026, 3, 2)), 12: ("IT", date(2026, 5, 4)), 21: ("DE", date(2026, 2, 9)),
             22: ("DE", date(2026, 6, 1))}


@pytest_asyncio.fixture
async def company():
    """A database of its own with Quillbase's plans, prices, people and customers, and the engine on it with its book."""
    from commerce.adapters.asyncpg_database import AsyncpgDatabase
    from commerce.engine.call import FixedClock
    from commerce.engine.engine import Engine

    name = f"quill_{uuid.uuid4().hex[:16]}"
    await _admin(f"create database {name} template {TEMPLATE}")
    owner = await asyncpg.connect(on_database(ADMIN_URL, name))
    try:
        # The migrations bring the music service's plans; this company has its own.
        await owner.execute("delete from plan")
        for plan, title, paid, seats in PLANS:
            await owner.execute("insert into plan (id, name, paid, seats) values ($1, $2, $3, $4)", plan, title, paid, seats)
        for market, prices in PRICES.items():
            for plan, amount in prices.items():
                await owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                                    "values ($1, $2, $3, $4, tsrange('2025-01-01', null))", plan, market, CURRENCY[market], amount)
        await add_people(owner)
        for customer, (market, joined) in CUSTOMERS.items():
            await owner.execute("insert into subscriber (id, market, joined_on) values ($1, $2, $3)", customer, market, joined)
            await add_subscription(owner, customer, market, "starter", 0, joined, subscription=customer)
    except BaseException:
        await owner.close()
        await _admin(f"drop database {name} with (force)")
        raise
    database = await AsyncpgDatabase.connect(APP_URL.format(database=name), max_size=8)
    clock = FixedClock(T0)
    try:
        yield World(name, owner, Engine(database, clock, SOFTWARE), clock)
    finally:
        await database.close()
        await owner.close()
        await _admin(f"drop database {name} with (force)")


def founders_quarter(**changes) -> changes_pb2.OfferContent:
    """Three months of Team at €29 for new customers in Italy and Germany, from 2 November 2026."""
    content = student_autumn(
        title="Founders' quarter", plan="team",
        audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_NEVER_PAID),
        prices=[changes_pb2.OfferPrice(market="IT", fixed=eur(2_900)), changes_pb2.OfferPrice(market="DE", fixed=eur(2_900))],
        months_at_offer_price=3,
        periods=[changes_pb2.OfferPeriod(market="IT", starts_local="2026-11-02T09:00", ends_local="2026-12-01T00:00"),
                 changes_pb2.OfferPeriod(market="DE", starts_local="2026-11-02T09:00", ends_local="2026-12-01T00:00")],
        non_combinability_group="launch-offers",
        pages=[changes_pb2.OfferPage(market=m, title="Founders' quarter", text="Three months of Team for €29.",
                                     terms="New customers only.") for m in ("IT", "DE")])
    return apply(content, changes)


def at(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


async def test_the_same_flows_serve_a_software_company(company):
    world = company
    plans = (await world.call("ListPlans", catalog_pb2.ListPlansRequest(market="IT"), PUBLIC)).plans
    assert [(p.id, p.entitlements.seats, p.list_price.amount_minor) for p in plans] == [("starter", 1, 0), ("team", 5, 4_900),
                                                                           ("business", 25, 19_900)]
    change = await scheduled(world, founders_quarter(), MARKETING, FINANCE)
    assert "artists" not in change.sentence and "floor" not in change.sentence
    world.clock.at = at(2026, 11, 2, 7, 59, 30)  # 08:59:30 in Rome and Berlin
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    world.clock.at = at(2026, 11, 3, 9, 0)
    quote = (await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="team", market="IT", offer_id=change.id,
                                                                     subscriber_id=11), PUBLIC)).quote
    assert (quote.price, quote.months_at_price, quote.then_price) == (eur(2_900), 3, eur(4_900))
    confirmed = (await world.call("ConfirmQuote", subscriptions_pb2.ConfirmQuoteRequest(quote_id=quote.quote_id,
                                                                                       subscriber_id=11), PUBLIC)).confirmation
    assert (confirmed.subscription.plan, confirmed.subscription.price) == ("team", eur(2_900))
    await world.engine.deliver_outbox()
    account = (await world.call("GetAccount", subscriptions_pb2.GetAccountRequest(subscriber_id=11), PUBLIC)).account
    assert account.payment.state == subscriptions_pb2.PAYMENT_STATE_SUCCEEDED and account.payment.receipt.demonstration
    assert (account.subscription.full_price_from, account.subscription.full_price) == ("2027-02-03", eur(4_900))
    home = await world.call("GetOverview", overview_pb2.GetOverviewRequest(), FINANCE)
    assert home.monthly_top_ups.amount_minor == 0  # nobody to top up: no artists
    [italy] = [r for r in home.monthly_revenue if r.market == "IT"]
    assert italy.revenue == eur(2_377)  # €29.00 without Italian VAT


async def test_a_declined_payment_takes_the_customer_back_to_the_company_s_own_free_plan(company, monkeypatch):
    world = company

    async def decline(charge):
        event = ProviderEvent("simulated", "evt_quill_declined_1", FAILED, charge.payment_id, "sim-pay-declined",
                              world.clock.now(), "The card was declined.")
        return ChargeResult("simulated", "sim-pay-declined", (event,))

    monkeypatch.setattr(world.engine.payments, "charge", decline)
    quote = (await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="business", market="DE", subscriber_id=21),
                              PUBLIC)).quote
    assert quote.price == eur(19_900)
    await world.call("ConfirmQuote", subscriptions_pb2.ConfirmQuoteRequest(quote_id=quote.quote_id, subscriber_id=21), PUBLIC)
    await world.engine.deliver_outbox()
    history = await world.owner.fetch("select plan_id, started_on::text, ended_on::text from subscription "
                                      "where subscriber_id = 21 order by started_on, id")
    assert [tuple(r) for r in history] == [("starter", "2026-02-09", "2026-10-24"), ("business", "2026-10-24", "2026-10-25"),
                                           ("starter", "2026-10-25", None)]


async def test_a_business_has_one_free_plan_at_most_and_plans_of_many_seats(company):
    world = company
    assert await sqlstate_of(world.owner.execute(
        "insert into plan (id, name, paid, seats) values ('trial', 'Trial', false, 1)")) == "23505"
    await world.owner.execute("insert into plan (id, name, paid, seats) values ('enterprise', 'Enterprise', true, 500)")
    assert await sqlstate_of(world.owner.execute(
        "insert into plan (id, name, paid, seats) values ('campus', 'Campus', true, 5000)")) == "23514"
