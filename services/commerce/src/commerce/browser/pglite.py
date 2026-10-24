"""The engine's Database on PGlite, PostgreSQL 18 compiled to WebAssembly,
in the browser's demo (stage 8).

PGlite is one session, in the page's worker. The bridge
(packages/sandbox/src/engine/database.ts) keeps one transaction open on it at
a time, and this adapter queues the engine's transactions in order, as a pool
of one connection would: a transaction asked for while another runs waits for
it. Statements and their results cross as JSON text: the parameters as the
text PostgreSQL parses, the results as the text PostgreSQL sent with each
column's type, turned here into what asyncpg gives the server's engine (an
int for the integers, a Decimal for numeric, a date, an aware datetime in UTC,
a str for JSON, bytes for bytea, a list for an array). A refused statement
keeps its SQLSTATE and its constraint, so that the engine tells a rule's no
from a fault exactly as on the server; a database that failed under the
engine is DatabaseUnavailable, a fault and never an answer.

What differs from the server's pool, written down:
  - one session, so two transactions never run at the same moment: the
    database's locks and serialization failures never come into play, and a
    transaction opened inside another would wait for ever, so it is refused
    at once;
  - no statement timeout: PGlite has no timer to cancel a statement with;
  - the session is the engine's role (commerce, a member of commerce_app,
    set by the bridge once the migrations ran), so the grants of the
    migrations hold; the bridge itself runs as the owner, and the page could
    too: the sandbox is the visitor's own, not a boundary between people.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, time
from decimal import Decimal
from typing import Any, Protocol

from commerce.engine.database import DatabaseError, DatabaseUnavailable, Row

ISOLATION = {"read_committed": "read committed", "repeatable_read": "repeatable read", "serializable": "serializable"}
# As the server's adapter: the connection exceptions (class 08), the server shutting down or not yet ready, no
# connection to spare, a statement cancelled. PGlite raises none of them today; a fault is a fault all the same.
_UNAVAILABLE_STATES = ("57P01", "57P02", "57P03", "53300", "57014")
_SAFE_INTEGER = 2**53 - 1


class Bridge(Protocol):
    """The page's side (database.ts): each call answers JSON text, or {"error": {...}}."""

    def begin(self, readonly: bool) -> Awaitable[str]: ...

    def query(self, tx: int, sql: str, params: str) -> Awaitable[str]: ...

    def copy(self, tx: int, sql: str, data: str) -> Awaitable[str]: ...

    def end(self, tx: int, commit: bool) -> Awaitable[str]: ...


def _reply(text: str) -> dict[str, Any]:
    reply = json.loads(text)
    error = reply.get("error")
    if error is None:
        return reply
    state, message = error.get("sqlstate"), str(error.get("message", ""))
    if not state:
        raise DatabaseUnavailable(f"the database in this browser failed: {message}")
    if state.startswith("08") or state in _UNAVAILABLE_STATES:
        raise DatabaseUnavailable(f"the database is not answering ({state}): {message}")
    raise DatabaseError(state, message, error.get("constraint"))


# -- parameters: the text PostgreSQL parses ----------------------------------------------

def _parameter(value: Any) -> Any:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value if -_SAFE_INTEGER <= value <= _SAFE_INTEGER else str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"bytea": bytes(value).hex()}  # the bridge hands PGlite bytes for a bytea parameter
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, (date, time, Decimal, uuid.UUID)):
        return str(value)
    raise TypeError(f"a parameter of type {type(value).__name__}: the engine's statements take plain values "
                    "(engine/database.py)")


def parameters(args: tuple) -> str:
    return json.dumps([_parameter(value) for value in args])


# -- results: from PostgreSQL's text to what asyncpg gives ---------------------------------

def _timestamp(text: str) -> datetime:
    if text in ("infinity", "-infinity"):
        return datetime.max if text == "infinity" else datetime.min
    return datetime.fromisoformat(text)


def _timestamptz(text: str) -> datetime:
    if text in ("infinity", "-infinity"):
        return (datetime.max if text == "infinity" else datetime.min).replace(tzinfo=UTC)
    return datetime.fromisoformat(text).astimezone(UTC)


def _date(text: str) -> date:
    if text in ("infinity", "-infinity"):
        return date.max if text == "infinity" else date.min
    return date.fromisoformat(text)


def _bytea(text: str) -> bytes:
    if not text.startswith("\\x"):
        raise ValueError("bytea comes in hex, as PostgreSQL sends it by default")
    return bytes.fromhex(text[2:])


def _float(text: str) -> float:
    return float(text)


SCALARS: dict[int, Callable[[str], Any]] = {
    16: lambda text: text == "t",  # bool
    17: _bytea,
    18: str, 19: str, 25: str, 1042: str, 1043: str,  # "char", name, text, bpchar (padded, as asyncpg), varchar
    20: int, 21: int, 23: int, 26: int,  # int8, int2, int4, oid
    114: str, 3802: str,  # json and jsonb: text, as asyncpg gives them
    700: _float, 701: _float,
    1082: _date, 1114: _timestamp, 1184: _timestamptz,
    1700: Decimal,
    2278: lambda text: None,  # void, what a function returning nothing gives
    2950: uuid.UUID,
}
ARRAYS: dict[int, int] = {  # array type -> element type
    1000: 16, 1001: 17, 1002: 18, 1003: 19, 1009: 25, 1014: 1042, 1015: 1043, 1016: 20, 1005: 21, 1007: 23,
    1028: 26, 199: 114, 3807: 3802, 1021: 700, 1022: 701, 1182: 1082, 1115: 1114, 1185: 1184, 1231: 1700, 2951: 2950,
}
# Types asyncpg turns into objects of its own, or that the engine never reads: refused, so that a test finds the
# statement to render them as text instead (an interval, a range, a time of day, money, a record).
REFUSED: dict[int, str] = {
    1083: "time", 1266: "timetz", 1186: "interval", 790: "money", 2249: "record",
    3904: "int4range", 3906: "numrange", 3908: "tsrange", 3910: "tstzrange", 3912: "daterange", 3926: "int8range",
}


