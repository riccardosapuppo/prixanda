"""The demo's data, written by the build into PGlite (packages/sandbox/src/engine/build/snapshot.ts).

The same generator as the server's (commerce.generate: the small size, seed
7, the fixed period), through a Writer on PGlite, as the owner, as the
generator writes on the server with the owner's URL. The fingerprint of the
rows comes back with the summary: the schema check compares it with the
server's, generated into PostgreSQL 18 by the same command (tools/check.ts).

And the start of the story: the demo's clock (packages/sandbox/src/engine/
clock.ts) starts there for every visitor, whatever the day, at 08:30 in Rome
on the morning after the data's last day, so that its weeks of listening and
the campaigns' dates stay where the story puts them.
Only the build runs this; generate.py is not part of the browser's package,
the build hands it to Pyodide beside it.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterable, Mapping
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from itertools import islice
from typing import Any

from commerce.browser.pglite import Bridge, PGliteDatabase, _Connection
from commerce.domain.localtime import format_instant, to_instant

STORY_STARTS = time(8, 30)  # in Rome, on the morning after the data's last day

ROWS_PER_COPY = 50_000


def _csv_field(value: Any) -> str:
    """A field of PostgreSQL's CSV: nothing for NULL, a text always quoted, so that an empty text stays one."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "t" if value else "f"
    if isinstance(value, (int, Decimal)):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray)):
        return "\\x" + bytes(value).hex()
    if isinstance(value, str):
        return '"' + value.replace('"', '""') + '"'
    raise TypeError(f"a field of type {type(value).__name__}")


def csv_rows(records: Iterable[tuple]) -> str:
    return "".join(",".join(_csv_field(value) for value in record) + "\n" for record in records)


class PGliteWriter:
    """The generator's Writer (generate.py) on PGlite: each transaction as the owner."""

    def __init__(self, db: PGliteDatabase) -> None:
        self.db = db
        self.tx: _Connection | None = None

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[_Connection]:
        async with self.db.transaction() as tx:
            await tx.execute("set local role postgres")
            self.tx = tx
            try:
                yield tx
            finally:
                self.tx = None

    async def _run(self, method: str, sql: str, *args: Any) -> Any:
        if self.tx is not None:
            return await getattr(self.tx, method)(sql, *args)
        async with self.transaction() as tx:
            return await getattr(tx, method)(sql, *args)

    async def execute(self, sql: str, *args: Any) -> None:
        await self._run("execute", sql, *args)

    async def fetchval(self, sql: str, *args: Any) -> Any:
        return await self._run("fetchval", sql, *args)

    async def fetch(self, sql: str, *args: Any) -> list[Mapping[str, Any]]:
        return await self._run("fetch", sql, *args)

    async def copy(self, table: str, columns: list[str], records: Iterable[tuple]) -> None:
        sql = f"copy {table} ({', '.join(columns)}) from '/dev/blob' with (format csv)"
        rows = iter(records)
        while chunk := list(islice(rows, ROWS_PER_COPY)):
            if self.tx is not None:
                await self.tx.copy(sql, csv_rows(chunk))
            else:
                async with self.transaction() as tx:
                    await tx.copy(sql, csv_rows(chunk))


async def build(bridge: Bridge, size: str = "small", seed: int = 7) -> str:
    """The small data in a database just migrated, and its fingerprint (JSON)."""
    from commerce.generate import START, UNTIL, fingerprint, load

    writer = PGliteWriter(PGliteDatabase(bridge))
    summary = await load(writer, size, seed, START, UNTIL)
    summary["fingerprint"] = await fingerprint(writer)
    story = format_instant(story_start(UNTIL))
    await writer.execute("update demo.clock set now_at = $1::text::timestamptz, moved_at = null", story)
    summary["story"] = story
    return json.dumps(summary, default=str)


def story_start(until: date) -> datetime:
    """The start of the story on the demo's clock: 08:30 in Rome on the day after the data's last one."""
    return to_instant(datetime.combine(until + timedelta(days=1), STORY_STARTS), "Europe/Rome")


async def fingerprint_of(bridge: Bridge) -> str:
    """The fingerprint of the rows of a database: the build reads its snapshot back with it."""
    from commerce.generate import fingerprint

    return await fingerprint(PGliteWriter(PGliteDatabase(bridge)))
