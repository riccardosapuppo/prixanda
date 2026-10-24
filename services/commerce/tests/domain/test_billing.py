"""When a subscription is charged and at which price (business book §4.3,
§6.1, §14.1)."""

from __future__ import annotations

from datetime import date

import pytest

from commerce.domain.billing import billing_date, billing_day_for, charges_by, schedule


def test_the_billing_day_is_the_start_s_or_the_28th():
    assert [billing_day_for(date(2026, 10, d)) for d in (1, 26, 28, 29, 31)] == [1, 26, 28, 28, 28]


def test_charges_fall_on_the_start_then_monthly_on_the_billing_day():
    start = date(2026, 10, 26)
    assert [billing_date(start, 26, k) for k in range(4)] == [
        date(2026, 10, 26), date(2026, 11, 26), date(2026, 12, 26), date(2027, 1, 26)]
    end_of_month = date(2027, 1, 31)
    assert [billing_date(end_of_month, 28, k) for k in range(3)] == [date(2027, 1, 31), date(2027, 2, 28), date(2027, 3, 28)]


def test_a_billing_day_or_a_charge_that_cannot_be():
    with pytest.raises(ValueError):
        billing_date(date(2026, 10, 26), 29, 1)
    with pytest.raises(ValueError):
        billing_date(date(2026, 10, 26), 26, -1)


@pytest.mark.parametrize(("day", "made"), [
    (date(2026, 10, 25), 0), (date(2026, 10, 26), 1), (date(2026, 11, 25), 1), (date(2026, 11, 26), 2),
    (date(2027, 1, 25), 3), (date(2027, 1, 26), 4), (date(2028, 10, 26), 25),
])
def test_charges_made_by_a_day(day, made):
    assert charges_by(date(2026, 10, 26), 26, day) == made


@pytest.mark.parametrize(("day", "left", "next_on", "at_offer"), [
    (date(2026, 10, 26), 3, date(2026, 11, 26), True),
    (date(2026, 11, 30), 2, date(2026, 12, 26), True),
    (date(2026, 12, 26), 1, date(2027, 1, 26), False),
    (date(2027, 1, 26), 0, date(2027, 2, 26), False),
])
def test_the_student_autumn_pass_month_by_month(day, left, next_on, at_offer):
    plan = schedule(date(2026, 10, 26), 26, 3, day)
    assert (plan.offer_months_left, plan.next_billing_on, plan.next_at_offer_price) == (left, next_on, at_offer)
    assert plan.full_price_from == date(2027, 1, 26)


def test_a_subscription_at_the_list_price_has_no_offer_months():
    plan = schedule(date(2026, 3, 1), 10, 0, date(2026, 10, 24))
    assert (plan.offer_months_left, plan.full_price_from, plan.next_billing_on) == (0, None, date(2026, 11, 10))
