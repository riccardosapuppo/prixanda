"""The engine's door to PostgreSQL.

A small interface, so that the same rules run on asyncpg in the server and,
from stage 8, on PGlite in the browser through a JSON bridge. Statements use
$1-style parameters, which both drivers accept. Parameters and results are
plain values only: str, int, bool and None. Instants travel as ISO text and
are cast in SQL ($1::text::timestamptz), bytes as hex text, JSON as text, so
no driver's own types reach the rules.

A refused statement raises DatabaseError with the SQLSTATE PostgreSQL gave;
a database that cannot be reached raises DatabaseUnavailable, which is a
fault and never an answer.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, Protocol

Row = Mapping[str, Any]

# What a statement's parameters may be: the plain values above, and the few both drivers turn into the same text
# (instants, dates, decimals, bytes, UUIDs). A list or a mapping is refused by the server's adapter as by the
# browser's, so that a statement the server's tests pass runs in the browser as well.
PARAMETER_TYPES = (str, int, float, bool, bytes, bytearray, memoryview, datetime, date, time, Decimal, uuid.UUID)


def check_parameters(args: tuple) -> None:
    for value in args:
        if value is not None and not isinstance(value, PARAMETER_TYPES):
            raise TypeError(f"a parameter of type {type(value).__name__}: the engine's statements take plain values "
                            "(engine/database.py)")

UNIQUE_VIOLATION = "23505"
FOREIGN_KEY_VIOLATION = "23503"
CHECK_VIOLATION = "23514"
EXCLUSION_VIOLATION = "23P01"
SERIALIZATION_FAILURE = "40001"
DEADLOCK_DETECTED = "40P01"
INSUFFICIENT_PRIVILEGE = "42501"
# Raised by the triggers of the migrations: RL001 a price in force is edited,
# RL002 a change moves outside the book's states, RL003 an approval breaks a
# rule, RL004 a version is edited, RL005 a row written once is changed,
# RL006 an idempotent call is completed twice, or pruned while it runs,
# RL007 a draft is published, RL008 a launch, a step or an incident moves in
# a way the job does not, RL009 an outbox message, a notice of the site, a
# payment or an event of the provider changes after the fact, RL010 a price of
# a subscription's history breaks a rule (V12).
RETRYABLE = (SERIALIZATION_FAILURE, DEADLOCK_DETECTED)


class DatabaseError(Exception):
    """PostgreSQL refused a statement."""

    def __init__(self, sqlstate: str, message: str, constraint: str | None = None) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate
        self.constraint = constraint


class DatabaseUnavailable(Exception):
    """The database cannot be reached, or the connection broke."""


class Connection(Protocol):
    async def fetch(self, sql: str, *args: Any) -> list[Row]: ...

    async def fetchrow(self, sql: str, *args: Any) -> Row | None: ...

    async def fetchval(self, sql: str, *args: Any) -> Any: ...

    async def execute(self, sql: str, *args: Any) -> None: ...

    def savepoint(self) -> AbstractAsyncContextManager[None]:
        """A nested transaction: an exception inside rolls back to it and propagates."""
        ...


class Database(Protocol):
    def transaction(self, *, readonly: bool = False, isolation: str = "read_committed") -> AbstractAsyncContextManager[Connection]:
        """One transaction on one connection: committed when the block ends, rolled back on an exception."""
        ...

    async def ping(self) -> None:
        """Raises DatabaseUnavailable when the database cannot answer."""
        ...


def utc_text(column: str) -> str:
    """SQL that renders a timestamptz as ISO 8601 in UTC with microseconds and Z."""
    return f"to_char({column} at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"


def local_text(column: str) -> str:
    """SQL that renders a timestamp without time zone as ISO 8601 with seconds."""
    return f"to_char({column}, 'YYYY-MM-DD\"T\"HH24:MI:SS')"
