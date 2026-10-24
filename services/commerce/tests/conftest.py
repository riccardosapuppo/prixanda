"""Each test gets a database of its own, cloned from a template that Flyway
has already migrated, and dropped afterwards: nothing a test writes reaches
another test.

The databases live in the throwaway cluster that `npm run check` starts, and
three variables say where it is:

  COMMERCE_TEST_ADMIN_URL  the owner (the role the migrations run as), on the
                           cluster's "postgres" database
  COMMERCE_TEST_TEMPLATE   the migrated template
  COMMERCE_TEST_APP_URL    the engine's role, with {database} for the name
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import pytest
import pytest_asyncio

ADMIN_URL = os.environ.get("COMMERCE_TEST_ADMIN_URL", "")
TEMPLATE = os.environ.get("COMMERCE_TEST_TEMPLATE", "")
APP_URL = os.environ.get("COMMERCE_TEST_APP_URL", "")


def pytest_configure(config):
    if not (ADMIN_URL and TEMPLATE and APP_URL):
        pytest.exit("these tests run through `npm run check`, which starts PostgreSQL and migrates their template",
                    returncode=4)


def on_database(url: str, database: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=f"/{database}"))


@dataclass
class Database:
    name: str
    owner: asyncpg.Connection
    app: asyncpg.Connection

    def url(self, who: str = "owner") -> str:
        return on_database(ADMIN_URL, self.name) if who == "owner" else APP_URL.format(database=self.name)


async def _admin(statement: str) -> None:
    admin = await asyncpg.connect(ADMIN_URL)
    try:
        await admin.execute(statement)
    finally:
        await admin.close()


@pytest_asyncio.fixture
async def db():
    name = f"test_{uuid.uuid4().hex[:16]}"
    await _admin(f"create database {name} template {TEMPLATE}")
    owner = await asyncpg.connect(on_database(ADMIN_URL, name))
    app = await asyncpg.connect(APP_URL.format(database=name))
    try:
        yield Database(name, owner, app)
    finally:
        await owner.close()
        await app.close()
        await _admin(f"drop database {name} with (force)")


@pytest_asyncio.fixture(scope="session")
async def seeded_template():
    """The migrated template with the tests' hand-written world (tests/seed.py), made once."""
    from seed import seed

    name = f"seeded_{uuid.uuid4().hex[:12]}"
    await _admin(f"create database {name} template {TEMPLATE}")
    owner = await asyncpg.connect(on_database(ADMIN_URL, name))
    try:
        await seed(owner)
    finally:
        await owner.close()
    yield name
    await _admin(f"drop database {name} with (force)")


@pytest_asyncio.fixture
async def world(seeded_template):
    """A database of its own with the seeded world, and the engine on it as the engine's role."""
    from commerce.adapters.asyncpg_database import AsyncpgDatabase
    from commerce.engine.call import FixedClock
    from commerce.engine.engine import Engine
    from engine_support import World
    from helpers import T0

    name = f"test_{uuid.uuid4().hex[:16]}"
    await _admin(f"create database {name} template {seeded_template}")
    owner = await asyncpg.connect(on_database(ADMIN_URL, name))
    database = await AsyncpgDatabase.connect(APP_URL.format(database=name), max_size=8)
    clock = FixedClock(T0)
    try:
        yield World(name, owner, Engine(database, clock), clock)
    finally:
        await database.close()
        await owner.close()
        await _admin(f"drop database {name} with (force)")