def _array(text: str, element: Callable[[str], Any]) -> list:
    """PostgreSQL's array literal, {a,"b c",NULL,{1,2}}, with each element converted."""
    if text.startswith("["):  # bounds other than 1, [0:2]={...}: dropped, as asyncpg does for a list
        text = text[text.index("=") + 1:]
    position = 0

    def items() -> list:
        nonlocal position
        assert text[position] == "{"
        position += 1
        found: list = []
        while True:
            char = text[position]
            if char == "}":
                position += 1
                return found
            if char == ",":
                position += 1
                continue
            if char == "{":
                found.append(items())
            elif char == '"':
                position += 1
                piece: list[str] = []
                while text[position] != '"':
                    if text[position] == "\\":
                        position += 1
                    piece.append(text[position])
                    position += 1
                position += 1
                found.append(element("".join(piece)))
            else:
                end = position
                while text[end] not in ",}":
                    end += 1
                word = text[position:end]
                position = end
                found.append(None if word == "NULL" else element(word))

    return items()


def value(oid: int, text: str | None) -> Any:
    if text is None:
        return None
    convert = SCALARS.get(oid)
    if convert is not None:
        return convert(text)
    if oid in ARRAYS:
        return _array(text, SCALARS[ARRAYS[oid]])
    if oid in REFUSED:
        raise TypeError(f"a {REFUSED[oid]} reached the engine: render it as text in the statement")
    return text  # an enum, a domain, a type of the migrations' own: its text, as asyncpg gives it


def rows(reply: dict[str, Any]) -> list[Row]:
    fields = [(name, oid) for name, oid in reply["fields"]]
    return [{name: value(oid, text) for (name, oid), text in zip(fields, row, strict=True)} for row in reply["rows"]]


# -- the connection and the database --------------------------------------------------------

class _Connection:
    def __init__(self, bridge: Bridge, tx: int) -> None:
        self._bridge = bridge
        self._tx = tx
        self._savepoints = 0
        self.closed = False

    async def _run(self, sql: str, args: tuple) -> dict[str, Any]:
        if self.closed:
            raise RuntimeError("the transaction has ended")
        return _reply(await self._bridge.query(self._tx, sql, parameters(args)))

    async def fetch(self, sql: str, *args: Any) -> list[Row]:
        return rows(await self._run(sql, args))

    async def fetchrow(self, sql: str, *args: Any) -> Row | None:
        found = rows(await self._run(sql, args))
        return found[0] if found else None

    async def fetchval(self, sql: str, *args: Any) -> Any:
        """The first column of the first row, as asyncpg reads it, whatever the columns are called."""
        reply = await self._run(sql, args)
        if not reply["rows"] or not reply["fields"]:
            return None
        return value(reply["fields"][0][1], reply["rows"][0][0])

    async def execute(self, sql: str, *args: Any) -> None:
        await self._run(sql, args)

    async def copy(self, sql: str, data: str) -> int:
        """COPY ... FROM '/dev/blob' with these rows, for the build's data (snapshot.py): the rows copied."""
        if self.closed:
            raise RuntimeError("the transaction has ended")
        return int(_reply(await self._bridge.copy(self._tx, sql, data))["count"])

    @asynccontextmanager
    async def savepoint(self) -> AsyncIterator[None]:
        self._savepoints += 1
        name = f"engine_{self._savepoints}"
        await self.execute(f"savepoint {name}")
        try:
            yield
        except BaseException:
            await self.execute(f"rollback to savepoint {name}")
            await self.execute(f"release savepoint {name}")
            raise
        else:
            await self.execute(f"release savepoint {name}")


class PGliteDatabase:
    def __init__(self, bridge: Bridge) -> None:
        self._bridge = bridge
        self._turn = asyncio.Lock()
        self._holder: asyncio.Task | None = None

    @asynccontextmanager
    async def transaction(self, *, readonly: bool = False, isolation: str = "read_committed") -> AsyncIterator[_Connection]:
        level = ISOLATION[isolation]
        task = asyncio.current_task()
        if task is not None and task is self._holder:
            raise RuntimeError("a transaction inside a transaction: PGlite is one session, and the inner one would wait "
                               "for the outer one for ever")
        async with self._turn:
            self._holder = task
            try:
                connection = _Connection(self._bridge, int(_reply(await self._bridge.begin(readonly))["tx"]))
                try:
                    if readonly or isolation != "read_committed":
                        await connection.execute(f"set transaction isolation level {level}{' read only' if readonly else ''}")
                    yield connection
                except BaseException:
                    connection.closed = True
                    try:
                        _reply(await self._bridge.end(connection._tx, False))
                    except (DatabaseError, DatabaseUnavailable):
                        pass  # the error that brought us here is the one worth reporting
                    raise
                else:
                    connection.closed = True
                    _reply(await self._bridge.end(connection._tx, True))
            finally:
                self._holder = None

    async def ping(self) -> None:
        async with self.transaction(readonly=True) as tx:
            await tx.fetchval("select 1")
