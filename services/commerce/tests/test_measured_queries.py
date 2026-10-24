"""The queries that matter on the full data (business book §14.2), made
cheaper by migration V16, give the same answers as before on the small data:
the release campaign's audience and its like, counted from the weekly sums
and the days at the ends of the window, against every day read one by one as
the engine read them before; one listener's answer, by the primary key; and
the audit log's pages, each event once, newest first. Listening is only ever
added, so that the weekly sums stay true.

npm run measure measures them on the full data; these tests hold that the
answers do not move."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from commerce.domain.offers import Audience, ListeningRule
from commerce.engine import audit_log, eligibility
from commerce.measure import before_count, before_includes
from helpers import sqlstate_of

DAY = date(2026, 10, 24)
DAYS = [DAY, DAY - timedelta(days=4), DAY - timedelta(days=5), DAY - timedelta(days=11)]  # a Saturday, Tuesday, Monday...
RULES = [ListeningRule(artist, seconds, within) for artist in (1, 4, 9) for seconds in (3_600, 3 * 3_600)
         for within in (7, 13, 30)]


@pytest.mark.parametrize("segment", ["free_listeners", "anyone"])
async def test_an_audience_counts_the_same_from_the_weekly_sums(copy, segment):
    differ, counted = [], 0
    for rule in RULES:
        audience = Audience(segment, None, False, rule)
        for market in ("DE", "IT"):
            for day in DAYS:
                sql, args = before_count(audience, market, day)
                was = await copy.fetchval(sql, *args)
                sql, args = eligibility.count_query(audience, market, day)
                now = await copy.fetchval(sql, *args)
                counted += was
                if was != now:
                    differ.append((rule, market, day, was, now))
    assert differ == []
    assert counted > 0  # the comparisons counted people, not only empty audiences


async def test_one_listener_s_answer_is_the_same_by_the_primary_key(copy):
    fans = Audience("free_listeners", None, False, ListeningRule(4, 3 * 3_600, 30))
    people = [r["id"] for r in await copy.fetch("select id from subscriber where market = 'DE' order by id limit 300")]
    answers = []
    for subscriber in people:
        sql, args = before_includes(fans, "DE", DAY, subscriber)
        was = await copy.fetchval(sql, *args)
        sql, args = eligibility.includes_query(fans, "DE", DAY, subscriber)
        assert await copy.fetchval(sql, *args) == was, subscriber
        answers.append(was)
    assert True in answers and False in answers


async def test_the_weekly_sums_are_the_days_summed(copy):
    differ = await copy.fetch(
        "select coalesce(d.artist_id, w.artist_id) as artist, coalesce(d.week, w.week) as week, "
        "coalesce(d.subscriber_id, w.subscriber_id) as subscriber, d.seconds as days, w.seconds as weeks from "
        "(select artist_id, date_trunc('week', day)::date as week, subscriber_id, sum(seconds) as seconds from listening_day "
        " group by 1, 2, 3) d full join listening_week w using (artist_id, week, subscriber_id) "
        "where d.seconds is distinct from w.seconds")
    assert differ == []
    assert await copy.fetchval("select count(*) from listening_week") > 1_000


async def test_the_log_s_pages_hold_every_event_once_newest_first(copy):
    for n in range(260):
        await copy.execute(
            "insert into audit_event (at, actor, actor_role, action, subject, request_id, reason, body, prev_hash, hash) "
            "values (now(), 'finance-1', 'finance', $1, $2, $3, null, '{}', decode(repeat('00', 32), 'hex'), "
            "decode(repeat('00', 32), 'hex'))", "change.approved" if n % 3 else "change.rejected", f"change:{n % 7}",
            f"req-page-{n:08d}")
    for filters in ({}, {"action": "change.approved"}, {"subject": "change:3"}, {"actor": "finance-1"}):
        seen, after = [], None
        while True:
            sql, args = audit_log.page_query(**filters, after=after, size=25)
            rows = await copy.fetch(sql, *args)
            seen += [r["seq"] for r in rows[:25]]
            if len(rows) <= 25:
                break
            after = rows[24]["seq"]
        where = " and ".join(f"{column} = ${n + 1}" for n, column in enumerate(filters)) or "true"
        everything = [r["seq"] for r in await copy.fetch(
            f"select seq from audit_event where {where} order by seq desc", *filters.values())]
        assert seen == everything and len(seen) > 25


async def test_listening_is_only_ever_added_and_its_sums_follow(copy):
    listener = await copy.fetchval("select id from subscriber where market = 'DE' and joined_on <= '2026-10-01' "
                                   "order by id limit 1")
    week = await copy.fetchval("select coalesce(sum(seconds), 0) from listening_week where artist_id = 2 and subscriber_id = $1 "
                               "and week = '2026-10-19'", listener)
    await copy.execute("insert into listening_day (subscriber_id, artist_id, day, seconds) values ($1, 2, '2026-10-24', 600), "
                       "($1, 2, '2026-10-25', 300) on conflict do nothing", listener)
    assert await copy.fetchval("select seconds from listening_week where artist_id = 2 and subscriber_id = $1 "
                               "and week = '2026-10-19'", listener) == week + 900
    assert await sqlstate_of(copy.execute("update listening_day set seconds = 1 where subscriber_id = $1", listener)) == "RL013"
    assert await sqlstate_of(copy.execute("delete from listening_day where subscriber_id = $1", listener)) == "RL013"
    assert await sqlstate_of(copy.execute("update listening_week set seconds = 1 where subscriber_id = $1", listener)) == "RL013"
    assert await sqlstate_of(copy.execute("truncate listening_week")) == "RL013"
    partitions = await copy.fetchval("select count(*) from pg_inherits where inhparent = 'listening_day'::regclass")
    assert partitions == 36 + 1  # each month from January 2025 to December 2027, and the default
    assert await copy.fetchval("select count(*) from listening_day_other") == 0
