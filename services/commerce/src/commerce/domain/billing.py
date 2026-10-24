"""When a subscription is charged, and at which price (business book §4.3,
§6.1, §14.1).

A subscription is charged on the day it starts, then once a month on its
billing day, in the market's calendar. A subscription confirmed on day D has
the billing day of D, or the 28th when D is later in the month, so that every
month has it. An offer prices the first charges, as many as its months; from
the charge after them the list price in force at that time applies.

The Student Autumn Pass confirmed on 26 October 2026: €2.99 on 26 October,
26 November and 26 December, then the list price from 26 January 2027.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

LAST_BILLING_DAY = 28


def billing_day_for(start: date) -> int:
    return min(start.day, LAST_BILLING_DAY)


def billing_date(start: date, billing_day: int, charge: int) -> date:
    """The date of a charge: the 0th on the start, the k-th on the billing day k months later."""
    if not 1 <= billing_day <= LAST_BILLING_DAY:
        raise ValueError(f"a billing day is between 1 and {LAST_BILLING_DAY}")
    if charge < 0:
        raise ValueError("charges are counted from 0")
    if charge == 0:
        return start
    index = start.month - 1 + charge
    return date(start.year + index // 12, index % 12 + 1, billing_day)


def charges_by(start: date, billing_day: int, day: date) -> int:
    """How many charges have fallen on or before a day."""
    if day < start:
        return 0
    months = (day.year - start.year) * 12 + day.month - start.month
    count = max(1, months - 1)
    while billing_date(start, billing_day, count) <= day:
        count += 1
    while count > 1 and billing_date(start, billing_day, count - 1) > day:
        count -= 1
    return count


@dataclass(frozen=True)
class Schedule:
    next_billing_on: date
    next_at_offer_price: bool
    offer_months_left: int  # the current month included
    full_price_from: date | None


def schedule(start: date, billing_day: int, offer_months: int, day: date) -> Schedule:
    """Where a subscription stands on a day: its next charge, and its offer's months."""
    made = charges_by(start, billing_day, day)
    nxt = billing_date(start, billing_day, made)
    if offer_months <= 0:
        return Schedule(nxt, False, 0, None)
    left = max(0, offer_months - made + 1) if made >= 1 else offer_months
    return Schedule(nxt, made < offer_months, left, billing_date(start, billing_day, offer_months))
