"""The engine's gRPC server, started for real on a port, and a real client.

The server runs in the tests' own process, on the test's world (its database
and its clock), so a test can move the clock and look into the database. The
port is COMMERCE_TEST_ENGINE_PORT, which `npm run check` sets after asking the
system that nobody listens on it; run by hand, the system picks a free one.
"""

from __future__ import annotations

import io
import json
import os
import secrets
import uuid
from dataclasses import dataclass, field

import grpc
import pytest_asyncio

from commerce.engine.engine import METHODS
from commerce.server.app import Running, start
from commerce.server.config import Config
from commerce.engine.logs import JsonLog
from commerce.v1 import (
    audit_pb2_grpc, catalog_pb2_grpc, changes_pb2_grpc, launches_pb2_grpc, overview_pb2_grpc, quotes_pb2_grpc,
    simulation_pb2_grpc, subscriptions_pb2_grpc,
)
from engine_support import MARKETING

PORT = int(os.environ.get("COMMERCE_TEST_ENGINE_PORT", "0"))
STUBS = {
    "CatalogService": catalog_pb2_grpc.CatalogServiceStub, "QuoteService": quotes_pb2_grpc.QuoteServiceStub,
    "ChangeService": changes_pb2_grpc.ChangeServiceStub, "SimulationService": simulation_pb2_grpc.SimulationServiceStub,
    "AuditService": audit_pb2_grpc.AuditServiceStub, "OverviewService": overview_pb2_grpc.OverviewServiceStub,
    "PeopleService": overview_pb2_grpc.PeopleServiceStub,
    "SubscriberService": subscriptions_pb2_grpc.SubscriberServiceStub,
    "LaunchService": launches_pb2_grpc.LaunchServiceStub,
}
BY_NAME = {m.name: m for m in METHODS.values()}
# What each method was seen doing over the wire in this session: "answer",
# "refusal", or the name of a status code.
SEEN: dict[str, set[str]] = {}


@dataclass
class Reply:
    response: object | None
    code: grpc.StatusCode
    details: str
    initial: dict[str, str]
    trailing: dict[str, str]


@dataclass
class Wire:
    channel: grpc.aio.Channel
    token: str
    running: Running
    logs: io.StringIO
    world: object
    stubs: dict = field(default_factory=dict)

    def log_lines(self) -> list[dict]:
        return [json.loads(line) for line in self.logs.getvalue().splitlines()]

    async def call(self, method: str, request, who=MARKETING, *, key: str | None = "auto", token: str | None = "auto",
                   request_id: str | None = "auto", timeout: float = 10.0, metadata: list | None = None) -> Reply:
        spec = BY_NAME[method]
        stub = self.stubs.setdefault(spec.service, STUBS[spec.service](self.channel))
        sent = []
        if token is not None:
            sent.append(("authorization", f"Bearer {self.token if token == 'auto' else token}"))
        if request_id is not None:
            sent.append(("x-request-id", f"req-{uuid.uuid4().hex[:16]}" if request_id == "auto" else request_id))
        actor, role = who
        if actor is not None:
            sent.append(("x-actor", actor))
        if role is not None:
            sent.append(("x-actor-role", role))
        if key == "auto":
            key = f"key-{uuid.uuid4().hex}" if spec.writes else None
        if key is not None:
            sent.append(("idempotency-key", key))
        sent.extend(metadata or [])
        rpc = getattr(stub, method)(request, metadata=sent, timeout=timeout)
        try:
            response = await rpc
            code, details = grpc.StatusCode.OK, ""
        except grpc.aio.AioRpcError as error:
            response, code, details = None, error.code(), error.details() or ""
        initial = {k: v for k, v in (await rpc.initial_metadata() or ())}
        trailing = {k: v for k, v in (await rpc.trailing_metadata() or ())}
        outcome = code.name
        if code is grpc.StatusCode.OK:
            has_outcome = "outcome" in spec.response.DESCRIPTOR.oneofs_by_name
            outcome = "refusal" if has_outcome and response.WhichOneof("outcome") == "refusal" else "answer"
        SEEN.setdefault(method, set()).add(outcome)
        return Reply(response, code, details, initial, trailing)


@pytest_asyncio.fixture
async def wire(world):
    token = secrets.token_hex(32)
    logs = io.StringIO()
    log = JsonLog(world.clock.now, logs)
    config = Config(database_url="postgresql://unused", token=token, port=PORT)
    running = await start(world.engine, config, log)
    assert running is not None, logs.getvalue()
    channel = grpc.aio.insecure_channel(f"127.0.0.1:{running.port}")
    try:
        yield Wire(channel, token, running, logs, world)
    finally:
        await channel.close()
        await running.stop(0)
