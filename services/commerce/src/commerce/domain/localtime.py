"""Local times of a market and the instants they fall on (business book §3.7).

Anything scheduled for a market is kept as a wall-clock time in the
market's time zone, "2026-10-26T09:00" in Europe/Rome, and turned into an
instant only when it is evaluated. Two kinds of wall-clock time have no single
instant, and the engine refuses both rather than guess:

* skipped: when the clocks go forward, a stretch of local time never happens
  (02:00 to 03:00 in Rome on 29 March 2026);
* repeated: when they go back, a stretch happens twice (02:00 to 03:00 in Rome
  on 25 October 2026, once in summer time and once in winter time).

The other direction is always defined: an instant has exactly one local time
in a zone. Instants are timezone-aware datetimes in UTC.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_LOCAL = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$")
_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$")


class MalformedTime(ValueError):
    """Text that is not a time in the form the contract uses."""


@dataclass(frozen=True)
class AmbiguousLocalTime(Exception):
    """A wall-clock time that a change of the clocks skips or repeats."""

    zone: str
    local: datetime
    kind: str  # "skipped" or "repeated"
    offsets: tuple[str, str]

    def __str__(self) -> str:
        when = format_local(self.local)
        if self.kind == "skipped":
            return f"{when} does not exist in {self.zone}: the clocks go forward then ({self.offsets[0]} to {self.offsets[1]})"
        return f"{when} happens twice in {self.zone}: the clocks go back then ({self.offsets[0]}, then {self.offsets[1]})"


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ValueError(f"unknown time zone {name!r}") from error


def parse_local(text: str) -> datetime:
    """"2026-10-26T09:00" or "2026-10-26T09:00:30", without an offset."""
    if not isinstance(text, str) or not _LOCAL.match(text):
        raise MalformedTime(f"a local time is written 2026-10-26T09:00, without an offset; got {text!r}")
    try:
        return datetime.fromisoformat(text)
    except ValueError as error:
        raise MalformedTime(f"{text!r} is not a date and time of the calendar") from error


def format_local(local: datetime) -> str:
    """The contract's form: minutes, and seconds only when there are some."""
    if local.tzinfo is not None:
        raise ValueError("a local time has no offset")
    return local.strftime("%Y-%m-%dT%H:%M:%S" if local.second or local.microsecond else "%Y-%m-%dT%H:%M")


def _offset(moment: datetime) -> str:
    delta = moment.utcoffset() or timedelta(0)
    minutes = int(delta.total_seconds()) // 60
    sign = "+" if minutes >= 0 else "-"
    return f"{sign}{abs(minutes) // 60:02d}:{abs(minutes) % 60:02d}"


def classify(local: datetime, zone_name: str) -> str:
    """"single", "skipped" or "repeated"."""
    tz = zone(zone_name)
    first, second = local.replace(tzinfo=tz, fold=0), local.replace(tzinfo=tz, fold=1)
    if first.utcoffset() == second.utcoffset():
        return "single"
    back = first.astimezone(UTC).astimezone(tz).replace(tzinfo=None)
    return "skipped" if back != local else "repeated"


def to_instant(local: datetime, zone_name: str) -> datetime:
    """The instant a wall-clock time of the zone falls on; AmbiguousLocalTime
    when the clocks skip or repeat it."""
    if local.tzinfo is not None:
        raise ValueError("a local time has no offset")
    kind = classify(local, zone_name)
    tz = zone(zone_name)
    if kind != "single":
        first, second = local.replace(tzinfo=tz, fold=0), local.replace(tzinfo=tz, fold=1)
        raise AmbiguousLocalTime(zone_name, local, kind, (_offset(first), _offset(second)))
    return local.replace(tzinfo=tz).astimezone(UTC)


def to_local(instant: datetime, zone_name: str) -> datetime:
    """The wall-clock time of the zone at an instant: always exactly one."""
    if instant.tzinfo is None:
        raise ValueError("an instant carries its offset")
    return instant.astimezone(zone(zone_name)).replace(tzinfo=None)


def parse_instant(text: str) -> datetime:
    """ISO 8601 with Z or an offset; returned in UTC."""
    if not isinstance(text, str) or not _INSTANT.match(text):
        raise MalformedTime(f"an instant is written 2026-10-24T08:42:00Z, with its offset; got {text!r}")
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError as error:
        raise MalformedTime(f"{text!r} is not a date and time of the calendar") from error


def format_instant(instant: datetime) -> str:
    """UTC with Z: 2026-10-26T08:00:00Z, microseconds only when there are some."""
    if instant.tzinfo is None:
        raise ValueError("an instant carries its offset")
    utc = instant.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.%fZ" if utc.microsecond else "%Y-%m-%dT%H:%M:%SZ")


def add_months(moment: datetime, months: int) -> datetime:
    """The same day and time some months later; a day the month lacks becomes
    its last day (31 January plus one month is 28 or 29 February)."""
    index = moment.month - 1 + months
    year, month = moment.year + index // 12, index % 12 + 1
    for day in (moment.day, 31, 30, 29, 28):
        if day <= moment.day:
            try:
                return moment.replace(year=year, month=month, day=day)
            except ValueError:
                continue
    raise ValueError(f"no day {moment.day} in {year}-{month:02d}")


# Spelled out here rather than through strftime("%B"), which follows the
# process's locale.
MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December")


def describe_local(local: datetime, zone_name: str) -> str:
    """For sentences: 26 October 2026, 09:00 (Europe/Rome)."""
    return f"{local.day} {MONTHS[local.month - 1]} {local.year}, {local.hour:02d}:{local.minute:02d} ({zone_name})"
