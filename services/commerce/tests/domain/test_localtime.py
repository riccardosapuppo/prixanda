"""Local times of a market (business book §3.7): "09:00 in Italy" stays
09:00 in Italy across a change of the clocks, and the times a change skips or
repeats are refused rather than guessed."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from commerce.domain.localtime import (
    AmbiguousLocalTime, MalformedTime, classify, describe_local, format_instant, format_local, parse_instant,
    parse_local, to_instant, to_local,
)

ZONES = {"IT": "Europe/Rome", "FR": "Europe/Paris", "DE": "Europe/Berlin", "GB": "Europe/London"}


def local(text: str) -> datetime:
    return parse_local(text)


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


def test_nine_in_the_morning_stays_nine_across_the_night_the_clocks_go_back():
    # 25 October 2026: summer time ends in all four markets at 01:00 UTC.
    instants = [to_instant(local(f"2026-10-{day}T09:00"), "Europe/Rome") for day in (24, 25, 26, 27)]
    assert instants == [utc(2026, 10, 24, 7), utc(2026, 10, 25, 8), utc(2026, 10, 26, 8), utc(2026, 10, 27, 8)]
    assert [to_local(i, "Europe/Rome") for i in instants] == [local(f"2026-10-{d}T09:00") for d in (24, 25, 26, 27)]
    # A day that holds 25 hours: from 09:00 on the 24th to 09:00 on the 25th.
    assert instants[1] - instants[0] == timedelta(hours=25)


@pytest.mark.parametrize("market", ZONES)
def test_the_change_of_the_clocks_on_25_october_2026_happens_at_one_in_the_morning_utc_everywhere(market):
    zone = ZONES[market]
    before, after = to_local(utc(2026, 10, 25, 0, 30), zone), to_local(utc(2026, 10, 25, 1, 30), zone)
    assert before == after, f"{zone}: the same wall-clock time, an hour apart"
    assert to_local(utc(2026, 10, 25, 2, 30), zone) - after == timedelta(hours=1)


@pytest.mark.parametrize(("zone", "text"), [
    ("Europe/Rome", "2026-10-25T02:30"), ("Europe/Paris", "2026-10-25T02:00"), ("Europe/Berlin", "2026-10-25T02:59"),
    ("Europe/London", "2026-10-25T01:30"),
])
def test_a_time_the_clocks_repeat_is_refused(zone, text):
    assert classify(local(text), zone) == "repeated"
    with pytest.raises(AmbiguousLocalTime) as refused:
        to_instant(local(text), zone)
    assert refused.value.kind == "repeated"
    assert "happens twice" in str(refused.value)


@pytest.mark.parametrize(("zone", "text"), [
    ("Europe/Rome", "2026-03-29T02:30"), ("Europe/Berlin", "2027-03-28T02:00"), ("Europe/London", "2026-03-29T01:15"),
])
def test_a_time_the_clocks_skip_is_refused(zone, text):
    assert classify(local(text), zone) == "skipped"
    with pytest.raises(AmbiguousLocalTime) as refused:
        to_instant(local(text), zone)
    assert refused.value.kind == "skipped" and refused.value.offsets[0] != refused.value.offsets[1]
    assert "does not exist" in str(refused.value)


@pytest.mark.parametrize(("zone", "text", "instant"), [
    ("Europe/Rome", "2026-10-25T03:00", utc(2026, 10, 25, 2)),
    ("Europe/Rome", "2026-10-25T01:59", utc(2026, 10, 24, 23, 59)),
    ("Europe/London", "2026-11-02T09:00", utc(2026, 11, 2, 9)),
    ("Europe/London", "2026-10-25T02:00", utc(2026, 10, 25, 2)),
    ("Europe/Berlin", "2026-12-01T00:00", utc(2026, 11, 30, 23)),
])
def test_times_next_to_a_change_have_one_instant(zone, text, instant):
    assert classify(local(text), zone) == "single"
    assert to_instant(local(text), zone) == instant


@pytest.mark.parametrize("text", [
    "2026-10-26 09:00", "2026-10-26T09", "2026-10-26T09:00Z", "2026-10-26T09:00+01:00", "26/10/2026 09:00",
    "2026-02-30T09:00", "2026-10-26T24:00", "", "2026-10-26T09:00:00.5",
])
def test_a_local_time_is_written_one_way(text):
    with pytest.raises(MalformedTime):
        parse_local(text)


def test_local_times_round_trip_through_their_text():
    for text in ("2026-10-26T09:00", "2026-10-26T09:00:30", "2027-01-01T00:00"):
        assert format_local(parse_local(text)) == text
    assert format_local(parse_local("2026-10-26T09:00:00")) == "2026-10-26T09:00"


def test_an_instant_carries_its_offset_and_is_kept_in_utc():
    assert parse_instant("2026-10-24T08:42:00Z") == utc(2026, 10, 24, 8, 42)
    assert parse_instant("2026-10-24T10:42+02:00") == utc(2026, 10, 24, 8, 42)
    assert format_instant(utc(2026, 10, 26, 8)) == "2026-10-26T08:00:00Z"
    assert format_instant(utc(2026, 10, 26, 8, 0, 0, 120)) == "2026-10-26T08:00:00.000120Z"
    for text in ("2026-10-24T08:42:00", "2026-10-24", "yesterday"):
        with pytest.raises(MalformedTime):
            parse_instant(text)


def test_instants_and_local_times_are_not_mixed_up():
    with pytest.raises(ValueError):
        to_instant(utc(2026, 10, 26, 9), "Europe/Rome")
    with pytest.raises(ValueError):
        to_local(datetime(2026, 10, 26, 9), "Europe/Rome")
    with pytest.raises(ValueError):
        to_instant(local("2026-10-26T09:00"), "Europe/Atlantis")


def test_a_sentence_names_the_day_the_hour_and_the_zone():
    assert describe_local(local("2026-12-01T00:00"), "Europe/Berlin") == "1 December 2026, 00:00 (Europe/Berlin)"
