"""Starting and stopping the engine's server.

serve() starts the server, the health checks and the activation timer, and
waits for a stop: Ctrl+C, a termination signal, or (for a supervisor that
started it with COMMERCE_STOP_ON_STDIN_CLOSE=1) its standard input closing.
Then it stops in order: health says NOT_SERVING, no new calls are taken,
the running ones get the grace period to finish, the timers stop, the
database pool closes, and the last log line says so.
"""

from __future__ import annotations

import asyncio
import signal
import sys
import threading
from datetime import UTC, datetime

import grpc

from commerce.adapters.asyncpg_database import AsyncpgDatabase
from commerce.engine.engine import Engine
from commerce.server.config import Config
from commerce.server.grpc_server import Health, generic_handlers, health_server
from commerce.server.logs import JsonLog

MAX_MESSAGE = 4 * 1024 * 1024


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


async def _activation_timer(engine: Engine, interval: float, log: JsonLog) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            for outcome in [*await engine.activate_due(), *await engine.end_due()]:
                level = "warning" if outcome.action in ("failed", "refused") else "info"
                log(level, "activation", change=outcome.change_id, action=outcome.action, snapshot=outcome.snapshot_id,
                    error=outcome.error)
        except Exception as error:  # the next tick tries again; stage 6 brings retries and alarms
            log("warning", "activation_pass_failed", error=f"{type(error).__name__}: {error}")


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


async def serve(config: Config, *, clock=None, log: JsonLog | None = None) -> int:
    clock = clock or SystemClock()
    log = log or JsonLog(clock.now)
    database = await AsyncpgDatabase.connect(config.database_url, max_size=config.pool_size)
    engine = Engine(database, clock)
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
        tasks.append(asyncio.create_task(_activation_timer(engine, config.activation_interval, log), name="activation"))
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
