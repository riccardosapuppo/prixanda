"""The generated data of the music service: deterministic for a seed, in two sizes.

    python -m commerce.generate --url <owner URL> --size small --seed 7

It loads, into a database that Flyway has just migrated:

* the people of the demo, named by role (business book §12.1);
* what each plan includes and the price list at the start of the data, in
  every market (§2, §4.4);
* labels, artists and releases: seven invented ones that the interface
  shows by name, and filler ones with invented names;
* subscribers with their subscription history (everyone starts on Free;
  some move to a paid plan, some leave it again), student verifications,
  including free listeners who verified and have not subscribed yet;
* the demo's listeners, four people the site's entrance offers, each showing
  one situation and labelled as simulated;
* listening data for the last weeks, which fan campaigns are aimed with (§14.2);
* one audit event saying what was generated, from which seed.

Nothing reads the clock: the period is --start to --until, fixed by default.
The same seed, size and period give the same rows, and --fingerprint prints a
hash of them, which the tests compare across two databases.

The rows are written through a Writer: asyncpg here, and PGlite when the
browser's demo builds its snapshot (browser/snapshot.py), so that the demo
holds the same small data as the server, with the same fingerprint. asyncpg
is imported only by the functions that connect.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import random
import sys
import time
from collections.abc import Iterable, Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    import asyncpg

# The period of the data: fixed, never "today".
START = date(2025, 1, 1)
UNTIL = date(2026, 10, 24)


@dataclass(frozen=True)
class Size:
    paying: int
    free: int
    filler_artists: int
    listening_days: int


SIZES = {
    "small": Size(paying=2_000, free=3_000, filler_artists=40, listening_days=35),
    "full": Size(paying=200_000, free=280_000, filler_artists=400, listening_days=35),
}

MARKETS = {"IT": 0.20, "FR": 0.22, "DE": 0.27, "GB": 0.31}
PAID_PLANS = {"individual": 0.56, "duo": 0.12, "family": 0.15, "student": 0.17}

# Business book §4.4: prices at the start of the data, including VAT.
PRICES = {
    "IT": {"individual": 1049, "duo": 1449, "family": 1799, "student": 579},
    "FR": {"individual": 1099, "duo": 1499, "family": 1849, "student": 649},
    "DE": {"individual": 1099, "duo": 1499, "family": 1899, "student": 599},
    "GB": {"individual": 949, "duo": 1299, "family": 1649, "student": 529},
}
CURRENCY = {"IT": "EUR", "FR": "EUR", "DE": "EUR", "GB": "GBP"}

# Business book §2.1.
ENTITLEMENTS = {
    "free": (6, "standard", False),
    "individual": (None, "lossless", True),
    "duo": (None, "lossless", True),
    "family": (None, "lossless", True),
    "student": (None, "lossless", True),
}

PEOPLE = {
    "marketing-1": ("Marketing", ["marketing"]),
    "marketing-2": ("Marketing, second", ["marketing"]),
    "commercial-lead-1": ("Commercial lead", ["commercial_lead"]),
    "finance-1": ("Finance", ["finance"]),
    "catalog-manager-1": ("Catalog manager", ["catalog_manager"]),
    "on-call-1": ("On-call engineer", ["on_call"]),
    "auditor-1": ("Auditor", ["auditor"]),
}

# Invented labels and artists that the interface shows by name; checked
# against existing acts on 24 October 2026.
LABELS = [(1, "Casa Lenta", "IT"), (2, "Disques Pareil", "FR"), (3, "Kellerlicht", "DE"), (4, "Coldframe Records", "GB")]
NAMED_ARTISTS = [
    (1, "Velluto Basso", 1, "IT", "Stanze al piano terra"),
    (2, "Ottoline Marr", 4, "GB", "Low Tide Hymns"),
    (3, "Ciel Fendu", 2, "FR", "Lumière de service"),
    (4, "Doppelfenster", 3, "DE", "Nordflur"),
    (5, "Pinewire", 4, "GB", "Signal Fires"),
    (6, "Corale Ferrovia", 1, "IT", "Binario Morto"),
    (7, "Halde", 3, "DE", "Abraum"),
]
# Filler names are put together from invented syllables, not from words.
SYLLABLES = ["vel", "mar", "osk", "tin", "dra", "lu", "ber", "sko", "ane", "riv", "quo", "len",
             "fai", "mot", "zur", "pel", "ido", "sha", "kre", "nov", "ulm", "taz", "bri", "ech"]


def filler_name(rng: random.Random, taken: set[str]) -> str:
    while True:
        first = "".join(rng.choice(SYLLABLES) for _ in range(rng.randint(2, 3))).capitalize()
        second = "".join(rng.choice(SYLLABLES) for _ in range(2)).capitalize()
        name = f"{first} {second}" if rng.random() < 0.6 else first
        if name not in taken:
            taken.add(name)
            return name


def pick(rng: random.Random, weights: dict[str, float]) -> str:
    return rng.choices(list(weights), weights=list(weights.values()))[0]


def day_between(rng: random.Random, first: date, last: date) -> date:
    return first + timedelta(days=rng.randint(0, max(0, (last - first).days)))


def plan_people(rng: random.Random, size: Size, start: date, until: date):
    """Subscribers, their subscriptions and student verifications, in memory."""
    subscribers, subscriptions, verifications = [], [], []
    subscription_id = 0
    total = size.paying + size.free
    paying_ids = set(rng.sample(range(1, total + 1), size.paying))
    for subscriber_id in range(1, total + 1):
        market = pick(rng, MARKETS)
        joined = day_between(rng, start, until - timedelta(days=2))
        subscribers.append((subscriber_id, market, joined))
        billing_day = rng.randint(1, 28)
        currency = CURRENCY[market]
        if subscriber_id not in paying_ids:
            subscription_id += 1
            subscriptions.append((subscription_id, subscriber_id, market, currency, "free", False, 0, joined, None, billing_day))
            continue
        plan = pick(rng, PAID_PLANS)
        upgraded = min(joined + timedelta(days=rng.randint(0, 60)), until - timedelta(days=1))
        if upgraded > joined:
            subscription_id += 1
            subscriptions.append((subscription_id, subscriber_id, market, currency, "free", False, 0, joined, upgraded, billing_day))
        left = None
        if rng.random() < 0.10 and (until - upgraded).days > 40:
            left = day_between(rng, upgraded + timedelta(days=30), until - timedelta(days=1))
        if plan == "student":
            # Verified at most ten days before the Student price starts, for 12
            # months; renewed while the subscription continues (§10.2).
            verified = max(joined, upgraded - timedelta(days=rng.randint(0, 10)))
            end = left or until
            while True:
                valid_until = add_months(verified, 12)
                verifications.append((subscriber_id, verified, valid_until, "simulated"))
                if valid_until > end:
                    break
                verified = valid_until - timedelta(days=rng.randint(0, 20))
        subscription_id += 1
        subscriptions.append((subscription_id, subscriber_id, market, currency, plan, True, PRICES[market][plan], upgraded, left, billing_day))
        if left:
            subscription_id += 1
            subscriptions.append((subscription_id, subscriber_id, market, currency, "free", False, 0, left, None, billing_day))
    return subscribers, subscriptions, verifications


# Free listeners who never paid and have verified as students in the last
# eleven months, so that a student offer for new subscribers reaches someone
# (§14.1, §14.5). A stream of its own, so the other rows stay as they were.
FREE_STUDENT_SHARE = 0.15


def verify_free_students(seed: int, subscribers, subscriptions, until: date):
    rng = random.Random(f"{seed}/free-students")
    paid = {row[1] for row in subscriptions if row[5]}
    verifications = []
    for subscriber_id, _market, joined in subscribers:
        if subscriber_id in paid or rng.random() >= FREE_STUDENT_SHARE:
            continue
        verified = day_between(rng, max(joined, until - timedelta(days=330)), until - timedelta(days=1))
        verifications.append((subscriber_id, verified, add_months(verified, 12), "simulated"))
    return verifications


# The listeners the site's entrance offers (§14.1, §14.3, §14.5), each showing
# one situation. They come after the generated people, with numbers of their
# own and dates fixed relative to --until, so the other rows stay as they were;
# a listener added later comes after the others, for the same reason.
# student tells the simulated verifier whether this listener has a student
# record; paid is a paid plan from a day, billed on that day of each month.
DEMO_LISTENERS = [
    {"title": "Student in Italy, verified", "market": "IT", "joined": 200, "student": True,
     "label": "Simulated listener. A verified student in Italy who has never paid: the Student Autumn Pass is for them.",
     "verified": [50]},
    {"title": "Student in Italy, not verified yet", "market": "IT", "joined": 150, "student": True,
     "label": "Simulated listener. A student in Italy who has never paid and has not verified yet: "
              "verifying opens the student offers.",
     "verified": []},
    {"title": "Student in Italy who paid before", "market": "IT", "joined": 400, "student": True,
     "label": "Simulated listener. A verified student in Italy who paid for Student before: "
              "offers for people who have never paid are not for them.",
     "verified": [375, 30], "paid_student": (370, 120)},
    {"title": "Free listener in France", "market": "FR", "joined": 300, "student": False,
     "label": "Simulated listener. On Free in France and not a student: list prices, and no offer for them.",
     "verified": []},
    # From 15 June 2025 with the default --until (24 October 2026): billed on the 15th.
    {"title": "Family subscriber in Germany", "market": "DE", "joined": 600, "student": False,
     "label": "Simulated listener. Pays for Family in Germany since June 2025, billed on the 15th: a price rise there "
              "asks for their consent first (§8.2).",
     "verified": [], "paid": ("family", 496)},
    # From 8 May 2026 with the default --until: billed on the 8th.
    {"title": "Individual subscriber in Italy", "market": "IT", "joined": 260, "student": False,
     "label": "Simulated listener. Pays for Individual in Italy since May 2026, billed on the 8th: a price rise there "
              "comes with notice, and they may leave before it applies (§8.3).",
     "verified": [], "paid": ("individual", 169)},
]


def demo_listeners(first_subscriber: int, first_subscription: int, start: date, until: date):
    """The demo's listeners: their subscriber rows, subscriptions, verifications and labels.
    Days are counted back from --until."""
    def back(days: int) -> date:
        return max(start, until - timedelta(days=days))

    subscribers, subscriptions, verifications, rows = [], [], [], []
    subscription_id = first_subscription
    for position, demo in enumerate(DEMO_LISTENERS, start=1):
        subscriber_id = first_subscriber + position - 1
        market, joined = demo["market"], back(demo["joined"])
        subscribers.append((subscriber_id, market, joined))
        history = [("free", False, 0, joined)]
        billing_day = 12
        if "paid_student" in demo:
            began, ended = (back(days) for days in demo["paid_student"])
            history = [("free", False, 0, joined), ("student", True, PRICES[market]["student"], began), ("free", False, 0, ended)]
        if "paid" in demo:
            plan, days = demo["paid"]
            began = back(days)
            history = [("free", False, 0, joined), (plan, True, PRICES[market][plan], began)]
            billing_day = min(began.day, 28)
        for n, (plan, paid, price, began) in enumerate(history):
            ended = history[n + 1][3] if n + 1 < len(history) else None
            subscriptions.append((subscription_id, subscriber_id, market, CURRENCY[market], plan, paid, price, began, ended,
                                  billing_day))
            subscription_id += 1
        for days in demo["verified"]:
            verified = back(days)
            verifications.append((subscriber_id, verified, add_months(verified, 12), "simulated"))
        rows.append((subscriber_id, position, demo["title"], demo["label"], demo["student"]))
    return subscribers, subscriptions, verifications, rows


def add_months(day: date, months: int) -> date:
    month = day.month - 1 + months
    year, month = day.year + month // 12, month % 12 + 1
    for candidate in (day.day, 30, 29, 28):
        try:
            return date(year, month, min(day.day, candidate))
        except ValueError:
            continue
    raise ValueError(day)


def listening(rng: random.Random, size: Size, subscribers, subscriptions, artists: list[int], until: date, counter: list[int]):
    """Seconds per listener, artist and day over the last weeks, streamed to the
    database rather than held in memory. A few artists are played much more
    than the rest, and Doppelfenster has its fans in Germany."""
    days = [until - timedelta(days=size.listening_days - offset) for offset in range(size.listening_days)]
    current = {row[1]: row for row in subscriptions if row[8] is None}
    weights = [1.0 / (rank + 1) ** 1.1 for rank in range(len(artists))]
    for subscriber_id, market, joined in subscribers:
        paid = current[subscriber_id][5]
        active = 0.5 if paid else 0.25
        fan = market == "DE" and rng.random() < 0.08
        for day in days:
            if day < joined or rng.random() > active:
                continue
            played = set(rng.choices(artists, weights=weights, k=rng.randint(1, 3)))
            if fan and rng.random() < 0.6:
                played.add(4)
            for artist_id in sorted(played):
                seconds = rng.randint(300, 7_200 if paid else 3_600)
                if fan and artist_id == 4:
                    seconds = rng.randint(1_800, 5_400)
                counter[0] += 1
                yield (subscriber_id, artist_id, day, seconds)


# A hash per row, summed: it does not depend on the order rows were written
# in, and never builds one huge text (PostgreSQL caps a text at 1 GB).
FINGERPRINTED = ["person", "person_role", "plan_entitlement", "list_price", "label", "artist", "release",
                 "subscriber", "subscription", "subscription_price", "student_verification", "listening_day", "demo_listener"]


class Writer(Protocol):
    """Where the rows go: a database freshly migrated, as its owner."""

    async def execute(self, sql: str, *args: Any) -> None: ...

    async def fetchval(self, sql: str, *args: Any) -> Any: ...

    async def fetch(self, sql: str, *args: Any) -> list[Mapping[str, Any]]: ...

    async def copy(self, table: str, columns: list[str], records: Iterable[tuple]) -> None: ...

    def transaction(self) -> AbstractAsyncContextManager[Any]: ...


class AsyncpgWriter:
    def __init__(self, conn: asyncpg.Connection) -> None:
        self.conn = conn

    async def execute(self, sql: str, *args: Any) -> None:
        await self.conn.execute(sql, *args)

    async def fetchval(self, sql: str, *args: Any) -> Any:
        return await self.conn.fetchval(sql, *args)

    async def fetch(self, sql: str, *args: Any) -> list[Mapping[str, Any]]:
        return await self.conn.fetch(sql, *args)

    async def copy(self, table: str, columns: list[str], records: Iterable[tuple]) -> None:
        await self.conn.copy_records_to_table(table, records=records, columns=columns)

    def transaction(self) -> AbstractAsyncContextManager[Any]:
        return self.conn.transaction()


async def write_subscriptions(conn: Writer, subscriptions: list[tuple]) -> None:
    """Each subscription with the price it starts at, where the schema keeps it: since migration V14 the first row of
    its history; before it a column of the subscription, which a trigger copied into the history from V12 on. So the
    compatibility check (compat.py) can write the data of the version before the history too."""
    column = await conn.fetchval(
        "select exists (select from information_schema.columns where table_schema = current_schema() "
        "and table_name = 'subscription' and column_name = 'price_minor')")
    columns = ["id", "subscriber_id", "market", "currency", "plan_id", "paid", "price_minor", "started_on", "ended_on",
               "billing_day"]
    if column:
        await conn.copy("subscription", columns, subscriptions)
        return
    price, started = columns.index("price_minor"), columns.index("started_on")
    await conn.copy("subscription", columns[:price] + columns[price + 1:], [s[:price] + s[price + 1:] for s in subscriptions])
    await conn.copy("subscription_price", ["subscription_id", "from_on", "price_minor"],
                    [(s[0], s[started], s[price]) for s in subscriptions])


async def fingerprint(conn: Writer | asyncpg.Connection) -> str:
    parts = []
    for table in FINGERPRINTED:
        # Identity columns are left out: they number rows, they are not data.
        row = "(to_jsonb(t) - 'id')" if table in ("plan_entitlement", "list_price") else "t"
        total = await conn.fetchval(f"select count(*)::text || ':' || coalesce(sum(hashtextextended({row}::text, 0)::numeric), 0)::text from {table} t")
        parts.append(f"{table}={total}")
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


async def generate(url: str, size_name: str, seed: int, start: date, until: date, *, listening_days: int | None = None) -> dict:
    """listening_days, when given, replaces the size's weeks of listening: the measurements (measure.py) can ask
    for a longer history than the data of the demo holds."""
    import asyncpg

    conn = await asyncpg.connect(url)
    try:
        return await load(AsyncpgWriter(conn), size_name, seed, start, until, listening_days=listening_days)
    finally:
        await conn.close()


async def load(conn: Writer, size_name: str, seed: int, start: date, until: date, *,
               listening_days: int | None = None) -> dict:
    """The generated rows, written through a Writer into a database freshly migrated."""
    size = SIZES[size_name] if listening_days is None else replace(SIZES[size_name], listening_days=listening_days)
    rng = random.Random(seed)
    timings: dict[str, int] = {}
    begun = time.perf_counter()

    def lap(name: str) -> None:
        nonlocal begun
        timings[name] = round((time.perf_counter() - begun) * 1000)
        begun = time.perf_counter()

    if await conn.fetchval("select count(*) from subscriber"):
        raise SystemExit("this database already holds generated data: generate into a freshly migrated one")
    async with conn.transaction():
        for person, (label, roles) in PEOPLE.items():
            await conn.execute("insert into person (id, label) values ($1, $2)", person, label)
            for role in roles:
                await conn.execute("insert into person_role (person_id, role) values ($1, $2)", person, role)
        beginning = datetime.combine(start, datetime.min.time())
        for market in MARKETS:
            for plan, (skips, audio, offline) in ENTITLEMENTS.items():
                await conn.execute(
                    "insert into plan_entitlement (plan_id, market, skips_per_hour, audio, offline, valid) "
                    "values ($1, $2, $3, $4, $5, tsrange($6, null))", plan, market, skips, audio, offline, beginning)
            for plan, amount in PRICES[market].items():
                await conn.execute(
                    "insert into list_price (plan_id, market, currency, amount_minor, valid) "
                    "values ($1, $2, $3, $4, tsrange($5, null))", plan, market, CURRENCY[market], amount, beginning)
        await conn.copy("label", ["id", "name", "country"], LABELS)
        taken = {name for _, name, *_ in NAMED_ARTISTS}
        artists = [(a, name, label, country) for a, name, label, country, _ in NAMED_ARTISTS]
        releases = [(a, a, title, date(2026, 11, 6) if a == 4 else day_between(rng, start, until)) for a, _, _, _, title in NAMED_ARTISTS]
        for n in range(size.filler_artists):
            artist_id = len(NAMED_ARTISTS) + n + 1
            artists.append((artist_id, filler_name(rng, taken), rng.randint(1, len(LABELS)), rng.choice(list(MARKETS))))
            releases.append((artist_id, artist_id, filler_name(rng, taken), day_between(rng, start, until)))
        await conn.copy("artist", ["id", "name", "label_id", "country"], artists)
        await conn.copy("release", ["id", "artist_id", "title", "released_on"], releases)
        lap("reference")

        subscribers, subscriptions, verifications = plan_people(rng, size, start, until)
        verifications += verify_free_students(seed, subscribers, subscriptions, until)
        demo = demo_listeners(len(subscribers) + 1, len(subscriptions) + 1, start, until)
        subscribers, subscriptions, verifications = subscribers + demo[0], subscriptions + demo[1], verifications + demo[2]
        lap("plan_people")
        await conn.copy("subscriber", ["id", "market", "joined_on"], subscribers)
        await write_subscriptions(conn, subscriptions)
        await conn.copy("student_verification", ["subscriber_id", "verified_on", "valid_until", "provider"], verifications)
        await conn.copy("demo_listener", ["subscriber_id", "position", "title", "label", "student"], demo[3])
        lap("write_people")

        listened = [0]
        await conn.copy("listening_day", ["subscriber_id", "artist_id", "day", "seconds"],
                        listening(rng, size, subscribers, subscriptions, [a[0] for a in artists], until, listened))
        lap("listening")

        counts = {
            "subscribers": len(subscribers), "subscriptions": len(subscriptions), "student_verifications": len(verifications),
            "demo_listeners": len(demo[3]), "artists": len(artists), "listening_days": listened[0],
        }
        await conn.execute(
            "insert into audit_event (at, actor, actor_role, action, subject, request_id, reason, body, prev_hash, hash) "
            "values ($1, 'data-generator', 'system', 'data.generated', 'database', $2, null, $3::jsonb, $4, $4)",
            datetime.combine(until, datetime.min.time(), tzinfo=UTC), f"generate-{size_name}-{seed}",
            json.dumps({"size": size_name, "seed": seed, "start": start.isoformat(), "until": until.isoformat(), **counts}),
            bytes(32))
    await conn.execute("analyze")
    lap("commit_and_analyze")
    by_market_plan = await conn.fetch(
        "select market, plan_id, count(*)::int as n from subscription where ended_on is null group by 1, 2 order by 1, 2")
    return {
        "size": size_name, "seed": seed, "start": start.isoformat(), "until": until.isoformat(),
        "listening_days": size.listening_days, "counts": counts,
        "current_subscriptions": {f"{r['market']}/{r['plan_id']}": r["n"] for r in by_market_plan},
        "database_bytes": await conn.fetchval("select pg_database_size(current_database())"),
        "timings_ms": timings,
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", required=True, help="the database, as its owner")
    parser.add_argument("--size", choices=sorted(SIZES), default="small")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--start", type=date.fromisoformat, default=START)
    parser.add_argument("--until", type=date.fromisoformat, default=UNTIL)
    parser.add_argument("--listening-days", type=int, help="days of listening before --until, instead of the size's")
    parser.add_argument("--fingerprint", action="store_true", help="only print the fingerprint of the generated rows")
    args = parser.parse_args()
    if args.fingerprint:
        import asyncpg

        conn = await asyncpg.connect(args.url)
        try:
            print(await fingerprint(conn))
        finally:
            await conn.close()
        return 0
    if args.until <= args.start:
        parser.error("--until must come after --start")
    if args.listening_days is not None and not 1 <= args.listening_days <= 730:
        parser.error("--listening-days is between 1 and 730")
    summary = await generate(args.url, args.size, args.seed, args.start, args.until, listening_days=args.listening_days)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
