"""The compatibility check of the change made in two times (migrations V12 and
V14): a subscription's price, from a column of subscription to a history.

    python -m commerce.compat --phase before    --url <owner URL> --state <file>
    python -m commerce.compat --phase expanded  --url <owner URL> --state <file>
    python -m commerce.compat --phase contracted --url <owner URL> --app-url <engine URL> --state <file>

`npm run check` (the compat suite) runs it on a database of its own, between
Flyway's steps:

1. before, at V11 (the version before the change), on data generated as that
   version wrote it: reads the data the way the engine of that version read
   it, and keeps what it read in the state file;
2. expanded, at V12: the same reads must find the same, so the engine of the
   earlier version still works beside the new one; every price read from the
   history must be the price the column holds; and a subscription written the
   way the earlier engine wrote it must get its history (in a transaction
   that is rolled back);
3. contracted, at the last migration: the old column is gone, so the earlier
   engine's read now fails, as it must only after the expansion; and the
   engine of this version, called as the site and the console call it, must
   show every account at the price kept in step 1 and the home's revenue that
   the earlier version computed.

The earlier engine's reads and writes are frozen here as it ran them (stage
6, commit 6db1bb7: subscribers.py, overview.py and payments.py). Prints one
JSON line; exits 1 when a comparison fails.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, date, datetime
from pathlib import Path

import asyncpg

from commerce.domain.economics import Book

# The day every read is made on, the last day of the generated data, and the instant of the engine's clock.
DAY = date(2026, 10, 24)
AT = datetime(2026, 10, 24, 8, 42, tzinfo=UTC)

# -- the engine of the version before the change (stage 6), as it ran ---------------------------------

V11_ACCOUNT = (
    "select id, plan_id, paid, price_minor, currency, started_on::text as started_on, billing_day, quote_id, "
    "offer_change_id, offer_months from subscription where subscriber_id = $1 and started_on <= $2::text::date "
    "and (ended_on is null or ended_on > $2::text::date)")
V11_HOME = (
    "select s.market, s.plan_id, s.paid, s.price_minor, coalesce(s.offer_months, 0) as offer_months, "
    "case when s.offer_months is null then null else s.started_on::text end as started_on, "
    "case when s.offer_months is null then null else s.billing_day end as billing_day, count(*)::bigint as n "
    "from subscription s "
    "join (select key as market, value::date as day from jsonb_each_text($1::text::jsonb)) d on d.market = s.market "
    "where s.started_on <= d.day and (s.ended_on is null or s.ended_on > d.day) "
    "group by 1, 2, 3, 4, 5, 6, 7 order by 1, 2")
# Its two writes of a subscription: back on the free plan after a declined payment (payments.py), and a
# subscription confirmed from a quote (subscribers.py; here without the quote, which a list price allows).
V11_FREE = (
    "insert into subscription (id, subscriber_id, market, currency, plan_id, paid, price_minor, started_on, billing_day) "
    "values (nextval('subscription_id_seq'), $1, $2, $3, 'free', false, 0, $4::text::date, $5) returning id")
V11_PAID = (
    "insert into subscription (id, subscriber_id, market, currency, plan_id, paid, price_minor, started_on, "
    "billing_day, quote_id, offer_change_id, offer_months) values (nextval('subscription_id_seq'), $1, $2, $3, $4, "
    "true, $5, $6::text::date, $7, $8, $9, $10) returning id")

# -- the history, read with plain SQL during the expansion -----------------------------------------------

HISTORY_PRICE = (
    "select price_minor from subscription_price where subscription_id = $1 and from_on <= $2::text::date "
    "order by from_on desc limit 1")
HISTORY_HOME = (
    "select s.market, s.plan_id, s.paid, p.price_minor, coalesce(s.offer_months, 0) as offer_months, "
    "case when s.offer_months is null then null else s.started_on::text end as started_on, "
    "case when s.offer_months is null then null else s.billing_day end as billing_day, count(*)::bigint as n "
    "from subscription s "
    "join (select key as market, value::date as day from jsonb_each_text($1::text::jsonb)) d on d.market = s.market "
    "join lateral (select h.price_minor from subscription_price h where h.subscription_id = s.id and h.from_on <= d.day "
    "  order by h.from_on desc limit 1) p on true "
    "where s.started_on <= d.day and (s.ended_on is null or s.ended_on > d.day) "
    "group by 1, 2, 3, 4, 5, 6, 7 order by 1, 2")


def _days(markets: list[str]) -> str:
    return json.dumps({code: DAY.isoformat() for code in markets})


def _rows(records) -> list[list]:
    return [[r[k].strip() if isinstance(r[k], str) and k == "market" else r[k] for k in r.keys()] for r in records]


async def _accounts(conn: asyncpg.Connection, subscribers: list[int], read: str) -> dict[str, list]:
    out = {}
    for subscriber in subscribers:
        row = await conn.fetchrow(read, subscriber, DAY.isoformat())
        out[str(subscriber)] = [row["id"], row["plan_id"], row["paid"], row["price_minor"]] if row else None
    return out


def _revenue(groups: list[list], vat: dict[str, tuple[str, int]]) -> dict[str, int]:
    """What the earlier engine computed for the home from its grouping: the net of every paid subscription.
    The generated data has no offers, whose rows that engine priced through charging.standing."""
    book, revenue = Book(), {}
    for market, _plan, paid, price, offer_months, _started, _day, n in groups:
        if offer_months:
            raise SystemExit("the generated data holds a subscription with an offer: this check prices only list prices")
        if paid:
            currency, vat_bp = vat[market]
            revenue[market] = revenue.get(market, 0) + n * book.terms(currency, vat_bp).net(price)
    return revenue


async def _vat(conn: asyncpg.Connection) -> dict[str, tuple[str, int]]:
    rows = await conn.fetch("select m.code, m.currency, v.rate_bp from market m join vat_rate v on v.market = m.code "
                            "and v.valid @> $1::text::date", DAY.isoformat())
    return {r["code"].strip(): (r["currency"].strip(), r["rate_bp"]) for r in rows}


async def before(conn: asyncpg.Connection) -> dict:
    subscribers = [r["id"] for r in await conn.fetch("select id from subscriber order by id")]
    markets = [r["code"].strip() for r in await conn.fetch("select code from market order by code")]
    groups = _rows(await conn.fetch(V11_HOME, _days(markets)))
    return {"day": DAY.isoformat(), "markets": markets, "accounts": await _accounts(conn, subscribers, V11_ACCOUNT),
            "groups": groups, "revenue": _revenue(groups, await _vat(conn))}


async def expanded(conn: asyncpg.Connection, state: dict) -> dict:
    failures = []
    subscribers = [int(s) for s in state["accounts"]]
    # The earlier engine reads what it read before.
    if await _accounts(conn, subscribers, V11_ACCOUNT) != state["accounts"]:
        failures.append("the earlier engine's account read changed after the expansion")
    if _rows(await conn.fetch(V11_HOME, _days(state["markets"]))) != state["groups"]:
        failures.append("the earlier engine's home read changed after the expansion")
    # The history holds every price the column holds.
    differ = 0
    for account in state["accounts"].values():
        if account is not None and await conn.fetchval(HISTORY_PRICE, account[0], DAY.isoformat()) != account[3]:
            differ += 1
    if differ:
        failures.append(f"{differ} subscriptions cost something else in the history")
    if _rows(await conn.fetch(HISTORY_HOME, _days(state["markets"]))) != state["groups"]:
        failures.append("the home read from the history differs from the column's")
    # A subscription written the earlier engine's way gets its history.
    mirrored = 0
    tx = conn.transaction()
    await tx.start()
    try:
        # A listener of its own: on the free plan from 2 January 2027, then, as a confirmation ends the running
        # subscription before it writes the new one, on Individual from 2 February.
        subscriber = await conn.fetchval("insert into subscriber (id, market, joined_on) "
                                         "select max(id) + 1, 'IT', '2027-01-02' from subscriber returning id")
        free = await conn.fetchval(V11_FREE, subscriber, "IT", "EUR", "2027-01-02", 2)
        await conn.execute("update subscription set ended_on = '2027-02-02' where id = $1", free)
        paid = await conn.fetchval(V11_PAID, subscriber, "IT", "EUR", "individual", 1234, "2027-02-02", 2, None, None, None)
        for subscription, started, price in ((free, "2027-01-02", 0), (paid, "2027-02-02", 1234)):
            row = await conn.fetchrow("select from_on::text as from_on, price_minor, change_id from subscription_price "
                                      "where subscription_id = $1", subscription)
            if row is not None and (row["from_on"], row["price_minor"], row["change_id"]) == (started, price, None):
                mirrored += 1
    finally:
        await tx.rollback()
    if mirrored != 2:
        failures.append(f"{2 - mirrored} of the earlier engine's 2 writes got no history")
    return {"failures": failures, "accounts": len(subscribers), "groups": len(state["groups"]), "writes_mirrored": mirrored,
            "prices_compared": len([a for a in state["accounts"].values() if a is not None])}


async def contracted(conn: asyncpg.Connection, app_url: str, state: dict) -> dict:
    from commerce.adapters.asyncpg_database import AsyncpgDatabase
    from commerce.engine.call import Call, FixedClock
    from commerce.engine.engine import Engine
    from commerce.v1 import overview_pb2, subscriptions_pb2

    failures = []
    try:
        await conn.fetchrow(V11_ACCOUNT, 1, DAY.isoformat())
        failures.append("the old column is still there after the contraction")
    except asyncpg.UndefinedColumnError:
        pass  # the earlier engine's read stops working now, after the expansion, as planned
    database = await AsyncpgDatabase.connect(app_url, max_size=8)
    engine = Engine(database, FixedClock(AT))
    try:
        async def account(subscriber: str) -> tuple[str, list | None]:
            call = Call(request_id=f"compat-account-{subscriber}")
            response = await engine.handle("commerce.v1.SubscriberService/GetAccount", call,
                                           subscriptions_pb2.GetAccountRequest(subscriber_id=int(subscriber)))
            s = response.account.subscription
            return subscriber, [s.subscription_id, s.plan, s.paid, s.price.amount_minor]

        differ = []
        subscribers = [s for s, kept in state["accounts"].items() if kept is not None]
        for at in range(0, len(subscribers), 8):
            for subscriber, seen in await asyncio.gather(*(account(s) for s in subscribers[at:at + 8])):
                if seen != state["accounts"][subscriber]:
                    differ.append(subscriber)
        if differ:
            failures.append(f"{len(differ)} accounts read by this engine differ from the earlier engine's, e.g. {differ[:3]}")
        call = Call(request_id="compat-home-0001", actor="finance-1", role="finance")
        home = await engine.handle("commerce.v1.OverviewService/GetOverview", call, overview_pb2.GetOverviewRequest())
        revenue = {r.market: r.revenue.amount_minor for r in home.monthly_revenue}
        if revenue != state["revenue"]:
            failures.append(f"the home's revenue is {revenue}, the earlier engine's {state['revenue']}")
    finally:
        await database.close()
    return {"failures": failures, "accounts": len(subscribers), "revenue": revenue}


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--phase", required=True, choices=["before", "expanded", "contracted"])
    parser.add_argument("--url", required=True, help="the database, as its owner")
    parser.add_argument("--app-url", help="the database, as the engine's role (contracted)")
    parser.add_argument("--state", required=True, type=Path, help="what the first phase read, for the next ones")
    args = parser.parse_args()
    conn = await asyncpg.connect(args.url)
    try:
        if args.phase == "before":
            state = await before(conn)
            args.state.write_text(json.dumps(state), encoding="utf-8")
            report = {"failures": [], "accounts": len(state["accounts"]), "groups": len(state["groups"]),
                      "revenue": state["revenue"]}
        else:
            state = json.loads(args.state.read_text(encoding="utf-8"))
            if args.phase == "expanded":
                report = await expanded(conn, state)
            else:
                if not args.app_url:
                    parser.error("--app-url is needed to call the engine")
                report = await contracted(conn, args.app_url, state)
    finally:
        await conn.close()
    print(json.dumps({"phase": args.phase, **report}))
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
