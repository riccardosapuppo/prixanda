"""Who is in an offer's audience, counted in the data (business book §6.5).

One predicate, written once, answers every question: how many people an
audience reaches in a market on a day (the N of the sentence), whether one
person is in it (a quote for a subscriber), and how many people are in two
audiences at once (two campaigns for listeners of different artists, §6.4).
Days are the market's calendar days. A listening rule counts the full days
before the day itself: "the last 30 days" on 24 October are 24 September to
23 October.

A listening rule reads the data in the cheapest way that gives the same
answer (migration V16, §14.2, measured by `npm run measure`): for a whole
audience, the weekly sums of the weeks that lie inside the window, and the
days at either end of it; for one person, that person's days alone, by the
primary key.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from commerce.domain.offers import Audience, ListeningRule
from commerce.engine.database import Connection


@dataclass(frozen=True)
class Window:
    """The days a listening rule counts, [first, end), and the whole weeks inside them, [weeks_from, weeks_to):
    Mondays, each week from its Monday to the next. No whole week inside: weeks_from == weeks_to."""

    first: date
    end: date
    weeks_from: date
    weeks_to: date


def window(rule: ListeningRule, day: date) -> Window:
    """On 24 October 2026, the last 30 days are 24 September to 23 October: the whole weeks inside them start on
    28 September, 5 and 12 October; 24 to 27 September and 19 to 23 October are read day by day (the week of
    19 October runs past the window)."""
    first, end = day - timedelta(days=rule.within_days), day
    weeks_from = first + timedelta(days=(7 - first.weekday()) % 7)  # the first Monday on or after the first day
    weeks_to = end - timedelta(days=end.weekday())  # the last Monday on or before the end: its week runs past it
    if weeks_to < weeks_from:
        weeks_to = weeks_from
    return Window(first, end, weeks_from, weeks_to)


def _listening(rule: ListeningRule, day: date, param, *, one_person: bool) -> str:
    w = window(rule, day)
    artist, least = param(rule.artist_id), param(rule.min_seconds)
    first, end = param(w.first.isoformat()), param(w.end.isoformat())
    if one_person:
        return (f"(select coalesce(sum(l.seconds), 0) from listening_day l where l.subscriber_id = b.id "
                f"and l.artist_id = {artist} and l.day >= {first}::text::date and l.day < {end}::text::date) > {least}")
    if w.weeks_from == w.weeks_to:
        days = f"l.day >= {first}::text::date and l.day < {end}::text::date"
        weeks = "false"
    else:
        weeks_from, weeks_to = param(w.weeks_from.isoformat()), param(w.weeks_to.isoformat())
        days = (f"((l.day >= {first}::text::date and l.day < {weeks_from}::text::date) "
                f"or (l.day >= {weeks_to}::text::date and l.day < {end}::text::date))")
        weeks = f"k.week >= {weeks_from}::text::date and k.week < {weeks_to}::text::date"
    return (f"b.id in (select x.subscriber_id from ("
            f"select k.subscriber_id, k.seconds from listening_week k where k.artist_id = {artist} and {weeks} "
            f"union all select l.subscriber_id, l.seconds from listening_day l where l.artist_id = {artist} and {days}"
            f") x group by x.subscriber_id having sum(x.seconds) > {least})")


def _predicate(audience: Audience, market: str, day: date, args: list, *, one_person: bool = False) -> str:
    """SQL over subscriber b joined with their subscription s current on the day."""
    def param(value) -> str:
        args.append(value)
        return f"${len(args)}"

    day_param = param(day.isoformat())
    today = f"{day_param}::text::date"
    parts = [
        f"b.market = {param(market)}",
        f"b.joined_on <= {today}",
    ]
    if audience.segment == "never_paid":
        parts.append(f"not exists (select from subscription p where p.subscriber_id = b.id and p.paid and p.started_on <= {today})")
    elif audience.segment == "free_listeners":
        parts.append("not s.paid")
    elif audience.segment == "subscribers_of_plan":
        parts.append(f"s.paid and s.plan_id = {param(audience.current_plan or '')}")
    elif audience.segment != "anyone":
        parts.append("false")  # no audience chosen: nobody
    if audience.needs_student_check:
        parts.append(f"exists (select from student_verification v where v.subscriber_id = b.id "
                     f"and v.verified_on <= {today} and {today} < v.valid_until)")
    if audience.listening is not None:
        parts.append(_listening(audience.listening, day, param, one_person=one_person))
    return " and ".join(parts)


_FROM = ("from subscriber b join subscription s on s.subscriber_id = b.id "
         "and s.started_on <= {today} and (s.ended_on is null or s.ended_on > {today})")


def count_query(audience: Audience, market: str, day: date) -> tuple[str, list]:
    """The SQL that counts an audience, and its arguments: what count() runs, and what npm run measure measures."""
    args: list = []
    where = _predicate(audience, market, day, args)
    return f"select count(*) {_FROM.format(today='$1::text::date')} where {where}", args


def includes_query(audience: Audience, market: str, day: date, subscriber_id: int) -> tuple[str, list]:
    """The SQL that says whether one person is in an audience, and its arguments, as includes() runs it."""
    args: list = []
    where = _predicate(audience, market, day, args, one_person=True)
    args.append(subscriber_id)
    return f"select exists (select 1 {_FROM.format(today='$1::text::date')} where {where} and b.id = ${len(args)})", args


async def count(tx: Connection, audience: Audience, market: str, day: date) -> int:
    sql, args = count_query(audience, market, day)
    return await tx.fetchval(sql, *args)


async def count_both(tx: Connection, a: Audience, b: Audience, market: str, day: date) -> int:
    """People in both audiences in a market on a day."""
    args: list = []
    both = f"{_predicate(a, market, day, args)} and {_predicate(b, market, day, args)}"
    return await tx.fetchval(f"select count(*) {_FROM.format(today='$1::text::date')} where {both}", *args)


async def includes(tx: Connection, audience: Audience, market: str, day: date, subscriber_id: int) -> bool:
    sql, args = includes_query(audience, market, day, subscriber_id)
    return await tx.fetchval(sql, *args)


async def current_subscribers(tx: Connection, market: str, plan: str, day: date, *, by_the_month: bool = False) -> int:
    """People on a plan in a market on a day; by_the_month leaves out the prepaid passes, which a price migration
    does not ask or tell (§9.1)."""
    passes = " and s.prepaid_code is null" if by_the_month else ""
    return await tx.fetchval(
        f"select count(*) {_FROM.format(today='$1::text::date')} where b.market = $2 and s.plan_id = $3{passes}",
        day.isoformat(), market, plan)


async def has_valid_student_check(tx: Connection, subscriber_id: int, day: date) -> bool:
    return await tx.fetchval(
        "select exists (select from student_verification where subscriber_id = $1 and verified_on <= $2::text::date "
        "and $2::text::date < valid_until)", subscriber_id, day.isoformat())
