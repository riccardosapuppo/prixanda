"""The engine's package for the browser (stage 8), in CPython: what it may
import, what the adapter makes of PostgreSQL's text, what the demo's fault
does, and what a pass of the jobs tells the tabs. The same package runs in
Pyodide on PGlite in packages/sandbox/test/engine."""

from __future__ import annotations

import ast
import asyncio
import json
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import grpc
import pytest

from commerce.browser import pglite, sandbox, snapshot
from commerce.engine.database import DatabaseError, DatabaseUnavailable
from commerce.engine.errors import CODES
from commerce.engine.jobs import Logged
from commerce.engine.launches import STEPS

SOURCE = Path(__file__).resolve().parents[2] / "src" / "commerce"
FORBIDDEN = ("grpc", "grpc_health", "asyncpg", "commerce.server", "commerce.adapters", "commerce.generate",
             "commerce.compat", "commerce.invariants", "commerce.measure")


BUILD_ONLY = ("generate.py", "browser/snapshot.py")


def browser_modules() -> list[Path]:
    """What packages/sandbox/src/engine/build/assets.ts puts in the zip: the same rule, written twice."""
    found = [SOURCE / "__init__.py"]
    for folder in ("domain", "engine", "browser"):
        found += sorted(p for p in (SOURCE / folder).glob("*.py") if p.relative_to(SOURCE).as_posix() not in BUILD_ONLY)
    found += sorted(p for p in (SOURCE / "v1").glob("*.py") if p.name == "__init__.py" or p.name.endswith("_pb2.py"))
    return found


def imports_of(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module)
    return names


def test_the_browser_package_imports_nothing_of_the_server_nor_of_grpc_or_asyncpg():
    modules = browser_modules()
    assert len(modules) >= 45
    offending = {path.relative_to(SOURCE).as_posix(): sorted(n for n in imports_of(path) if n.startswith(FORBIDDEN))
                 for path in modules}
    assert {path: names for path, names in offending.items() if names} == {}
    # What the build hands to Pyodide beside the package: the generator imports asyncpg only to connect.
    for path in BUILD_ONLY:
        tree = ast.parse((SOURCE / path).read_text(encoding="utf-8"))
        at_top = {alias.name for node in tree.body if isinstance(node, ast.Import) for alias in node.names}
        at_top |= {node.module for node in tree.body if isinstance(node, ast.ImportFrom) and node.module}
        assert not {name for name in at_top if name.startswith(FORBIDDEN)}, path


def test_the_status_codes_are_grpcs():
    for name, number in CODES.items():
        assert getattr(grpc.StatusCode, name).value[0] == number, name


# -- the adapter: PostgreSQL's text, as asyncpg gives it --------------------------------------

@pytest.mark.parametrize(("oid", "text", "expected"), [
    (16, "t", True), (16, "f", False),
    (20, "9007199254740993", 9007199254740993), (21, "-3", -3), (23, "42", 42), (26, "16384", 16384),
    (25, "text", "text"), (1043, "", ""), (1042, "IT ", "IT "),
    (114, '{"a": 1}', '{"a": 1}'), (3802, '{"a": 1}', '{"a": 1}'),
    (700, "0.5", 0.5), (701, "1e-07", 1e-07), (701, "NaN", "nan"),
    (1700, "12.3400", Decimal("12.3400")),
    (1082, "2026-10-25", date(2026, 10, 25)), (1082, "infinity", date.max),
    (1114, "2026-10-25 02:30:00", datetime(2026, 10, 25, 2, 30)),
    (1114, "2026-10-25 02:30:00.000123", datetime(2026, 10, 25, 2, 30, 0, 123)),
    (1184, "2026-10-25 00:30:00+00", datetime(2026, 10, 25, 0, 30, tzinfo=UTC)),
    (1184, "2026-10-25 02:30:00.5+02", datetime(2026, 10, 25, 0, 30, 0, 500000, tzinfo=UTC)),
    (17, "\\x00ff10", b"\x00\xff\x10"),
    (2950, "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", uuid.UUID("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")),
    (2278, "", None),
    (1007, "{1,2,NULL}", [1, 2, None]),
    (1009, '{plain,"with space","quote \\" inside",NULL,"NULL"}', ["plain", "with space", 'quote " inside', None, "NULL"]),
    (1007, "{{1,2},{3,4}}", [[1, 2], [3, 4]]),
    (1182, "[0:1]={2026-10-25,2026-10-26}", [date(2026, 10, 25), date(2026, 10, 26)]),
    (1009, "{}", []),
    (999_999, "an enum's label", "an enum's label"),
    (16, None, None),
])
def test_values_come_back_as_asyncpg_gives_them(oid, text, expected):
    got = pglite.value(oid, text)
    if expected == "nan":
        assert got != got
    else:
        assert got == expected and type(got) is type(expected)


@pytest.mark.parametrize(("oid", "name"), [(1186, "interval"), (3908, "tsrange"), (1083, "time"), (790, "money")])
def test_the_types_asyncpg_makes_objects_of_are_refused(oid, name):
    with pytest.raises(TypeError, match=name):
        pglite.value(oid, "anything")


def test_parameters_travel_as_text_postgresql_parses():
    sent = json.loads(pglite.parameters((None, True, "x", 7, 2**60, 0.25, b"\x01\x02", datetime(2026, 10, 25, 1, 0, tzinfo=UTC),
                                         date(2026, 10, 25), Decimal("1.50"))))
    assert sent == [None, True, "x", 7, str(2**60), "0.25", {"bytea": "0102"}, "2026-10-25 01:00:00+00:00", "2026-10-25", "1.50"]
    with pytest.raises(TypeError, match="plain values"):
        pglite.parameters(([1, 2],))


