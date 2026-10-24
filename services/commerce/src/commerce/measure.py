"""The queries that matter on the full data (business book §14.2), measured
before and after migration V16.

    python -m commerce.measure prepare --url <owner URL> [--audit-events 1000000]
    python -m commerce.measure before  --url <owner URL> --out <file> [--runs 5]
    python -m commerce.measure after   --url <owner URL> --out <file> [--runs 5]

`npm run measure` (tools/measure.ts) runs the phases around Flyway on a
PostgreSQL of its own: the schema as it was before V16, the data generated
(the full size unless told otherwise), `prepare` (an audit log of a
production's size: the generator writes one event) and `before`; then Flyway
applies V16 and every migration after it, and `after`. Each phase prints its
part of the report as JSON; the tool adds the machine and writes
reports/measure.json.

The queries:

  fan_audience        the release campaign's audience (§14.2): free listeners
                      in Germany who played Doppelfenster for more than 3
                      hours in the last 30 days, counted as validation and
                      the simulation count it;
  popular_audience    anyone in Italy who played the most played artist for
                      more than 2 hours: the same rule over the largest part
                      of the listening;
  fan_quote           whether one listener is in the release campaign's
                      audience, as a quote asks;
  audit_page_first    the newest page of the audit log;
  audit_page_deep     a page halfway through it, by keyset;
  audit_page_action   the newest page of one action;
  audit_page_subject  the newest page of one subject.

"Before" is the SQL the engine ran up to V16, kept here as it ran
(eligibility.py at commit 28bcd42; the audit log's pages did not change, V16
adds their indexes); "after" is the SQL the engine's own functions build
now. Each query runs once to warm the cache, then --runs times under EXPLAIN
(ANALYZE, BUFFERS, FORMAT JSON): the report keeps every run's times, the
median run's buffers and plan, and the query's answer, so that before and
after can be compared, the same answer from the same data. The report
states numbers and the conditions they were taken in; it judges nothing.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import asyncpg

from commerce.domain.offers import Audience, ListeningRule
from commerce.engine import audit_log, eligibility
from commerce.generate import UNTIL

# The last day of the generated data: "the last 30 days" are the 30 days before it.
DAY = UNTIL
DOPPELFENSTER, MOST_PLAYED = 4, 1
FANS = Audience("free_listeners", None, False, ListeningRule(DOPPELFENSTER, 3 * 3_600, 30))
POPULAR = Audience("anyone", None, False, ListeningRule(MOST_PLAYED, 2 * 3_600, 30))
SETTINGS = ("server_version", "shared_buffers", "work_mem", "effective_cache_size", "maintenance_work_mem",
            "max_parallel_workers_per_gather", "jit", "random_page_cost", "fsync", "synchronous_commit")
TABLES = ("subscriber", "subscription", "listening_day", "listening_week", "audit_event")


# -- the SQL the engine ran before V16 -----------------------------------------------------

def _before_predicate(audience: Audience, market: str, day: date, args: list, *, one_person: bool = False) -> str:
    """eligibility._predicate as it was before V16: a listening rule read every day of the window from listening_day,
    for one person as for everyone."""
    def param(value) -> str:
        args.append(value)
        return f"${len(args)}"

    today = f"{param(day.isoformat())}::text::date"
    parts = [f"b.market = {param(market)}", f"b.joined_on <= {today}"]
    if audience.segment == "free_listeners":
        parts.append("not s.paid")
    elif audience.segment != "anyone":
        raise ValueError("the measured audiences are free listeners, or anyone")
    if audience.listening is not None:
        rule = audience.listening
        parts.append(
            f"b.id in (select l.subscriber_id from listening_day l where l.artist_id = {param(rule.artist_id)} "
            f"and l.day >= {today} - {param(rule.within_days)}::int and l.day < {today} "
            f"group by l.subscriber_id having sum(l.seconds) > {param(rule.min_seconds)})")
    return " and ".join(parts)


_FROM = ("from subscriber b join subscription s on s.subscriber_id = b.id "
         "and s.started_on <= {today} and (s.ended_on is null or s.ended_on > {today})")


def before_count(audience: Audience, market: str, day: date) -> tuple[str, list]:
    args: list = []
    where = _before_predicate(audience, market, day, args)
    return f"select count(*) {_FROM.format(today='$1::text::date')} where {where}", args


def before_includes(audience: Audience, market: str, day: date, subscriber_id: int) -> tuple[str, list]:
    args: list = []
    where = _before_predicate(audience, market, day, args)
    args.append(subscriber_id)
    return f"select exists (select 1 {_FROM.format(today='$1::text::date')} where {where} and b.id = ${len(args)})", args


# -- the queries ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Query:
    name: str
    sql: str
    args: list
    answer: str  # how the answer is read: value, or seqs (a page of the log)


async def _choices(conn: asyncpg.Connection) -> dict:
    """What the queries are asked about, chosen from the data the same way in both phases."""
    # The free listener in Germany who played Doppelfenster most in the window: one the release campaign reaches.
    fan = await conn.fetchval(
        "select l.subscriber_id from listening_day l join subscriber b on b.id = l.subscriber_id "
        "join subscription s on s.subscriber_id = b.id and s.started_on <= $2::text::date "
        "and (s.ended_on is null or s.ended_on > $2::text::date) "
        "where l.artist_id = $1 and b.market = 'DE' and not s.paid and l.day >= $2::text::date - 30 and l.day < $2::text::date "
        "group by l.subscriber_id order by sum(l.seconds) desc, l.subscriber_id limit 1", DOPPELFENSTER, DAY.isoformat())
    events = await conn.fetchval("select count(*) from audit_event")
    middle = await conn.fetchval("select seq from audit_event order by seq offset $1 limit 1", events // 2)
    subject = await conn.fetchval("select subject from audit_event where action = 'change.approved' "
                                  "group by subject order by count(*) desc, subject limit 1")
    return {"fan": fan, "events": events, "middle": middle, "subject": subject or "change:1"}


def queries(phase: str, choices: dict) -> list[Query]:
    count = before_count if phase == "before" else eligibility.count_query
    includes = before_includes if phase == "before" else eligibility.includes_query
    page = audit_log.page_query
    found = [
        Query("fan_audience", *count(FANS, "DE", DAY), "value"),
        Query("popular_audience", *count(POPULAR, "IT", DAY), "value"),
    ]
    if choices["fan"] is not None:
        found.append(Query("fan_quote", *includes(FANS, "DE", DAY, choices["fan"]), "value"))
    found += [
        Query("audit_page_first", *page(), "seqs"),
        Query("audit_page_deep", *page(after=choices["middle"]) if choices["middle"] else page(), "seqs"),
        Query("audit_page_action", *page(action="change.approved"), "seqs"),
        Query("audit_page_subject", *page(subject=choices["subject"]), "seqs"),
    ]
    return found


def _buffers(plan: dict) -> dict:
    keys = ("Shared Hit Blocks", "Shared Read Blocks", "Temp Read Blocks", "Temp Written Blocks")
    return {key: plan.get(key, 0) for key in keys}


async def measure(conn: asyncpg.Connection, query: Query, runs: int) -> dict:
    explain = f"explain (analyze, buffers, format json) {query.sql}"
    await conn.fetchval(explain, *query.args)  # warms the cache; not counted
    taken = []
    for _ in range(runs):
        [result] = json.loads(await conn.fetchval(explain, *query.args))
        taken.append(result)
    times = [r["Execution Time"] for r in taken]
    median = sorted(taken, key=lambda r: r["Execution Time"])[len(taken) // 2]
    if query.answer == "seqs":
        answer: object = [r["seq"] for r in await conn.fetch(query.sql, *query.args)]
    else:
        answer = await conn.fetchval(query.sql, *query.args)
    return {
        "sql": query.sql, "args": [str(a) for a in query.args], "answer": answer,
        "execution_ms": times, "median_execution_ms": statistics.median(times),
        "planning_ms": [r["Planning Time"] for r in taken], "buffers": _buffers(median["Plan"]), "plan": median["Plan"],
    }


async def conditions(conn: asyncpg.Connection) -> dict:
    settings = {r["name"]: r["setting"] + (r["unit"] or "") for r in await conn.fetch(
        "select name, setting, unit from pg_settings where name = any($1::text[])", list(SETTINGS))}
    tables = {}
    for table in TABLES:
        exists = await conn.fetchval("select to_regclass($1) is not null", table)
        if exists:
            tables[table] = {
                "rows": await conn.fetchval(f"select count(*) from {table}"),
                "bytes": await conn.fetchval("select pg_total_relation_size($1::regclass) + coalesce((select sum("
                                             "pg_total_relation_size(i.inhrelid)) from pg_inherits i where i.inhparent = "
                                             "$1::regclass), 0)", table)}
    migrated = await conn.fetchval('select max(version::int) from flyway_schema_history where success')
    return {"postgres": settings, "tables": tables, "schema_version": migrated,
            "database_bytes": await conn.fetchval("select pg_database_size(current_database())")}


async def prepare(conn: asyncpg.Connection, events: int) -> dict:
    """An audit log of a production's size, written through its chain like any other: one event in a thousand is an
    approval of one of 500 changes, the rest a listener's confirmation or a payment."""
    have = await conn.fetchval("select count(*) from audit_event")
    while have < events:
        # In batches, each followed by ANALYZE: the chain's trigger looks up the last event with a plan made for
        # the table's size, and a plan made for a table of one row would read every event for each one added.
        batch = min(events - have, 1_000 if have < 10_000 else 100_000)
        await conn.execute(
            "insert into audit_event (at, actor, actor_role, action, subject, request_id, reason, body, prev_hash, hash) "
            "select timestamptz '2025-06-01 00:00+00' + make_interval(secs => g * 20), "
            "case when g % 1000 = 0 then 'finance-1' when g % 2 = 0 then 'payments' else 'subscriber-' || (g % 480000 + 1) end, "
            "case when g % 1000 = 0 then 'finance' when g % 2 = 0 then 'system' else 'subscriber' end, "
            "case when g % 1000 = 0 then 'change.approved' when g % 2 = 0 then 'payment.succeeded' "
            "     else 'subscription.confirmed' end, "
            "case when g % 1000 = 0 then 'change:' || (g / 1000 % 500 + 1) when g % 2 = 0 then 'payment:p_' || lpad(to_hex(g), 32, '0') "
            "     else 'subscription:' || g end, "
            "'measure-' || g, null, jsonb_build_object('n', g), decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex') "
            "from generate_series($1::bigint + 1, $2::bigint) g", have, have + batch)
        await conn.execute("analyze audit_event")
        have += batch
    await conn.execute("vacuum analyze")
    return {"audit_events": await conn.fetchval("select count(*) from audit_event")}


async def run_phase(conn: asyncpg.Connection, phase: str, runs: int) -> dict:
    await conn.execute("vacuum analyze")
    choices = await _choices(conn)
    measured = {}
    for query in queries(phase, choices):
        measured[query.name] = await measure(conn, query, runs)
    return {"phase": phase, "day": DAY.isoformat(), "runs": runs, "choices": {k: v for k, v in choices.items()},
            "conditions": await conditions(conn), "queries": measured}


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("phase", choices=["prepare", "before", "after"])
    parser.add_argument("--url", required=True, help="the database, as its owner")
    parser.add_argument("--audit-events", type=int, default=1_000_000)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if not 1 <= args.runs <= 50:
        parser.error("--runs is between 1 and 50")
    conn = await asyncpg.connect(args.url, command_timeout=3_600)
    try:
        if args.phase == "prepare":
            report = await prepare(conn, args.audit_events)
        else:
            report = await run_phase(conn, args.phase, args.runs)
    finally:
        await conn.close()
    text = json.dumps(report, default=str)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "queries"}, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
