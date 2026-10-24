"""The rules of the wire: only the gateway's token gets in, the request id
comes back, every call leaves one JSON log line, a bug leaks nothing, a
deadline is honoured, and health says whether the database answers."""

from __future__ import annotations

import asyncio
import io
import secrets
import socket

import grpc
import pytest
from grpc_health.v1 import health_pb2, health_pb2_grpc

from commerce.adapters.asyncpg_database import AsyncpgDatabase
from commerce.engine.call import FixedClock
from commerce.engine.engine import Engine
from commerce.server.app import start
from commerce.server.config import Config
from commerce.server.logs import JsonLog
from commerce.v1 import catalog_pb2, catalog_pb2_grpc, changes_pb2, overview_pb2
from engine_support import FINANCE, MARKETING, PUBLIC, student_autumn
from helpers import T0
from wire_support import PORT, wire  # noqa: F401  (the fixture)

CODE = grpc.StatusCode


@pytest.mark.parametrize(("token", "header"), [(None, None), ("wrong", None), (None, ("authorization", "Basic abc"))])
async def test_only_the_internal_token_gets_in(wire, token, header):
    reply = await wire.call("ListMarkets", catalog_pb2.ListMarketsRequest(), PUBLIC,
                            token=None if header or token is None else "z" * 64, metadata=[header] if header else None)
    assert reply.code is CODE.UNAUTHENTICATED and "internal token" in reply.details


async def test_the_request_id_comes_back_at_the_start_and_at_the_end_errors_included(wire):
    ok = await wire.call("ListMarkets", catalog_pb2.ListMarketsRequest(), PUBLIC, request_id="site-1a2b3c4d")
    assert ok.initial["x-request-id"] == ok.trailing["x-request-id"] == "site-1a2b3c4d"
    failed = await wire.call("GetChange", changes_pb2.GetChangeRequest(change_id=5), FINANCE, request_id="console-77aa88bb")
    assert failed.code is CODE.NOT_FOUND and failed.trailing["x-request-id"] == "console-77aa88bb"


@pytest.mark.parametrize("request_id", [None, "bad", "has spaces in it"])
async def test_a_call_without_a_well_formed_request_id_is_malformed(wire, request_id):
    reply = await wire.call("ListMarkets", catalog_pb2.ListMarketsRequest(), PUBLIC, request_id=request_id)
    assert reply.code is CODE.INVALID_ARGUMENT and "x-request-id" not in reply.initial | reply.trailing


async def test_a_malformed_idempotency_key_is_refused(wire):
    reply = await wire.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn()), MARKETING, key="no")
    assert reply.code is CODE.INVALID_ARGUMENT


async def test_each_call_leaves_one_json_line_with_its_request_id_and_never_the_token(wire):
    await wire.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn()), FINANCE, request_id="console-00000042")
    [line] = [entry for entry in wire.log_lines() if entry.get("request_id") == "console-00000042"]
    assert (line["event"], line["method"], line["outcome"], line["refusal"]) == (
        "rpc", "commerce.v1.ChangeService/CreateChange", "refusal", "REFUSAL_CODE_ROLE_NOT_ALLOWED")
    assert (line["actor"], line["role"], line["status"], line["at"]) == ("finance-1", "finance", "OK", "2026-10-24T08:42:00Z")
    assert wire.token not in wire.logs.getvalue()


async def test_a_bug_becomes_internal_without_its_details(wire, monkeypatch):
    async def broken(tx, call, request):
        raise RuntimeError("secret detail of the database")

    monkeypatch.setitem(wire.world.engine.handlers, "ListMarkets", broken)
    reply = await wire.call("ListMarkets", catalog_pb2.ListMarketsRequest(), PUBLIC, request_id="site-0000bug1")
    assert reply.code is CODE.INTERNAL
    assert "site-0000bug1" in reply.details and "secret" not in reply.details and "Traceback" not in reply.details
    [failure] = [e for e in wire.log_lines() if e["event"] == "rpc_failed"]
    assert "secret detail" in failure["error"] and failure["request_id"] == "site-0000bug1"


async def test_a_call_past_its_deadline_ends_on_time(wire, monkeypatch):
    async def slow(tx, call, request):
        await asyncio.sleep(5)

    monkeypatch.setitem(wire.world.engine.handlers, "GetOverview", slow)
    reply = await wire.call("GetOverview", overview_pb2.GetOverviewRequest(), FINANCE, timeout=0.3)
    assert reply.code is CODE.DEADLINE_EXCEEDED
    for _ in range(50):
        if any(e.get("outcome") == "cancelled" for e in wire.log_lines()):
            break
        await asyncio.sleep(0.05)
    assert any(e.get("outcome") == "cancelled" for e in wire.log_lines())


async def test_health_is_the_standard_protocol(wire):
    stub = health_pb2_grpc.HealthStub(wire.channel)
    for service in ("", "commerce.v1.ChangeService", "commerce.v1.CatalogService"):
        answer = await stub.Check(health_pb2.HealthCheckRequest(service=service))
        assert answer.status == health_pb2.HealthCheckResponse.SERVING, service


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


async def test_without_its_database_the_engine_says_so(world):
    # A pool on a port where nothing listens: the engine starts, health says
    # NOT_SERVING, and a call is UNAVAILABLE rather than a crash.
    database = await AsyncpgDatabase.connect(f"postgresql://commerce@127.0.0.1:{free_port()}/commerce")
    engine = Engine(database, FixedClock(T0))
    logs = io.StringIO()
    token = secrets.token_hex(32)
    running = await start(engine, Config(database_url="postgresql://unused", token=token, port=PORT), JsonLog(lambda: T0, logs))
    channel = grpc.aio.insecure_channel(f"127.0.0.1:{running.port}")
    try:
        health = await health_pb2_grpc.HealthStub(channel).Check(health_pb2.HealthCheckRequest(service=""))
        assert health.status == health_pb2.HealthCheckResponse.NOT_SERVING
        stub = catalog_pb2_grpc.CatalogServiceStub(channel)
        with pytest.raises(grpc.aio.AioRpcError) as failed:
            await stub.ListMarkets(catalog_pb2.ListMarketsRequest(), metadata=[
                ("authorization", f"Bearer {token}"), ("x-request-id", "site-00000down")])
        assert failed.value.code() is CODE.UNAVAILABLE
        assert "database_unreachable" in logs.getvalue()
    finally:
        await channel.close()
        await running.stop(0)
        await database.close()
