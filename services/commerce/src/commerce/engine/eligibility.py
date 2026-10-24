"""Who is in an offer's audience, counted in the data (business book §6.5).

One predicate, written once, answers both questions: how many people an
audience reaches in a market on a day (the N of the sentence), and whether
one person is in it (a quote for a subscriber). Days are the market's
calendar days. A listening rule counts the full days before the day itself:
"the last 30 days" on 24 October are 24 September to 23 October.
"""

from __future__ import annotations

from datetime import date

from commerce.domain.offers import Audience
from commerce.engine.database import Connection


def _predicate(audience: Audience, market: str, day: date, args: list) -> str:
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
        rule = audience.listening
        parts.append(
            f"b.id in (select l.subscriber_id from listening_day l where l.artist_id = {param(rule.artist_id)} "
            f"and l.day >= {today} - {param(rule.within_days)}::int and l.day < {today} "
            f"group by l.subscriber_id having sum(l.seconds) > {param(rule.min_seconds)})")
    return " and ".join(parts)


_FROM = ("from subscriber b join subscription s on s.subscriber_id = b.id "
         "and s.started_on <= {today} and (s.ended_on is null or s.ended_on > {today})")


async def count(tx: Connection, audience: Audience, market: str, day: date) -> int:
    args: list = []
    where = _predicate(audience, market, day, args)
    return await tx.fetchval(f"select count(*) {_FROM.format(today='$1::text::date')} where {where}", *args)


async def includes(tx: Connection, audience: Audience, market: str, day: date, subscriber_id: int) -> bool:
    args: list = []
    where = _predicate(audience, market, day, args)
    args.append(subscriber_id)
    return await tx.fetchval(
        f"select exists (select 1 {_FROM.format(today='$1::text::date')} where {where} and b.id = ${len(args)})", *args)


async def current_subscribers(tx: Connection, market: str, plan: str, day: date) -> int:
    """People on a plan in a market on a day."""
    return await tx.fetchval(
        f"select count(*) {_FROM.format(today='$1::text::date')} where b.market = $2 and s.plan_id = $3",
        day.isoformat(), market, plan)


async def has_valid_student_check(tx: Connection, subscriber_id: int, day: date) -> bool:
    return await tx.fetchval(
        "select exists (select from student_verification where subscriber_id = $1 and verified_on <= $2::text::date "
        "and $2::text::date < valid_until)", subscriber_id, day.isoformat())
