"""What a subscription costs on a day, by the rules of its charges (business
book §4.3, §6.1): one rule for the account and for the console's home.

A subscription's price is a history (migration V12): the price it started
at, and any price that took over later, each from its own day (a price
migration, §8). On a day it costs the latest price of its history from that
day or before. An offer prices the first charges, as many as its months;
from the charge after them, the list price in force when that charge's day
begins (billing.py), unless a later price of the history took over by then;
and once a price migration asked the subscription, the price before the
migration until its new price took over, never the new one before (§8).
A subscription without an offer keeps its price until a price migration
moves it (§4.3).
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


# The price after an offer of a subscription that a price migration asked: the price before the migration, until the
# new price takes over in its history, from the day it applies, if it ever does (never inside the offer's months).
KEPT = ("select old_price_minor from price_change_request where subscription_id = {subscription} "
        "order by id desc limit 1")


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
        kept = await tx.fetchval(KEPT.format(subscription="$1"), subscription_id)
        after = (Money(kept, market.currency) if kept is not None else
                 await full_price(tx, market, plan_id, billing.schedule(started_on, billing_day, offer_months, day).full_price_from))
    return standing_from(Money(amount, market.currency), price_from, started_on=started_on, billing_day=billing_day,
                         offer_months=offer_months, day=day, after_offer=after)
