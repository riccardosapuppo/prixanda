"""A small, hand-written world for the engine's tests: the people of the demo,
what each plan includes, the price list of §4.4, the named artists, and a
dozen subscribers chosen so that each audience rule has someone inside it and
someone just outside it. The clock of the tests is 24 October 2026, 08:42 UTC.

Italy
  101  Free, never paid, verified student            in the Student Autumn Pass audience
  102  Free, never paid, not verified                out: no student check
  103  Student since February, verified             out: pays already
  104  paid Individual Feb-Jun, Free since, verified  out: has paid
  105  Free, never paid, verification expired         out: verification over
  106  Individual since March
Germany
  201  Free, 7 hours of Doppelfenster, 10-23 October  in the release campaign audience (over 3 hours)
  202  Free, 2 hours of Doppelfenster                out: under 3 hours
  203  Family since February
  204  Free, 5 hours of Doppelfenster in early September  out: before the 30 days
United Kingdom
  301  Individual since March
France
  401  Free, never paid
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import asyncpg

from commerce.generate import CURRENCY, ENTITLEMENTS, LABELS, NAMED_ARTISTS, PRICES
from helpers import add_people, add_subscription

BEGINNING = datetime(2025, 1, 1)
JOINED = date(2026, 1, 10)

# subscriber: (market, [(plan, price, started, ended)], [(verified_on, valid_until)])
SUBSCRIBERS = {
    101: ("IT", [("free", 0, JOINED, None)], [(date(2026, 9, 1), date(2027, 9, 1))]),
    102: ("IT", [("free", 0, JOINED, None)], []),
    103: ("IT", [("free", 0, JOINED, date(2026, 2, 1)), ("student", 579, date(2026, 2, 1), None)],
          [(date(2026, 1, 25), date(2027, 1, 25))]),
    104: ("IT", [("free", 0, JOINED, date(2026, 2, 1)), ("individual", 1049, date(2026, 2, 1), date(2026, 6, 1)),
                 ("free", 0, date(2026, 6, 1), None)], [(date(2026, 9, 1), date(2027, 9, 1))]),
    105: ("IT", [("free", 0, JOINED, None)], [(date(2025, 9, 1), date(2026, 9, 1))]),
    106: ("IT", [("free", 0, JOINED, date(2026, 3, 1)), ("individual", 1049, date(2026, 3, 1), None)], []),
    201: ("DE", [("free", 0, JOINED, None)], []),
    202: ("DE", [("free", 0, JOINED, None)], []),
    203: ("DE", [("free", 0, JOINED, date(2026, 2, 1)), ("family", 1899, date(2026, 2, 1), None)], []),
    204: ("DE", [("free", 0, JOINED, None)], []),
    301: ("GB", [("free", 0, JOINED, date(2026, 3, 1)), ("individual", 949, date(2026, 3, 1), None)], []),
    401: ("FR", [("free", 0, JOINED, None)], []),
}
# The demo's listeners among them, as the site's entrance offers them.
DEMO_LISTENERS = [
    (101, 1, "Student in Italy, verified", "Simulated listener. A verified student in Italy who has never paid.", True),
    (102, 2, "Student in Italy, not verified yet", "Simulated listener. A student in Italy who has not verified yet.", True),
    (104, 3, "Student in Italy who paid before", "Simulated listener. A verified student in Italy who paid before.", True),
    (401, 4, "Free listener in France", "Simulated listener. On Free in France and not a student.", False),
]
DOPPELFENSTER = 4
# subscriber: (first day, days, seconds a day) of Doppelfenster
LISTENING = {
    201: (date(2026, 10, 10), 14, 1_800),  # 7 hours, inside the 30 days on 24 October and on 6 November
    202: (date(2026, 10, 10), 2, 3_600),  # 2 hours
    204: (date(2026, 9, 1), 5, 3_600),  # 5 hours, before the window
}


async def seed(conn: asyncpg.Connection) -> None:
    await add_people(conn)
    for market in PRICES:
        for plan, (skips, audio, offline) in ENTITLEMENTS.items():
            await conn.execute("insert into plan_entitlement (plan_id, market, skips_per_hour, audio, offline, valid) "
                               "values ($1, $2, $3, $4, $5, tsrange($6, null))", plan, market, skips, audio, offline, BEGINNING)
        for plan, amount in PRICES[market].items():
            await conn.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                               "values ($1, $2, $3, $4, tsrange($5, null))", plan, market, CURRENCY[market], amount, BEGINNING)
    await conn.copy_records_to_table("label", records=LABELS, columns=["id", "name", "country"])
    await conn.copy_records_to_table("artist", records=[(a, n, label, c) for a, n, label, c, _ in NAMED_ARTISTS],
                                     columns=["id", "name", "label_id", "country"])
    subscription = 0
    for subscriber, (market, history, checks) in SUBSCRIBERS.items():
        await conn.execute("insert into subscriber (id, market, joined_on) values ($1, $2, $3)", subscriber, market, JOINED)
        for plan, price, started, ended in history:
            subscription += 1
            await add_subscription(conn, subscriber, market, plan, price, started, subscription=subscription, ended=ended)
        for verified, until in checks:
            await conn.execute("insert into student_verification (subscriber_id, verified_on, valid_until, provider) "
                               "values ($1, $2, $3, 'simulated')", subscriber, verified, until)
    await conn.copy_records_to_table("demo_listener", records=DEMO_LISTENERS,
                                     columns=["subscriber_id", "position", "title", "label", "student"])
    for subscriber, (first, days, seconds) in LISTENING.items():
        for n in range(days):
            await conn.execute("insert into listening_day (subscriber_id, artist_id, day, seconds) values ($1, $2, $3, $4)",
                               subscriber, DOPPELFENSTER, first + timedelta(days=n), seconds)
