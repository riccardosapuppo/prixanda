"""python -m commerce.server as a real process: it refuses a configuration
without its secrets, listens, answers, and stops in order (rule 35: a thing
that is built is run, not only built)."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import sys
from pathlib import Path
from urllib.parse import urlsplit

import grpc
from grpc_health.v1 import health_pb2, health_pb2_grpc

from commerce.v1 import catalog_pb2, catalog_pb2_grpc
from conftest import APP_URL
from wire_support import PORT

SOURCE = str(Path(__file__).resolve().parents[2] / "src")


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def engine_env(**values: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("COMMERCE_")}
    env.update({"PYTHONPATH": SOURCE, "PYTHONIOENCODING": "utf-8", **values})
    return env


async def lines_until(stream: asyncio.StreamReader, event: str, seen: list[dict], timeout: float = 30) -> dict:
    async def read() -> dict:
        while True:
            raw = await stream.readline()
            if not raw:
                raise AssertionError(f"the engine ended before logging {event}: {seen}")
            entry = json.loads(raw)
            seen.append(entry)
            if entry.get("event") == event:
                return entry
    return await asyncio.wait_for(read(), timeout)


async def test_without_its_secrets_the_engine_does_not_start():
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "commerce.server", stdin=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        env=engine_env(COMMERCE_DATABASE_URL="postgresql://commerce@127.0.0.1:1/commerce"))
    _, errors = await asyncio.wait_for(process.communicate(), 30)
    assert process.returncode == 2
    assert json.loads(errors)["event"] == "configuration" and "COMMERCE_INTERNAL_TOKEN" in errors.decode()


async def test_the_engine_listens_answers_and_stops_in_order(world):
    port = PORT or free_port()
    token = secrets.token_hex(32)
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "commerce.server", stdin=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=engine_env(COMMERCE_DATABASE_URL=APP_URL.format(database=world.name), COMMERCE_INTERNAL_TOKEN=token,
                       COMMERCE_ENGINE_PORT=str(port), COMMERCE_STOP_ON_STDIN_CLOSE="1",
                       COMMERCE_ACTIVATION_INTERVAL_SECONDS="0"))
    seen: list[dict] = []
    try:
        listening = await lines_until(process.stderr, "listening", seen)
        assert listening["address"] == f"127.0.0.1:{port}" and listening["serving"] is True
        password = urlsplit(APP_URL).password
        assert password and password not in json.dumps(seen) and token not in json.dumps(seen)
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            health = await health_pb2_grpc.HealthStub(channel).Check(health_pb2.HealthCheckRequest(service=""))
            assert health.status == health_pb2.HealthCheckResponse.SERVING
            markets = await catalog_pb2_grpc.CatalogServiceStub(channel).ListMarkets(
                catalog_pb2.ListMarketsRequest(),
                metadata=[("authorization", f"Bearer {token}"), ("x-request-id", "process-test-0001")])
            assert len(markets.markets) == 4
        await lines_until(process.stderr, "rpc", seen)
        process.stdin.close()
        await lines_until(process.stderr, "stopped", seen)
        assert await asyncio.wait_for(process.wait(), 30) == 0
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    events = [entry["event"] for entry in seen]
    assert events[:2] == ["listening", "rpc"] and events[-2:] == ["stopping", "stopped"]
