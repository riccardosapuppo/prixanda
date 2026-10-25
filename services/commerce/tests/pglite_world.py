"""The engine's tests on the browser's database (stage 8): PGlite, in a Node
process of its own (packages/sandbox/test/engine/bridge/server.ts), reached
through the same adapter as the browser's engine (commerce.browser.pglite)
and the same Session on the page's side (database.ts). With
COMMERCE_TEST_DATABASE=pglite, the `world` of the service tests is built on
it: a template migrated by the browser's runner and seeded by tests/seed.py,
then a PGlite of its own for each test, cloned from it.

The owner's connection the tests write with (world.owner) is the owner on
the same session: each of its statements in a transaction of its own as
postgres, as an asyncpg connection would answer it, rows as asyncpg's
records. PGlite is one session: a test that holds a transaction of the owner
open while the engine works, or opens a second connection, cannot run on it;
those are listed in the check (tools/check.ts, sandbox-services) with the
reason, and run on PostgreSQL only.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
from collections.abc import AsyncIterator, Iterable, Iterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from commerce.browser.pglite import PGliteDatabase, _Connection

REPO = Path(__file__).resolve().parents[3]
BRIDGE = REPO / "packages" / "sandbox" / "test" / "engine" / "bridge" / "server.ts"


class Node:
    """The Node process that holds the PGlite instances: requests out as lines, answers in by their id."""

    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None
        self.waiting: dict[int, asyncio.Future] = {}
        self.next = 0
        self.reader: asyncio.Task | None = None

    async def start(self) -> None:
        self.process = await asyncio.create_subprocess_exec(
            "node", str(BRIDGE), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, cwd=str(REPO),
            limit=64 * 1024 * 1024)
        self.reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        assert self.process and self.process.stdout
        while line := await self.process.stdout.readline():
            answer = json.loads(line)
            future = self.waiting.pop(answer.pop("id"), None)
            if future is not None and not future.done():
                future.set_result(answer)
        for future in self.waiting.values():
            if not future.done():
                future.set_exception(RuntimeError("the PGlite process ended"))

    async def ask(self, op: str, **fields: Any) -> dict[str, Any]:
        assert self.process and self.process.stdin
        self.next += 1
        future = asyncio.get_running_loop().create_future()
        self.waiting[self.next] = future
        self.process.stdin.write((json.dumps({"id": self.next, "op": op, **fields}) + "\n").encode())
        await self.process.stdin.drain()
        answer = await future
        if "error" in answer:
            raise RuntimeError(f"PGlite's process: {answer['error']}")
        return answer

    async def stop(self) -> None:
        if self.process and self.process.stdin:
            self.process.stdin.close()
            await self.process.wait()
        if self.reader:
            await self.reader


class InstanceBridge:
    """commerce.browser.pglite's Bridge on one PGlite instance of the Node process."""

    def __init__(self, node: Node, instance: int) -> None:
        self.node = node
        self.instance = instance

    async def begin(self, readonly: bool) -> str:
        return (await self.node.ask("begin", instance=self.instance, readonly=readonly))["reply"]

    async def query(self, tx: int, sql: str, params: str) -> str:
        return (await self.node.ask("query", instance=self.instance, tx=tx, sql=sql, params=params))["reply"]

    async def copy(self, tx: int, sql: str, data: str) -> str:
        return (await self.node.ask("copy", instance=self.instance, tx=tx, sql=sql, data=data))["reply"]

    async def end(self, tx: int, commit: bool) -> str:
        return (await self.node.ask("end", instance=self.instance, tx=tx, commit=commit))["reply"]


class Record(Mapping):
    """A row as asyncpg gives it: by name or by position, its values when iterated."""

    def __init__(self, row: Mapping[str, Any]) -> None:
        self._row = dict(row)
        self._values = list(self._row.values())

    def __getitem__(self, key: str | int) -> Any:
        return self._values[key] if isinstance(key, int) else self._row[key]

    def __iter__(self) -> Iterator[Any]:
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._row)

    def keys(self):
        return self._row.keys()

    def values(self):
        return self._row.values()

    def items(self):
        return self._row.items()

    def get(self, key: str, default: Any = None) -> Any:
        return self._row.get(key, default)

    def __eq__(self, other: object) -> bool:
        return self._row == (other._row if isinstance(other, Record) else other)

    def __repr__(self) -> str:
        return f"<Record {self._row!r}>"


def _csv(records: Iterable[tuple]) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    for record in records:
        writer.writerow(["\\N" if value is None else ("t" if value is True else "f" if value is False else value) for value in record])
    return out.getvalue()


class Owner:
    """The owner's connection of the tests, on the same PGlite session: asyncpg's methods the tests call."""

    def __init__(self, db: PGliteDatabase) -> None:
        self.db = db
        self.tx: _Connection | None = None

    @asynccontextmanager
    async def transaction(self, *, isolation: str | None = None, readonly: bool = False,
                          deferrable: bool = False) -> AsyncIterator[None]:
        if self.tx is not None:
            async with self.tx.savepoint():
                yield
            return
        async with self.db.transaction(readonly=readonly, isolation=isolation or "read_committed") as tx:
            await tx.execute("set local role postgres")
            self.tx = tx
            try:
                yield
            finally:
                self.tx = None

    async def _run(self, method: str, sql: str, args: tuple) -> Any:
        if self.tx is not None:
            return await getattr(self.tx, method)(sql, *args)
        async with self.transaction():
            assert self.tx is not None
            return await getattr(self.tx, method)(sql, *args)

    async def execute(self, sql: str, *args: Any) -> str:
        await self._run("execute", sql, args)
        return ""

    async def fetch(self, sql: str, *args: Any) -> list[Record]:
        return [Record(row) for row in await self._run("fetch", sql, args)]

    async def fetchrow(self, sql: str, *args: Any) -> Record | None:
        row = await self._run("fetchrow", sql, args)
        return None if row is None else Record(row)

    async def fetchval(self, sql: str, *args: Any) -> Any:
        return await self._run("fetchval", sql, args)

    async def cursor(self, sql: str, *args: Any, prefetch: int | None = None) -> AsyncIterator[Record]:
        """asyncpg's cursor, in the transaction open: here the rows come at once."""
        for row in await self.fetch(sql, *args):
            yield row

    async def copy_records_to_table(self, table: str, *, records: Iterable[tuple], columns: list[str]) -> str:
        sql = f"copy {table} ({', '.join(columns)}) from '/dev/blob' with (format csv, null '\\N')"
        rows = list(records)
        if self.tx is not None:
            await self.tx.copy(sql, _csv(rows))
        else:
            async with self.transaction():
                assert self.tx is not None
                await self.tx.copy(sql, _csv(rows))
        return f"COPY {len(rows)}"

    async def close(self) -> None:
        pass
