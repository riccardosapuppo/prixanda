"""The difference in business words (business book §6.5) and an audience
described for people.

"Italy, Student: from €5.79 to €2.99 for 3 months, new subscribers only;
10,000 eligible; conflicts: none." The number of eligible people is counted
in the data when the sentence is written; nobody types it.

The texts avoid the service's name on purpose: it is a working name, and a
change of name should touch only the interface's own texts.
"""

from __future__ import annotations

from dataclasses import dataclass

from commerce.domain.economics import listing
from commerce.domain.money import Money, format_count, format_money, format_percent
from commerce.domain.offers import Audience


def duration(seconds: int) -> str:
    """10800 as 3 hours, 5400 as 90 minutes, 45 as 45 seconds."""
    for unit, size in (("hour", 3_600), ("minute", 60)):
        if seconds % size == 0:
            count = seconds // size
            return f"{format_count(count)} {unit}{'' if count == 1 else 's'}"
    return f"{format_count(seconds)} second{'' if seconds == 1 else 's'}"


def months(count: int) -> str:
    return f"{count} month{'' if count == 1 else 's'}"


def audience_short(audience: Audience, *, plan_needs_student_check: bool, plan_names: dict[str, str],
                   artist_names: dict[int, str]) -> str:
    """For the sentence: "new subscribers only", "Free listeners with more than 3 hours of Doppelfenster in 30 days"."""
    segment = audience.segment
    if segment == "never_paid":
        words = "new subscribers only"
    elif segment == "free_listeners":
        words = "Free listeners"
    elif segment == "subscribers_of_plan":
        words = f"{plan_names.get(audience.current_plan or '', audience.current_plan or 'a plan')} subscribers"
    elif segment == "anyone":
        words = "everyone"
    else:
        words = "audience not chosen"
    if audience.listening is not None:
        rule = audience.listening
        artist = artist_names.get(rule.artist_id, f"artist {rule.artist_id}")
        words += f" with more than {duration(rule.min_seconds)} of {artist} in {rule.within_days} days"
    if audience.needs_student_check and not plan_needs_student_check:
        words = f"verified students, {words}"
    return words


def audience_words(audience: Audience, market_name: str, *, plan_names: dict[str, str], artist_names: dict[int, str],
                   in_sentence: bool = False) -> str:
    """For the page: "Verified students in Italy who have never had a paid plan". In a sentence, the first word is
    lower case unless it names a plan: "not among verified students in Italy", "not among Duo subscribers in Italy"."""
    segment = audience.segment
    student = audience.needs_student_check
    if segment == "never_paid":
        words = f"{'Verified students' if student else 'People'} in {market_name} who have never had a paid plan"
    elif segment == "free_listeners":
        words = f"Free listeners in {market_name}" + (" who are verified students" if student else "")
    elif segment == "subscribers_of_plan":
        plan = plan_names.get(audience.current_plan or "", audience.current_plan or "")
        words = f"{plan} subscribers in {market_name}" + (" who are verified students" if student else "")
    else:
        words = f"{'Verified students' if student else 'Everyone'} in {market_name}"
    if audience.listening is not None:
        rule = audience.listening
        artist = artist_names.get(rule.artist_id, f"artist {rule.artist_id}")
        words += f", with more than {duration(rule.min_seconds)} of {artist} in the last {rule.within_days} days"
    if in_sentence and segment != "subscribers_of_plan":
        words = words[0].lower() + words[1:]
    return words


@dataclass(frozen=True)
class OfferClause:
    market_name: str
    plan_name: str
    list_price: Money | None
    offer_price: Money | None
    percent_off_bp: int | None
    months: int
    audience: str
    eligible: int
    cap: int
    conflicts: list[str]


def offer_clause(c: OfferClause) -> str:
    if c.offer_price is not None and c.list_price is not None:
        off = f" ({format_percent(c.percent_off_bp)} off)" if c.percent_off_bp else ""
        change = f"from {format_money(c.list_price)} to {format_money(c.offer_price)}{off}"
    else:
        change = "price not set"
    duration_words = f" for {months(c.months)}" if c.months > 0 else ""
    cap = f"; at most {format_count(c.cap)}" if c.cap > 0 else ""
    conflicts = listing(c.conflicts) if c.conflicts else "none"
    return (f"{c.market_name}, {c.plan_name}: {change}{duration_words}, {c.audience}; "
            f"{format_count(c.eligible)} eligible{cap}; conflicts: {conflicts}.")


def migration_sentence(*, market_name: str, plan_name: str, current: Money | None, new: Money | None, starts: str | None,
                       notices: str | None, subscribers: int, consent: bool, window_days: int, choice: str,
                       overlaps: list[str]) -> str:
    """"Germany, Family: from €18.99 to €20.99 for new subscribers from 1 December 2026, 00:00 (Europe/Berlin);
    8,412 current subscribers asked for their consent from 2 November 2026, 09:00 (Europe/Berlin), within 45 days;
    without it: when the period already paid at the consent deadline runs out, the account moves to the free plan,
    and keeps its playlists and library (the music service's choice); overlaps: none." In a notice market the current
    subscribers are told, and may leave before the new price."""
    old = format_money(current) if current is not None else "no price"
    price = format_money(new) if new is not None else "a price not set yet"
    when = f" from {starts}" if starts else ""
    told = f" from {notices}" if notices else ""
    people = f"{format_count(subscribers)} current subscriber{'' if subscribers == 1 else 's'}"
    choice_words = choice[0].lower() + choice[1:] if choice else ""
    if consent:
        existing = (f"{people} asked for their consent{told}, within {window_days} days; without it: "
                    f"{choice_words.rstrip('.')} (the music service's choice)")
    else:
        existing = f"{people} told{told}, {window_days} days before the new price applies to them; they may leave before it"
    clash = listing(overlaps) if overlaps else "none"
    return f"{market_name}, {plan_name}: from {old} to {price} for new subscribers{when}; {existing}; overlaps: {clash}."


def list_price_sentence(*, market_name: str, plan_name: str, current: Money | None, new: Money | None,
                        starts: str | None, subscribers: int, overlaps: list[str]) -> str:
    """"Germany, Family: from €18.99 to €20.99 for new subscribers from 1 December 2026, 00:00 (Europe/Berlin);
    8,412 current subscribers keep their price until a price migration moves them; overlaps: none."""
    old = format_money(current) if current is not None else "no price"
    price = format_money(new) if new is not None else "a price not set yet"
    when = f" from {starts}" if starts else ""
    clash = listing(overlaps) if overlaps else "none"
    return (f"{market_name}, {plan_name}: from {old} to {price} for new subscribers{when}; "
            f"{format_count(subscribers)} current subscribers keep their price until a price migration moves them; "
            f"overlaps: {clash}.")