def test_a_refusal_keeps_its_sqlstate_and_a_failure_is_a_fault():
    with pytest.raises(DatabaseError) as refused:
        pglite._reply(json.dumps({"error": {"sqlstate": "23P01", "message": "conflicting key value", "constraint": "no_overlap"}}))
    assert (refused.value.sqlstate, refused.value.constraint, str(refused.value)) == ("23P01", "no_overlap", "conflicting key value")
    with pytest.raises(DatabaseUnavailable, match="failed: RuntimeError: unreachable"):
        pglite._reply(json.dumps({"error": {"sqlstate": None, "message": "RuntimeError: unreachable"}}))
    with pytest.raises(DatabaseUnavailable, match="57P01"):
        pglite._reply(json.dumps({"error": {"sqlstate": "57P01", "message": "terminating"}}))


class FakeBridge:
    """The page's side, for the adapter's own rules: it records what it was asked."""

    def __init__(self, fail_on: str | None = None) -> None:
        self.asked: list[tuple] = []
        self.next = 0
        self.fail_on = fail_on

    async def begin(self, readonly):
        self.next += 1
        self.asked.append(("begin", readonly))
        await asyncio.sleep(0)
        return json.dumps({"tx": self.next})

    async def query(self, tx, sql, params):
        self.asked.append(("query", tx, sql))
        await asyncio.sleep(0)
        if self.fail_on and self.fail_on in sql:
            return json.dumps({"error": {"sqlstate": "23514", "message": "check", "constraint": None}})
        return json.dumps({"fields": [["n", 23], ["n", 25]], "rows": [["1", "two"]], "count": 1})

    async def copy(self, tx, sql, data):
        return json.dumps({"count": data.count("\n")})

    async def end(self, tx, commit):
        self.asked.append(("end", tx, commit))
        return "{}"


async def test_transactions_wait_their_turn_and_one_inside_another_is_refused():
    bridge = FakeBridge()
    db = pglite.PGliteDatabase(bridge)

    async def write(name):
        async with db.transaction() as tx:
            await tx.execute(f"select '{name}'")
            await asyncio.sleep(0)
            await tx.execute(f"select '{name}' again")

    await asyncio.gather(write("a"), write("b"))
    order = [step for step in bridge.asked if step[0] != "begin"]
    assert [(s[0], s[1]) for s in order] == [("query", 1), ("query", 1), ("end", 1), ("query", 2), ("query", 2), ("end", 2)]
    async with db.transaction(readonly=True, isolation="repeatable_read") as tx:
        assert bridge.asked[-1] == ("query", 3, "set transaction isolation level repeatable read read only")
        assert await tx.fetchval("select 1") == 1  # the first column, though another is called the same
        assert await tx.fetchrow("select 1") == {"n": "two"}
        with pytest.raises(RuntimeError, match="inside a transaction"):
            async with db.transaction():
                pass


async def test_a_refusal_inside_a_savepoint_rolls_back_to_it_and_the_transaction_goes_on():
    bridge = FakeBridge(fail_on="insert")
    db = pglite.PGliteDatabase(bridge)
    async with db.transaction() as tx:
        with pytest.raises(DatabaseError):
            async with tx.savepoint():
                await tx.execute("insert into somewhere")
        await tx.execute("select after")
    sql = [step[2] for step in bridge.asked if step[0] == "query"]
    assert sql == ["savepoint engine_1", "insert into somewhere", "rollback to savepoint engine_1", "release savepoint engine_1",
                   "select after"]
    assert bridge.asked[-1] == ("end", 1, True)
    with pytest.raises(DatabaseError):
        async with db.transaction() as tx:
            await tx.execute("insert once more")
    assert bridge.asked[-1] == ("end", 2, False)


# -- the demo's fault and what the jobs changed ----------------------------------------------

async def test_the_simulated_fault_fails_one_step_once_before_it_commits_and_says_it_is_simulated():
    faults = sandbox.DemoFaults()
    with pytest.raises(ValueError):
        faults.arm("deploy")
    faults.arm("publish")
    await faults.probe("publish", "start", None)
    await faults.probe("check", "end", None)
    with pytest.raises(sandbox.SimulatedFault, match="^simulated by the demo: the publish step was cut just before it committed"):
        await faults.probe("publish", "end", None)
    assert faults.armed is None
    await faults.probe("publish", "end", None)
    assert set(STEPS) == {"check", "prepare", "publish", "notify", "verify"}


@pytest.mark.parametrize(("events", "words"), [
    ([], []),
    ([("launch_started", {}), ("launch_step_done", {})], ["launches"]),
    ([("launch_step_failed", {})], ["launches"]),
    ([("launch_done", {})], ["catalog", "changes", "launches", "audit"]),
    ([("launch_refused", {}), ("incident_opened", {})], ["changes", "launches", "audit"]),
    ([("offer_ended", {})], ["catalog", "changes", "audit"]),
    ([("prepaid_code_expired", {})], ["accounts", "audit"]),
    ([("outbox_delivered", {"topic": "catalog.published"})], ["catalog"]),
    ([("outbox_delivered", {"topic": "payment.charge"})], ["accounts", "audit"]),
    ([("jobs_pass_failed", {}), ("idempotency_keys_pruned", {})], []),
])
def test_a_pass_says_what_the_tabs_read_again_in_the_five_words(events, words):
    assert sandbox.changed([Logged("info", event, fields) for event, fields in events]) == words
    assert set(words) <= set(sandbox.CHANGES)


def test_the_build_writes_csv_postgresql_reads_back():
    rows = snapshot.csv_rows([(1, None, "", 'say "hi"', True, date(2026, 10, 25), b"\x00\x01", Decimal("2.50"))])
    assert rows == '1,,"","say ""hi""",t,2026-10-25,\\x0001,2.50\n'
