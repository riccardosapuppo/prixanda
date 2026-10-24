"""The gRPC layer: every method of the contract, from the engine's method
table, behind the internal token.

Status codes, and what they mean here:
  UNAUTHENTICATED     no internal token, or the wrong one: only the gateway calls
  INVALID_ARGUMENT    a malformed call: a missing x-request-id or idempotency-key,
                      a field that cannot mean anything, a key reused for
                      another request
  PERMISSION_DENIED   no person on a method that acts for one, a person who does
                      not exist or does not hold the role they act in, or a role
                      that may not read what it asks for
  NOT_FOUND           an identifier that names nothing
  FAILED_PRECONDITION the data is not in a state the call can be served from
  ABORTED             a call with the same idempotency key is still running
  UNAVAILABLE         the database cannot be reached
  INTERNAL            the engine broke; the details stay in its log, under the
                      request id
A business refusal is never one of these: it is an answer, in the response.
x-request-id comes back in the response's metadata, at the start and at the
end, errors included.
"""

from __future__ import annotations

import asyncio
import hmac
import time
from collections.abc import Callable

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc

from commerce.engine.call import TOKEN_SHAPE, Call
from commerce.engine.engine import METHODS, Engine, Method
from commerce.engine.errors import EngineError
from commerce.server.logs import JsonLog
from commerce.v1 import common_pb2

CODES = {
    "INVALID_ARGUMENT": grpc.StatusCode.INVALID_ARGUMENT, "NOT_FOUND": grpc.StatusCode.NOT_FOUND,
    "PERMISSION_DENIED": grpc.StatusCode.PERMISSION_DENIED, "FAILED_PRECONDITION": grpc.StatusCode.FAILED_PRECONDITION,
    "ABORTED": grpc.StatusCode.ABORTED, "UNAVAILABLE": grpc.StatusCode.UNAVAILABLE, "INTERNAL": grpc.StatusCode.INTERNAL,
}
SERVICES = sorted({f"commerce.v1.{m.service}" for m in METHODS.values()})


class Unauthenticated(Exception):
    pass


def bearer(value: str | None, expected: str) -> None:
    if not value or not value.startswith("Bearer "):
        raise Unauthenticated("the engine answers the gateway only: send authorization: Bearer <internal token>")
    if not hmac.compare_digest(value[len("Bearer "):].encode(), expected.encode()):
        raise Unauthenticated("the internal token is not the one this engine was given")


def _handler(engine: Engine, method: Method, token: str, log: JsonLog) -> Callable:
    async def behaviour(request, context: grpc.aio.ServicerContext):
        started = time.perf_counter()
        metadata = {key: value for key, value in context.invocation_metadata() if isinstance(value, str)}
        request_id = metadata.get("x-request-id")
        echoed = (("x-request-id", request_id),) if request_id and TOKEN_SHAPE.match(request_id) else ()
        if echoed:
            await context.send_initial_metadata(echoed)
            context.set_trailing_metadata(echoed)
        status, message, outcome, call = grpc.StatusCode.OK, "", "answer", None
        response = None
        try:
            bearer(metadata.get("authorization"), token)
            call = Call(request_id=request_id or "", actor=metadata.get("x-actor"), role=metadata.get("x-actor-role"),
                        idempotency_key=metadata.get("idempotency-key"))
            response = await engine.handle(method.full_name, call, request)
            if "outcome" in method.response.DESCRIPTOR.oneofs_by_name and response.WhichOneof("outcome") == "refusal":
                outcome = "refusal"
        except Unauthenticated as error:
            status, message, outcome = grpc.StatusCode.UNAUTHENTICATED, str(error), "error"
        except EngineError as error:
            status, message, outcome = CODES[error.status], str(error), "error"
        except asyncio.CancelledError:
            log("info", "rpc", method=method.full_name, request_id=request_id, outcome="cancelled",
                ms=round((time.perf_counter() - started) * 1000, 1))
            raise
        except Exception as error:  # a bug: the client learns the request id, the log the rest
            status, outcome = grpc.StatusCode.INTERNAL, "error"
            message = f"the engine failed on this call; its log has the details under request id {request_id}"
            log("error", "rpc_failed", method=method.full_name, request_id=request_id,
                error=f"{type(error).__name__}: {error}")
        log("info" if outcome != "error" else "warning", "rpc", method=method.full_name, request_id=request_id,
            actor=call.actor if call else None, role=call.role if call else None, outcome=outcome,
            refusal=common_pb2.RefusalCode.Name(response.refusal.code) if outcome == "refusal" else None,
            status=status.name, ms=round((time.perf_counter() - started) * 1000, 1))
        if status is not grpc.StatusCode.OK:
            await context.abort(status, message)
        return response

    return grpc.unary_unary_rpc_method_handler(
        behaviour, request_deserializer=method.request.FromString, response_serializer=method.response.SerializeToString)


def generic_handlers(engine: Engine, token: str, log: JsonLog) -> list:
    by_service: dict[str, dict] = {}
    for method in METHODS.values():
        by_service.setdefault(f"commerce.v1.{method.service}", {})[method.name] = _handler(engine, method, token, log)
    return [grpc.method_handlers_generic_handler(service, handlers) for service, handlers in by_service.items()]


class Health:
    """The standard health protocol: SERVING while the database answers."""

    def __init__(self, engine: Engine, log: JsonLog) -> None:
        self.servicer = health.aio.HealthServicer()
        self.engine = engine
        self.log = log
        self.serving: bool | None = None

    async def check_once(self) -> bool:
        try:
            await self.engine.db.ping()
            serving = True
        except Exception as error:
            serving = False
            if self.serving is not False:
                self.log("warning", "database_unreachable", error=f"{type(error).__name__}: {error}")
        if serving != self.serving:
            status = health_pb2.HealthCheckResponse.SERVING if serving else health_pb2.HealthCheckResponse.NOT_SERVING
            for name in ("", *SERVICES):
                await self.servicer.set(name, status)
            self.serving = serving
        return serving

    async def run(self, interval: float) -> None:
        while True:
            await self.check_once()
            await asyncio.sleep(interval)


def health_server(servicer, server: grpc.aio.Server) -> None:
    health_pb2_grpc.add_HealthServicer_to_server(servicer, server)
