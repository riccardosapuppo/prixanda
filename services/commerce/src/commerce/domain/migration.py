"""Price migrations (business book §8): the rules of a market for an existing
subscriber who would pay more, and the simulation of a migration (§8.7).

A market's rules have two parts that are never mixed (§8.1): what the law
requires, with its sources (consent in Germany, notice elsewhere), and what
the music service chose, a setting and never law (§8.6): how long the window
is, and what happens when it ends.

The simulation compares running the migration with not running it, per
month, net of VAT: the subscribers who accept pay the new price; those who
do not leave the paid plan (or keep the old price, where the market keeps
it). Acceptance is an assumption, shown with its source.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from commerce.domain import billing
from commerce.domain.economics import MarketTerms
from commerce.domain.money import BASIS_POINTS, round_half_up

CHOICE_LABEL = "The music service's choice, configurable per market; not a legal requirement."
# What happens when the window ends to those who did not say yes (consent), or did not leave (notice).
LEAVES = ("move_to_free", "end_at_period_end")


@dataclass(frozen=True)
class Policy:
    market: str
    legal_requirement: str  # consent, notice
    legal_basis: str
    legal_sources: tuple[str, ...]
    window_days: int
    after_window: str  # move_to_free, end_at_period_end, keep_old_price, new_price
    commercial_choice: str
    alternatives: tuple[str, ...]

    @property
    def consent(self) -> bool:
        return self.legal_requirement == "consent"

    def window_ends(self, sent_local: datetime) -> datetime:
        """The last minute of the window, in the market's local time: 45 days from 2 November 09:00 end on 17 December
        at 23:59. A local midnight-based end, so that the window does not depend on the hour the requests went out."""
        return datetime.combine(sent_local.date() + timedelta(days=self.window_days), time(23, 59))


def first_charge_from(started_on: date, billing_day: int, day: date) -> date:
    """The first charge of a subscription on or after a day."""
    made = billing.charges_by(started_on, billing_day, day - timedelta(days=1))
    return billing.billing_date(started_on, billing_day, made)


@dataclass(frozen=True)
class Charges:
    """When a subscription is charged: from its first day, on its billing day, an offer's months first."""

    started_on: date
    billing_day: int
    offer_ends: date | None = None  # the first charge at the full price, after the offer's months

    def first_from(self, day: date) -> date:
        """The first charge on or after a day, outside the offer's months: those were bought at their price (§6.1)."""
        return first_charge_from(self.started_on, self.billing_day,
                                 day if self.offer_ends is None else max(day, self.offer_ends))


def new_price_from(policy: Policy, charges: Charges, *, starts: date, window_ends: date, yes_on: date | None = None) -> date:
    """The first charge at the new price, never before new subscribers pay it (starts). Consent: after a yes given on a
    day, from the next day on, since that day's charge may be made already. Notice: once the notice ran out."""
    if policy.consent:
        if yes_on is None:
            raise ValueError("in a consent market the new price follows a yes")
        earliest = yes_on + timedelta(days=1)
    else:
        earliest = window_ends + timedelta(days=1)
    return charges.first_from(max(earliest, starts))


def leaving_day(policy: Policy, charges: Charges, *, starts: date, window_ends: date) -> date | None:
    """The day a paid subscription ends rather than pay the new price, the first day on the free plan; None where the
    market's choice keeps it at the old price. A month already paid is never cut short, and nothing is charged that day.

    Notice, after a no: the day the new price would first be charged. Consent, after a no or without an answer: the
    first charge on or after the deadline's day (window_ends), and not before new subscribers pay the new price. Both
    choices that end it, move_to_free and end_at_period_end, end it then: a listener whose paid plan ends is on the free
    plan from the next day (§4.5), so the two differ only in what the listener is told."""
    if not policy.consent:
        return new_price_from(policy, charges, starts=starts, window_ends=window_ends)
    if policy.after_window in LEAVES:
        return charges.first_from(max(window_ends, starts))
    return None


@dataclass(frozen=True)
class Step:
    """Per subscription per month (§3.5, §5)."""

    price: int
    net: int
    artists: int
    payment_costs: int
    contribution: int


def step(terms: MarketTerms, price: int) -> Step:
    b = terms.breakdown(price)
    return Step(price, b.net, b.artists, b.payment_costs, b.keeps)


@dataclass(frozen=True)
class MigrationResult:
    before: Step
    after: Step
    existing: int
    accepting: int
    not_accepting: int
    moving_to_free: int
    revenue_change: int  # per month, net
    contribution_change: int
    revenue_at_risk: int
    break_even_revenue_bp: int | None  # None: no acceptance makes it up
    break_even_contribution_bp: int | None


def _break_even(before: int, after: int) -> int | None:
    """The acceptance a at which a × after equals before: a × (after − before) − (1 − a) × before = 0."""
    if after <= 0:
        return None
    return min(BASIS_POINTS, max(0, round_half_up(before * BASIS_POINTS, after)))


def simulate_migration(terms: MarketTerms, old_price: int, new_price: int, existing: int, acceptance_bp: int,
                       policy: Policy) -> MigrationResult:
    if new_price <= old_price:
        raise ValueError("a price migration raises the price")
    if existing < 0 or not 0 <= acceptance_bp <= BASIS_POINTS:
        raise ValueError("the existing subscribers are counted from zero, and acceptance is a share")
    before, after = step(terms, old_price), step(terms, new_price)
    accepting = round_half_up(existing * acceptance_bp, BASIS_POINTS)
    refusing = existing - accepting
    keep = policy.after_window == "keep_old_price"
    # Those who keep the old price lose nothing; those who leave take their whole old amount with them.
    lost_revenue = 0 if keep else refusing * before.net
    lost_contribution = 0 if keep else refusing * before.contribution
    return MigrationResult(
        before, after, existing, accepting, refusing, 0 if keep else refusing,
        accepting * (after.net - before.net) - lost_revenue,
        accepting * (after.contribution - before.contribution) - lost_contribution,
        lost_revenue,
        None if keep else _break_even(before.net, after.net),
        None if keep else _break_even(before.contribution, after.contribution))
