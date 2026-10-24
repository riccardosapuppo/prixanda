"""Faults injected in a launch, in the full stack (business book §7.5, §14.6):
the engine's real process on the real PostgreSQL, stopped dead inside each
step of the launch, or with its database connection cut inside each step,
before the step's transaction commits.

Each test launches an offer sold in two markets while another offer is
already live. After the fault, and again after the engine came back and the
launch went through, it checks that the platform never showed part of the
launch: the change is scheduled and the live catalog is the one before, with
the other offer, or the change is active and the live catalog shows it in
both markets, activated once and published once. A list price's launch goes
through the same faults at its publish step, where the price list changes.

The tests write what they saw to fault-injection.json in the reports folder
of `npm run check` (COMMERCE_TEST_REPORTS): the faults injected, the partial
activations found (there must be none) and the launches recovered. The check
reads it, and fails below its floor.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import pytest

from commerce.domain.localtime import format_instant
from commerce.v1 import changes_pb2, common_pb2
from conftest import APP_URL
from engine_support import FINANCE, LEAD, MARKETING, family_rise, scheduled, student_autumn
from wire_support import PORT

ENGINE = Path(__file__).with_name("engine_with_faults.py")
SOURCE = str(Path(__file__).resolve().parents[2] / "src")
STOPPED = 75
STEPS = ("check", "prepare", "publish", "notify", "verify")
OFFER_DUE = datetime(2026, 10, 26, 7, 59, 30, tzinfo=UTC)  # half a minute after it is due: 09:00 in Rome and Paris
PRICE_DUE = datetime(2026, 11, 30, 22, 59, 30, tzinfo=UTC)  # a minute before midnight in Berlin
REPORT: list[dict] = []


@pytest.fixture(scope="module")
def fault_report():
    """What the faults showed, written for the check when the module's tests are over."""
    yield REPORT
    folder = os.environ.get("COMMERCE_TEST_REPORTS")
    if folder and REPORT:
        partial = [entry for entry in REPORT if entry["partial"]]
        Path(folder, "fault-injection.json").write_text(json.dumps({
            "faults_injected": len(REPORT), "partial_activations": len(partial),
            "recovered": sum(1 for entry in REPORT if entry["recovered"]), "faults": REPORT}, indent=2), encoding="utf-8")


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@dataclass
class Engine:
    process: asyncio.subprocess.Process
    lines: list[dict] = field(default_factory=list)
    reader: asyncio.Task | None = None


async def start_engine(world, *, base: datetime, wall: float, port: int, step: str | None = None,
                       kind: str | None = None) -> Engine:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMMERCE_", "FAULT_"))}
    env.update({"PYTHONPATH": SOURCE, "PYTHONIOENCODING": "utf-8", "COMMERCE_DATABASE_URL": APP_URL.format(database=world.name),
                "COMMERCE_INTERNAL_TOKEN": secrets.token_hex(32), "COMMERCE_ENGINE_PORT": str(port),
                "COMMERCE_STOP_ON_STDIN_CLOSE": "1", "COMMERCE_ACTIVATION_INTERVAL_SECONDS": "0.2",
                "FAULT_CLOCK_BASE": format_instant(base), "FAULT_CLOCK_WALL": repr(wall)})
    if step is not None:
        env.update({"FAULT_STEP": step, "FAULT_KIND": kind})
    process = await asyncio.create_subprocess_exec(sys.executable, str(ENGINE), stdin=asyncio.subprocess.PIPE,
                                                   stderr=asyncio.subprocess.PIPE, env=env)
    engine = Engine(process)

    async def read() -> None:
        while raw := await process.stderr.readline():
            try:
                engine.lines.append(json.loads(raw))
            except ValueError:
                engine.lines.append({"text": raw.decode("utf-8", "replace").rstrip()})

    engine.reader = asyncio.create_task(read())
    return engine


