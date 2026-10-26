"""Prepaid passes (business book §9, §14.4): months of a plan paid in
advance, sold as a single-use code that can be given as a gift.

A code can be activated until the day before the same date as its sale,
its months of validity later. Its net amount (the price without VAT)
is earned in equal monthly parts from its activation, the last part taking
the remainder (§9.2), on the activation day and then on the same day of each
following month, as a subscription is charged (billing.py). A code paid for
and not activated stays unearned until it expires; an expired code's value
is no longer unearned, and the platform does no accounting beyond that
(§15). A failed or pending payment sold nothing yet.

What a code paid for is on a day follows from its dates, as the activation
and the expiry go by them: activated from the day it was activated, expired
once its last day has passed without that (state_on). So a day before an
activation or an expiry reads the code as it stood then.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date, timedelta

from commerce.domain import billing
from commerce.domain.economics import recognize_monthly

# Codes are written for people: no 0 or O, no 1, I or L.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CODE = re.compile(r"^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$")


def normal_code(text: str) -> str:
    """A code as people type it, in the form it is kept in: upper case, groups of four joined by dashes."""
    letters = "".join(ch for ch in text.upper() if ch.isalnum())
    return "-".join(letters[i:i + 4] for i in range(0, len(letters), 4))


def valid_until(sold_on: date, months: int) -> date:
    """The last day a code sold on a day can be activated: the day before the same date, months later (sold on
    24 October 2026, for 12 months: until 23 October 2027). A date the later month lacks is its last day (sold on
    31 October, for 4 months: until 27 February)."""
    if months < 1:
        raise ValueError("a code can be activated for a month at least")
    index = sold_on.month - 1 + months
    year, month = sold_on.year + index // 12, index % 12 + 1
    return date(year, month, min(sold_on.day, calendar.monthrange(year, month)[1])) - timedelta(days=1)


def pass_ends(activated_on: date, months: int) -> date:
    """The first day after a pass activated on a day: its months later, as a subscription's charges fall."""
    return billing.billing_date(activated_on, billing.billing_day_for(activated_on), months)


def earned(net: int, months: int, activated_on: date | None, day: date) -> int:
    """What a pass has earned by the end of a day: its monthly parts from the day it was activated."""
    if activated_on is None or day < activated_on:
        return 0
    parts = recognize_monthly(net, months)
    start, billing_day = activated_on, billing.billing_day_for(activated_on)
    return sum(part for k, part in enumerate(parts) if billing.billing_date(start, billing_day, k) <= day)


def state_on(day: date, *, valid_until: date, activated_on: date | None) -> str:
    """What a code paid for is on a day of its market: activated from the day it was activated, expired from the day
    after its last day if it was not activated by then, and ready before either. A code is activated by its last day
    or never, so one activated after the day was ready on it."""
    if activated_on is not None and activated_on <= day:
        return "activated"
    return "expired" if valid_until < day else "ready"


@dataclass(frozen=True)
class Sold:
    """A code paid for, as finance counts it on a day: its state that day (state_on)."""

    net: int
    months: int
    state: str  # ready, activated or expired
    activated_on: date | None = None


@dataclass(frozen=True)
class Value:
    sold: int
    activated: int
    expired: int
    unearned: int


def value(codes: list[Sold], day: date) -> Value:
    """The codes of a market on a day: how many were paid for, activated and expired, and the net value not yet
    earned. 1,240 Italian codes at €24.58 net, 860 of them activated and each in its first month, leave
    €23,435.80 unearned: 380 × 24.58 + 860 × (24.58 − 8.19)."""
    unearned = 0
    for code in codes:
        if code.state == "ready":
            unearned += code.net
        elif code.state == "activated":
            unearned += code.net - earned(code.net, code.months, code.activated_on, day)
        elif code.state != "expired":
            raise ValueError(f"a code {code.state} was not sold")
    return Value(len(codes), sum(1 for c in codes if c.state == "activated"), sum(1 for c in codes if c.state == "expired"),
                 unearned)
