"""What a subscription costs on a day, by the rules of its charges (business
book §4.3, §6.1): one rule for the account and for the console's home.

A subscription's price is a history (migrations V12 and V14): the price it
started at, and any price that took over later, each from its own day (a
price migration, §8). A subscription is written with the first row of its
history, in the same transaction (write_subscription). On a day it costs
the latest price of its history from that day or before. An offer prices
the first charges, as many as its months; from the charge after them, the
price its quote named for then (§4.5: the list price in force when that
charge's day begins, as the price list stood when the offer was taken),
unless a later price of the history took over by then; and once a price
migration asked the subscription, the price before the migration until its
new price took over, never the new one before (§8). A change of the price
list reaches it only through a migration that asks or tells it: one that
left it for later (§8.9) does not. A subscription without an offer keeps
its price until a price migration moves it (§4.3).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time

from commerce.domain import billing
from commerce.domain.money import Money
from commerce.engine import reference
from commerce.engine.catalog import list_price_at
from commerce.engine.database import Connection
from commerce.engine.errors import FailedPrecondition


@dataclass(frozen=True)
class Standing:
    price: Money  # what each month costs on the day
    schedule: billing.Schedule
    full_price: Money | None  # the list price after the offer's months; None without an offer


async def full_price(tx: Connection, market: reference.Market, plan_id: str, full_price_from: date) -> Money:
    """The list price a subscription pays from the end of its offer: the one in force when that day begins."""
    price = await list_price_at(tx, plan_id, market, datetime.combine(full_price_from, time.min))
    if price is None:
        raise FailedPrecondition(f"no {plan_id} price is in force in {market.name} on {full_price_from.isoformat()}")
    return price


async def write_subscription(tx: Connection, market: reference.Market, *, subscriber_id: int, plan_id: str, paid: bool,
                             price: Money, started_on: date, billing_day: int, quote_id: str | None = None,
                             offer_change_id: int | None = None, offer_months: int | None = None,
                             prepaid_code: str | None = None, ended_on: date | None = None) -> int:
    """A subscription and the price it starts at, the first row of its history: the database checks, when the
    transaction commits, that no subscription is without it (migration V14). A prepaid pass's costs nothing by the
    month (V15)."""
    subscription_id = await tx.fetchval(
        "insert into subscription (id, subscriber_id, market, currency, plan_id, paid, started_on, ended_on, billing_day, "
        "quote_id, offer_change_id, offer_months, prepaid_code) values (nextval('subscription_id_seq'), $1, $2, $3, $4, $5, "
        "$6::text::date, $7::text::date, $8, $9, $10, $11, $12) returning id",
        subscriber_id, market.code, market.currency, plan_id, paid, started_on.isoformat(),
        ended_on.isoformat() if ended_on else None, billing_day, quote_id, offer_change_id, offer_months, prepaid_code)
    await tx.execute("insert into subscription_price (subscription_id, from_on, price_minor) values ($1, $2::text::date, $3)",
                     subscription_id, started_on.isoformat(), price.amount)
    return subscription_id


async def write_free_subscription(tx: Connection, market: reference.Market, *, subscriber_id: int, started_on: date) -> int:
    """The subscription of the plan a subscriber is on without paying, from a day: the business's one unpaid plan
    (migration V17), Free for the music service, whatever its name elsewhere."""
    plan = await tx.fetchval("select id from plan where not paid")
    if plan is None:
        raise FailedPrecondition("this business has no plan to be on without paying")
    return await write_subscription(tx, market, subscriber_id=subscriber_id, plan_id=plan, paid=False,
                                    price=Money.zero(market.currency), started_on=started_on,
                                    billing_day=billing.billing_day_for(started_on))


# The price after an offer a subscription keeps, as an expression: the price before the last price migration that
# asked it, until the new price takes over in its history, from the day it applies, if it ever does (never inside
# the offer's months); or else the price its quote named for then (§4.5). Null for a subscription written without a
# quote, which pays the list price in force then (full_price).
KEPT = ("coalesce((select r.old_price_minor from price_change_request r where r.subscription_id = {subscription} "
        "order by r.id desc limit 1), (select q.then_price_minor from subscription k join quote q on q.id = k.quote_id "
        "where k.id = {subscription}))")


async def price_of(tx: Connection, subscription_id: int, day: date) -> tuple[int, date]:
    """The price of the history in force on a day, and the day it took over."""
    row = await tx.fetchrow(
        "select price_minor, from_on::text as from_on from subscription_price where subscription_id = $1 "
        "and from_on <= $2::text::date order by from_on desc limit 1", subscription_id, day.isoformat())
    if row is None:
        raise FailedPrecondition(f"subscription #{subscription_id} has no price on {day.isoformat()}")
    return row["price_minor"], date.fromisoformat(row["from_on"])


def standing_from(price: Money, price_from: date, *, started_on: date, billing_day: int, offer_months: int, day: date,
                  after_offer: Money | None) -> Standing:
    """The rule itself: the price of the history in force on the day (price, from price_from), or the
    list price after the offer's months (after_offer) when no later price of the history took over."""
    schedule = billing.schedule(started_on, billing_day, offer_months, day)
    if offer_months <= 0:
        return Standing(price, schedule, None)
    assert after_offer is not None
    over = schedule.offer_months_left == 0 and price_from < schedule.full_price_from
    return Standing(after_offer if over else price, schedule, after_offer)


async def standing(tx: Connection, market: reference.Market, *, subscription_id: int, plan_id: str, started_on: date,
                   billing_day: int, offer_months: int, day: date) -> Standing:
    amount, price_from = await price_of(tx, subscription_id, day)
    after = None
    if offer_months > 0:
        kept = await tx.fetchval(f"select {KEPT.format(subscription='$1')}", subscription_id)
        after = (Money(kept, market.currency) if kept is not None else
                 await full_price(tx, market, plan_id, billing.schedule(started_on, billing_day, offer_months, day).full_price_from))
    return standing_from(Money(amount, market.currency), price_from, started_on=started_on, billing_day=billing_day,
                         offer_months=offer_months, day=day, after_offer=after)
