"""Properties of the billing schedule over many generated subscriptions and
days (business book §4.3, §6.1): the next charge is always after the day and
the last one on or before it, and the offer's months run out exactly at the
day the full price applies."""

from __future__ import annotations

from datetime import date, timedelta

from hypothesis import given
from hypothesis import strategies as st

from commerce.domain.billing import billing_date, billing_day_for, charges_by, schedule

starts = st.integers(0, 3 * 365).map(lambda n: date(2025, 1, 1) + timedelta(days=n))


@given(starts, st.integers(0, 12), st.integers(0, 3 * 365))
def test_a_schedule_keeps_its_promises(start, months, later):
    day = start + timedelta(days=later)
    billing_day = billing_day_for(start)
    plan = schedule(start, billing_day, months, day)
    made = charges_by(start, billing_day, day)
    assert made >= 1
    assert billing_date(start, billing_day, made - 1) <= day < plan.next_billing_on == billing_date(start, billing_day, made)
    if months == 0:
        assert plan.full_price_from is None and plan.offer_months_left == 0 and not plan.next_at_offer_price
        return
    assert plan.full_price_from == billing_date(start, billing_day, months)
    assert 0 <= plan.offer_months_left <= months
    assert (plan.offer_months_left == 0) == (day >= plan.full_price_from)
    assert plan.next_at_offer_price == (plan.next_billing_on < plan.full_price_from)
