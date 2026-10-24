"""What a subscription costs on a day, by the rules of its charges (business
book §4.3, §6.1): one rule for the account and for the console's home.

A subscription costs the price it was confirmed at until the months of its
offer are over; from the charge after them, the list price in force on that
charge's day, read at the start of the day (billing.py: the billing day, and
the charge the full price begins with). A subscription without an offer keeps
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


async def standing(tx: Connection, market: reference.Market, *, plan_id: str, price_minor: int, started_on: date,
                   billing_day: int, offer_months: int, day: date) -> Standing:
    own = Money(price_minor, market.currency)
    schedule = billing.schedule(started_on, billing_day, offer_months, day)
    if offer_months <= 0:
        return Standing(own, schedule, None)
    after = await full_price(tx, market, plan_id, schedule.full_price_from)
    return Standing(after if schedule.offer_months_left == 0 else own, schedule, after)
