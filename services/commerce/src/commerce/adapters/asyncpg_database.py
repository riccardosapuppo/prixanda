"""The engine's database interface on an asyncpg pool.

A transaction holds one connection of the pool until it ends. A statement
PostgreSQL refuses becomes DatabaseError with its SQLSTATE and constraint; a
database that cannot be reached, or that stops answering, becomes
DatabaseUnavailable, and so does a connection closed under the engine (a
server that restarted, a connection cut). The pool sets a statement timeout
and an idle-in-transaction timeout on every connection, so that no call can
hold the database for ever.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import asyncpg

from commerce.engine.database import DatabaseError, DatabaseUnavailable, Row

# Connection exceptions (class 08), the server shutting down or not yet ready
# (57P01 to 57P03), too many connections (53300) and a statement cancelled by
# the timeout (57014): the database is not there to answer.
_UNAVAILABLE_STATES = ("57P01", "57P02", "57P03", "53300", "57014")
ISOLATION = {"read_committed": "read_committed", "repeatable_read": "repeatable_read", "serializable": "serializable"}


def translate(error: BaseException) -> Exception:
    if isinstance(error, asyncpg.PostgresError):
        state = error.sqlstate or ""
        if state.startswith("08") or state in _UNAVAILABLE_STATES:
            return DatabaseUnavailable(f"the database is not answering ({state})")
        return DatabaseError(state, str(error), getattr(error, "constraint_name", None))
    if isinstance(error, (OSError, asyncio.TimeoutError)):
        return DatabaseUnavailable(f"the database cannot be reached ({type(error).__name__})")
    if isinstance(error, asyncpg.InterfaceError) and "closed" in str(error):
        return DatabaseUnavailable("the connection to the database was closed")
    return error  # anything else is a bug, and stays what it is


_FAULTS = (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, asyncio.TimeoutError)


def _raise(error: BaseException) -> None:
    translated = translate(error)
    if translated is error:
        raise error
    raise translated from error


class _Connection:
    def __init__(self, connection: asyncpg.Connection) -> None:
        self._connection = connection

    async def _run(self, method: str, sql: str, args: tuple) -> Any:
        try:
            return await getattr(self._connection, method)(sql, *args)
        except _FAULTS as error:
            _raise(error)

    async def fetch(self, sql: str, *args: Any) -> list[Row]:
        return [dict(row) for row in await self._run("fetch", sql, args)]

    async def fetchrow(self, sql: str, *args: Any) -> Row | None:
        row = await self._run("fetchrow", sql, args)
        return None if row is None else dict(row)

    async def fetchval(self, sql: str, *args: Any) -> Any:
        return await self._run("fetchval", sql, args)

    async def execute(self, sql: str, *args: Any) -> None:
        await self._run("execute", sql, args)

    @asynccontextmanager
    async def savepoint(self) -> AsyncIterator[None]:
        nested = self._connection.transaction()
        try:
            await nested.start()
        except _FAULTS as error:
            _raise(error)
        try:
            yield
        except BaseException:
            try:
                await nested.rollback()
            except _FAULTS as error:
                _raise(error)
            raise
        else:
            try:
                await nested.commit()
            except _FAULTS as error:
                _raise(error)


class AsyncpgDatabase:
    def __init__(self, pool: asyncpg.Pool, *, acquire_timeout: float = 10.0) -> None:
        self._pool = pool
        self._acquire_timeout = acquire_timeout

    @classmethod
    async def connect(cls, url: str, *, min_size: int = 0, max_size: int = 10, statement_timeout_ms: int = 15_000,
                      application_name: str = "commerce-engine") -> AsyncpgDatabase:
        """A pool that opens connections only when they are needed, so that the
        engine starts, and says it is not serving, while the database is down."""
        pool = await asyncpg.create_pool(
            url, min_size=min_size, max_size=max_size, command_timeout=statement_timeout_ms / 1000 + 5,
            server_settings={
                "application_name": application_name,
                "statement_timeout": str(statement_timeout_ms),
                "idle_in_transaction_session_timeout": str(statement_timeout_ms * 4),
                "timezone": "UTC",
            })
        return cls(pool)

    async def close(self) -> None:
        await self._pool.close()

    @asynccontextmanager
    async def transaction(self, *, readonly: bool = False, isolation: str = "read_committed") -> AsyncIterator[_Connection]:
        try:
            connection = await self._pool.acquire(timeout=self._acquire_timeout)
        except _FAULTS as error:
            _raise(error)
        try:
            transaction = connection.transaction(isolation=ISOLATION[isolation], readonly=readonly)
            try:
                await transaction.start()
            except _FAULTS as error:
                _raise(error)
            try:
                yield _Connection(connection)
            except BaseException:
                try:
                    await transaction.rollback()
                except _FAULTS:
                    pass  # the error that brought us here is the one worth reporting
                raise
            else:
                try:
                    await transaction.commit()
                except _FAULTS as error:
                    _raise(error)
        finally:
            await self._pool.release(connection)

    async def ping(self) -> None:
        async with self.transaction(readonly=True) as tx:
            await tx.fetchval("select 1")
