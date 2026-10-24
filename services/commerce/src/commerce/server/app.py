"""Starting and stopping the engine's server.

serve() starts the server, the health checks and the engine's jobs, and
waits for a stop: Ctrl+C, a termination signal, or (for a supervisor that
started it with COMMERCE_STOP_ON_STDIN_CLOSE=1) its standard input closing.
Then it stops in order: health says NOT_SERVING, no new calls are taken,
the running ones get the grace period to finish, the timers stop, the
database pool closes, and the last log line says so.

The jobs (the launches, the end of offers, the outbox, the pruning of
idempotency keys) run once at the start, which resumes whatever a stop left
halfway, then every COMMERCE_ACTIVATION_INTERVAL_SECONDS, or at once when a
call leaves work for them. Their log says each change of state once: a
launch that waits for its next attempt, or that was refused, writes nothing
more until something happens to it, and a pass that keeps failing for the
same reason says so once, then once more when it works again.
"""

from __future__ import annotations

import asyncio
import signal
import sys
import threading
from datetime import UTC, datetime, timedelta

import grpc

from commerce.adapters.asyncpg_database import AsyncpgDatabase
from commerce.engine.engine import Engine
from commerce.engine.launches import Probe, run_id
from commerce.server.config import Config
from commerce.server.grpc_server import Health, generic_handlers, health_server
from commerce.server.logs import JsonLog

MAX_MESSAGE = 4 * 1024 * 1024
PRUNE_EVERY = timedelta(hours=1)


class SystemClock:
    """The machine's clock: the one place that reads it. The engine and its
    rules only ever see the instant this returns."""

    def now(self) -> datetime:
        return datetime.now(UTC)


def _stop_requests(loop: asyncio.AbstractEventLoop, stop: asyncio.Event, config: Config, log: JsonLog) -> None:
    def request_stop(why: str) -> None:
        if not stop.is_set():
            log("info", "stopping", why=why)
            stop.set()

    def on_signal(number, frame) -> None:  # runs in the main thread, between bytecodes
        loop.call_soon_threadsafe(request_stop, signal.Signals(number).name)

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), on_signal)
    if config.stop_on_stdin_close:
        def watch_stdin() -> None:
            while sys.stdin.buffer.read(4096):
                pass
            loop.call_soon_threadsafe(request_stop, "standard input closed")

        threading.Thread(target=watch_stdin, name="stdin-watch", daemon=True).start()


class Jobs:
    """The engine's jobs, one pass at a time, with a log line for each change of state."""

    def __init__(self, engine: Engine, log: JsonLog) -> None:
        self.engine = engine
        self.log = log
        self.pruned_at: datetime | None = None
        self.failing: str | None = None  # the error the last pass failed with
        self.ending: dict[int, str] = {}  # the error an offer's end last failed with

    async def run_pass(self) -> None:
        engine, log = self.engine, self.log
        try:
            for happened in await engine.run_launches():
                log(happened.level, happened.event, **{"launch": happened.launch, "run": run_id(happened.launch),
                                                       "change": happened.change, **happened.detail})
            for outcome in await engine.end_due():
                if outcome.action == "ended":
                    self.ending.pop(outcome.change_id, None)
                    log("info", "offer_ended", change=outcome.change_id, snapshot=outcome.snapshot_id)
                elif outcome.action == "failed" and self.ending.get(outcome.change_id) != outcome.error:
                    self.ending[outcome.change_id] = outcome.error or ""
                    log("warning", "offer_end_failed", change=outcome.change_id, error=outcome.error)
            for delivery in await engine.deliver_outbox():
                if delivery.delivered:
                    log("info", "outbox_delivered", **{**delivery.facts, "message": delivery.message_id, "topic": delivery.topic,
                                                       "consumer": delivery.consumer, "attempts": delivery.attempts})
                else:
                    log("warning", "outbox_delivery_failed", message=delivery.message_id, topic=delivery.topic,
                        consumer=delivery.consumer, attempts=delivery.attempts, error=delivery.error)
            now = engine.clock.now()
            if self.pruned_at is None or now - self.pruned_at >= PRUNE_EVERY:
                pruned = await engine.prune_idempotency_keys()
                self.pruned_at = now
                if pruned:
                    log("info", "idempotency_keys_pruned", keys=pruned)
            if self.failing is not None:
                log("info", "jobs_working_again", after=self.failing)
                self.failing = None
        except asyncio.CancelledError:
            raise
        except Exception as error:  # the next pass tries again; a launch resumes where it stopped
            text = f"{type(error).__name__}: {error}"
            if text != self.failing:
                log("warning", "jobs_pass_failed", error=text)
            self.failing = text


async def _jobs(engine: Engine, interval: float, log: JsonLog) -> None:
    jobs = Jobs(engine, log)
    while True:
        engine.wake.clear()
        await jobs.run_pass()
        try:
            await asyncio.wait_for(engine.wake.wait(), interval)
        except TimeoutError:
            pass


class Running:
    """A started server: the gRPC server, its health checks and the port it got."""

    def __init__(self, server: grpc.aio.Server, health: Health, port: int) -> None:
        self.server = server
        self.health = health
        self.port = port

    async def stop(self, grace: float) -> None:
        await self.health.servicer.enter_graceful_shutdown()
        await self.server.stop(grace)


async def start(engine: Engine, config: Config, log: JsonLog) -> Running | None:
    """The gRPC server on the engine, listening, or None when the address cannot be taken."""
    server = grpc.aio.server(options=[("grpc.max_receive_message_length", MAX_MESSAGE),
                                      ("grpc.max_send_message_length", MAX_MESSAGE)])
    server.add_generic_rpc_handlers(generic_handlers(engine, config.token, log))
    checks = Health(engine, log)
    health_server(checks.servicer, server)
    try:
        port = server.add_insecure_port(config.address)
    except RuntimeError as error:
        log("error", "cannot_listen", address=config.address, error=str(error))
        return None
    if port == 0:
        log("error", "cannot_listen", address=config.address)
        return None
    await checks.check_once()
    await server.start()
    return Running(server, checks, port)


async def serve(config: Config, *, clock=None, log: JsonLog | None = None, probe: Probe | None = None) -> int:
    """The engine's server, until it is told to stop. The probe is the fault-injection tests' own
    (launches.py): the entry point of the server passes none, and no setting turns one on."""
    clock = clock or SystemClock()
    log = log or JsonLog(clock.now)
    database = await AsyncpgDatabase.connect(config.database_url, max_size=config.pool_size)
    engine = Engine(database, clock, probe=probe)
    running = await start(engine, config, log)
    if running is None:
        await database.close()
        return 1
    log("info", "listening", address=f"{config.host}:{running.port}", database=config.database_for_logs(),
        serving=running.health.serving,
        identities="asserted by the gateway and checked against the people of the platform; "
                   "the gateway's demo sessions are not authentication")
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    _stop_requests(loop, stop, config, log)
    tasks = [asyncio.create_task(running.health.run(config.health_interval), name="health")]
    if config.activation_interval > 0:
        tasks.append(asyncio.create_task(_jobs(engine, config.activation_interval, log), name="jobs"))
    try:
        await stop.wait()
    finally:
        await running.stop(config.shutdown_grace)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await database.close()
        log("info", "stopped")
    return 0