async def ended(engine: Engine, timeout: float) -> int:
    await asyncio.wait_for(engine.process.wait(), timeout)
    await engine.reader
    return engine.process.returncode


async def stop(engine: Engine) -> int:
    if engine.process.returncode is None:
        engine.process.stdin.close()
    return await ended(engine, 30)


async def until(check, timeout: float, what: str, engine: Engine):
    """Polls the database until check() gives something true; fails with the engine's last lines."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = await check()
        if found:
            return found
        await asyncio.sleep(0.05)
    raise AssertionError(f"{what} did not happen in {timeout} s; the engine said: {engine.lines[-12:]}")


def two_markets(**changes) -> changes_pb2.OfferContent:
    """The Student Autumn Pass, sold in Italy and in France from 09:00 on 26 October."""
    euros = common_pb2.Money(amount_minor=299, currency="EUR")
    return student_autumn(
        prices=[changes_pb2.OfferPrice(market="IT", fixed=euros), changes_pb2.OfferPrice(market="FR", fixed=euros)],
        periods=[changes_pb2.OfferPeriod(market="IT", starts_local="2026-10-26T09:00", ends_local="2026-11-30T00:00"),
                 changes_pb2.OfferPeriod(market="FR", starts_local="2026-10-26T09:00", ends_local="2026-11-30T00:00")],
        pages=[changes_pb2.OfferPage(market=m, title="Student Autumn Pass", text="Three months of Student for 2,99 €.",
                                     terms="New subscribers only.", treatment="autumn") for m in ("IT", "FR")],
        **changes)


async def already_live(world) -> int:
    """A gift offer live since 25 October: the catalog before the launch is not empty."""
    gift = student_autumn(title="Autumn gift", plan="individual", non_combinability_group="gift-offers",
                          audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_NEVER_PAID),
                          prices=[changes_pb2.OfferPrice(market="IT", fixed=common_pb2.Money(amount_minor=899, currency="EUR"))],
                          periods=[changes_pb2.OfferPeriod(market="IT", starts_local="2026-10-25T09:00")])
    change = await scheduled(world, gift, MARKETING, FINANCE)
    world.clock.at = datetime(2026, 10, 25, 7, 59, 30, tzinfo=UTC)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated"
    return change.id


async def partial_activation(owner, change_id: int, kind: str, other: int | None) -> list[str]:
    """What would make this launch half done right now; nothing, when the platform is whole."""
    problems = []
    state = await owner.fetchval("select state from change where id = $1", change_id)
    latest = await owner.fetchrow("select seq, snapshot_id from catalog_publication order by seq desc limit 1")
    live = set() if latest is None else {r["change_id"] for r in await owner.fetch(
        "select distinct change_id from catalog_offer where snapshot_id = $1", latest["snapshot_id"])}
    markets = [] if latest is None else sorted(r["market"].strip() for r in await owner.fetch(
        "select market from catalog_offer where snapshot_id = $1 and change_id = $2", latest["snapshot_id"], change_id))
    activated = await owner.fetchval("select count(*) from audit_event where action = 'change.activated' and subject = $1",
                                     f"change:{change_id}")
    published = await owner.fetchval("select count(*) from audit_event where action = 'catalog.published' "
                                     "and (body->'cause'->>'activated')::bigint = $1", change_id)
    publish_done = await owner.fetchval("select s.state = 'done' from launch_step s join launch l on l.id = s.launch_id "
                                        "where l.change_id = $1 and s.name = 'publish'", change_id)
    prices = await owner.fetchval("select count(*) from list_price where change_id = $1", change_id)
    if other is not None and other not in live:
        problems.append(f"the offer live before the launch (#{other}) is missing from the live catalog")
    if state == "scheduled":
        for found, what in ((markets, "the live catalog shows it"), (activated, "a change.activated event exists"),
                            (published, "a publication names it"), (publish_done, "its publish step is done"),
                            (prices, "the price list holds its price")):
            if found:
                problems.append(f"the change is still scheduled, and {what}")
    elif state == "active":
        expected = ["FR", "IT"] if kind == "offer" else []
        if markets != expected:
            problems.append(f"the change is active, and the live catalog shows it in {markets or 'no market'}, not {expected}")
        if (activated, published) != (1, 1):
            problems.append(f"the change is active, activated {activated} times and published {published} times")
        if not publish_done:
            problems.append("the change is active, and its publish step is not done")
        if kind == "list_price" and prices != 1:
            problems.append(f"the change is active, and the price list holds {prices} of its prices")
    else:
        problems.append(f"the change is {state}")
    return problems


CASES = [("offer", step, fault) for step in STEPS for fault in ("stop", "cut")] + [
    ("list_price", "publish", fault) for fault in ("stop", "cut")]


@pytest.mark.parametrize(("kind", "step", "fault"), CASES)
async def test_a_fault_inside_a_launch_step_leaves_nothing_half_live_and_the_launch_recovers(world, fault_report, kind,
                                                                                            step, fault):
    if kind == "offer":
        other = await already_live(world)
        change = await scheduled(world, two_markets(), MARKETING, FINANCE)
        base = OFFER_DUE
    else:
        other = None
        change = await scheduled(world, family_rise(), LEAD, FINANCE)
        base = PRICE_DUE
    owner, port, wall = world.owner, PORT or free_port(), time.time()
    entry: dict = {"launch": kind, "step": step, "fault": fault}
    engine = await start_engine(world, base=base, wall=wall, port=port, step=step, kind=fault)
    try:
        if fault == "stop":
            code = await ended(engine, 60)
            assert code == STOPPED, f"the engine ended with {code}, not at the fault: {engine.lines[-12:]}"
            entry["what"] = f"the engine's process stopped dead inside the {step} step (exit {code})"
        else:
            await until(lambda: owner.fetchval(
                "select s.state = 'failed' from launch_step s join launch l on l.id = s.launch_id "
                "where l.change_id = $1 and s.name = $2", change.id, step), 60, f"the {step} step's failure", engine)
            entry["what"] = f"the {step} step's database connection was cut inside its transaction"
        entry["during_fault"] = await partial_activation(owner, change.id, kind, other)
        if fault == "stop":
            engine = await start_engine(world, base=base, wall=wall, port=port)
        started = time.monotonic()
        await until(lambda: owner.fetchval("select state = 'done' from launch where change_id = $1", change.id), 60,
                    "the launch's recovery", engine)
        entry["recovery_seconds"] = round(time.monotonic() - started, 1)
    finally:
        entry["engine_exit"] = await stop(engine)
    entry["after_recovery"] = await partial_activation(owner, change.id, kind, other)
    steps = {r["name"]: r for r in await owner.fetch(
        "select s.name, s.state, s.attempts, s.facts::text as facts from launch_step s join launch l on l.id = s.launch_id "
        "where l.change_id = $1", change.id)}
    entry["attempts"] = {name: steps[name]["attempts"] for name in STEPS}
    entry["last_failure"] = json.loads(steps[step]["facts"]).get("last failure", "")
    notice = int(json.loads(steps["publish"]["facts"])["notice"])
    entry["site_notices"] = await owner.fetchval("select count(*) from site_notice where message_id = $1", notice)
    entry["notice_arrivals"] = await owner.fetchval("select arrivals from site_notice where message_id = $1", notice)
    entry["recovered"] = all(row["state"] == "done" for row in steps.values()) and steps[step]["attempts"] >= 2
    entry["partial"] = bool(entry["during_fault"] or entry["after_recovery"])
    fault_report.append(entry)
    assert entry["during_fault"] == [] and entry["after_recovery"] == []
    assert entry["recovered"], entry
    assert entry["site_notices"] == 1 and entry["engine_exit"] == 0


async def test_the_check_for_a_partial_activation_sees_one(world):
    other = await already_live(world)
    change = await scheduled(world, two_markets(), MARKETING, FINANCE)
    assert await partial_activation(world.owner, change.id, "offer", other) == []
    # Half a launch, made by hand: the change active, and nothing published for it.
    await world.owner.execute("update change set state = 'active' where id = $1", change.id)
    problems = await partial_activation(world.owner, change.id, "offer", other)
    assert any("shows it in no market" in p for p in problems) and any("activated 0 times" in p for p in problems)
    # Then a catalog that shows it in one of its two markets, and has lost the offer live before.
    snapshot = await world.owner.fetchval("insert into catalog_snapshot (created_at, created_by, request_id, cause) "
                                          "values ($1, 'activation', 'by-hand', '{}'::jsonb) returning id", OFFER_DUE)
    await world.owner.execute(
        "insert into catalog_offer (snapshot_id, change_id, version, market, currency, plan_id, fixed_minor, percent_off_bp, "
        "months, starts_local, ends_local, starts_at, ends_at, title, body, terms, treatment, audience, audience_words, "
        "needs_student_check, group_name, redemption_cap) select $1, $2, 1, market, currency, plan_id, fixed_minor, "
        "percent_off_bp, months, starts_local, ends_local, starts_at, ends_at, title, body, terms, treatment, audience, "
        "audience_words, needs_student_check, group_name, redemption_cap from catalog_offer where change_id = $3 limit 1",
        snapshot, change.id, other)
    await world.owner.execute("insert into catalog_publication (snapshot_id, published_at, published_by, request_id) "
                              "values ($1, $2, 'activation', 'by-hand')", snapshot, OFFER_DUE)
    problems = await partial_activation(world.owner, change.id, "offer", other)
    assert any(f"(#{other}) is missing" in p for p in problems)
    assert any("shows it in ['IT'], not ['FR', 'IT']" in p for p in problems)


async def test_the_server_s_own_entry_point_arms_no_fault(world):
    """python -m commerce.server, the production entry point, with the fault settings of this folder in its
    environment: it reads none of them, and the launch goes through untouched."""
    # It runs on the machine's clock: an offer from 11:00 in Rome on 24 October, with no end, is due on any day the
    # tests run (the tests' own clock, at 10:42 that day, could still validate it).
    soon = student_autumn(periods=[changes_pb2.OfferPeriod(market="IT", starts_local="2026-10-24T11:00")])
    change = await scheduled(world, soon, MARKETING, FINANCE)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMMERCE_", "FAULT_"))}
    env.update({"PYTHONPATH": SOURCE, "PYTHONIOENCODING": "utf-8", "COMMERCE_DATABASE_URL": APP_URL.format(database=world.name),
                "COMMERCE_INTERNAL_TOKEN": secrets.token_hex(32), "COMMERCE_ENGINE_PORT": str(PORT or free_port()),
                "COMMERCE_STOP_ON_STDIN_CLOSE": "1", "COMMERCE_ACTIVATION_INTERVAL_SECONDS": "0.2",
                "FAULT_STEP": "publish", "FAULT_KIND": "stop"})
    process = await asyncio.create_subprocess_exec(sys.executable, "-m", "commerce.server", stdin=asyncio.subprocess.PIPE,
                                                   stderr=asyncio.subprocess.PIPE, env=env)
    engine = Engine(process)

    async def read() -> None:
        while raw := await process.stderr.readline():
            engine.lines.append(json.loads(raw))

    engine.reader = asyncio.create_task(read())
    try:
        await until(lambda: world.owner.fetchval("select state = 'done' from launch where change_id = $1", change.id), 60,
                    "the launch", engine)
    finally:
        code = await stop(engine)
    assert code == 0
    assert await world.owner.fetchval("select max(attempts) from launch_step") == 1
    assert not [line for line in engine.lines if line.get("event") == "fault"]
