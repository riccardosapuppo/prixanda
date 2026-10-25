"""Each test gets a database of its own, cloned from a template that Flyway
has already migrated, and dropped afterwards: nothing a test writes reaches
another test.

The databases live in the throwaway cluster that `npm run check` starts, and
three variables say where it is:

  COMMERCE_TEST_ADMIN_URL  the owner (the role the migrations run as), on the
                           cluster's "postgres" database
  COMMERCE_TEST_TEMPLATE   the migrated template
  COMMERCE_TEST_APP_URL    the engine's role, with {database} for the name

With COMMERCE_TEST_DATABASE=pglite, the service tests' world is built on the
browser's database instead (tests/pglite_world.py), and the fixtures of
PostgreSQL alone are not there: the check's sandbox-services runs them so.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from datetime import date
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import pytest
import pytest_asyncio
from hypothesis import settings
from hypothesis.configuration import set_hypothesis_home_dir

PGLITE = os.environ.get("COMMERCE_TEST_DATABASE") == "pglite"
ADMIN_URL = os.environ.get("COMMERCE_TEST_ADMIN_URL", "")
TEMPLATE = os.environ.get("COMMERCE_TEST_TEMPLATE", "")
APP_URL = os.environ.get("COMMERCE_TEST_APP_URL", "")

# Property tests: the same examples on every run (a check that passes once and
# fails the next is no check), no example database, and no deadline, because a
# loaded machine is slow. Hypothesis still caches what it reads from the source
# files: that goes to a folder of this session, removed when it ends, so that
# nothing is left in the repository (rule 26).
settings.register_profile("engine", database=None, derandomize=True, deadline=None, print_blob=False)
settings.load_profile("engine")
HYPOTHESIS_HOME = tempfile.mkdtemp(prefix="commerce-tests-hypothesis-")
set_hypothesis_home_dir(HYPOTHESIS_HOME)


def pytest_unconfigure(config):
    shutil.rmtree(HYPOTHESIS_HOME, ignore_errors=True)


def pytest_configure(config):
    if not PGLITE and not (ADMIN_URL and TEMPLATE and APP_URL):
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


def pytest_collection_modifyitems(config, items):
    """On PGlite, the tests that need PostgreSQL's many sessions are skipped, with their reason."""
    if not PGLITE:
        return
    for item in items:
        marker = item.get_closest_marker("postgresql_only")
        if marker is not None:
            item.add_marker(pytest.mark.skip(reason=f"PostgreSQL only: {marker.args[0]}"))


def postgresql_only() -> None:
    if PGLITE:
        pytest.skip("PostgreSQL only: a database of its own, or a second connection, which PGlite's one session has not")


async def _admin(statement: str) -> None:
    postgresql_only()
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


async def fresh_database() -> str:
    """A database of its own, freshly migrated: a clone of the template."""
    name = f"gen_{uuid.uuid4().hex[:16]}"
    await _admin(f"create database {name} template {TEMPLATE}")
    return name


@pytest_asyncio.fixture(scope="session")
async def generated():
    """The small size, seed 7, generated once; tests clone it (copy)."""
    from commerce.generate import generate

    name = await fresh_database()
    summary = await generate(on_database(ADMIN_URL, name), "small", 7, date(2025, 1, 1), date(2026, 10, 24))
    yield name, summary
    await _admin(f"drop database {name} with (force)")


@pytest_asyncio.fixture
async def copy(generated):
    """A clone of the generated data, as its owner."""
    source, _ = generated
    name = f"copy_{uuid.uuid4().hex[:16]}"
    await _admin(f"create database {name} template {source}")
    conn = await asyncpg.connect(on_database(ADMIN_URL, name))
    try:
        yield conn
    finally:
        await conn.close()
        await _admin(f"drop database {name} with (force)")


@pytest_asyncio.fixture(scope="session")
async def pglite_node():
    """The Node process holding PGlite's instances, in PGlite's runs (tests/pglite_world.py); none otherwise."""
    if not PGLITE:
        yield None
        return
    from pglite_world import Node

    node = Node()
    await node.start()
    yield node
    await node.stop()


@pytest_asyncio.fixture(scope="session")
async def seeded_template(pglite_node):
    """The migrated template with the tests' hand-written world (tests/seed.py), made once."""
    from seed import seed

    if PGLITE:
        from commerce.browser.pglite import PGliteDatabase
        from pglite_world import InstanceBridge, Owner

        node = pglite_node
        instance = (await node.ask("cluster"))["instance"]
        await seed(Owner(PGliteDatabase(InstanceBridge(node, instance))))
        await node.ask("template", instance=instance)
        yield "pglite-template"
        return
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
async def world(seeded_template, pglite_node):
    """A database of its own with the seeded world, and the engine on it as the engine's role."""
    from commerce.adapters.asyncpg_database import AsyncpgDatabase
    from commerce.engine.call import FixedClock
    from commerce.engine.engine import Engine
    from engine_support import World
    from helpers import T0

    if PGLITE:
        from commerce.browser.pglite import PGliteDatabase
        from pglite_world import InstanceBridge, Owner

        node = pglite_node
        instance = (await node.ask("open"))["instance"]
        # One database for the owner and the engine, as PGlite is one session: a transaction of the owner left open
        # while the engine works is refused at once, instead of waiting for ever.
        database = PGliteDatabase(InstanceBridge(node, instance))
        clock = FixedClock(T0)
        try:
            yield World(f"pglite-{instance}", Owner(database), Engine(database, clock), clock)
        finally:
            await node.ask("close", instance=instance)
        return
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
