"""The entrance the browser's demo calls (packages/sandbox/src/engine): the
engine behind the same contract as its gRPC server, in the page's worker.

  call       one method of the contract: its full name, the metadata the
             gateway writes and the request's bytes; the response's bytes, or
             the status code and message gRPC would have sent
             (server/grpc_server.py does the same over the network)
  tick       one pass of the engine's jobs (jobs.py), and what it changed, in
             the five words the worker tells its tabs
  next_due   when a launch next has work, for the demo's "skip to the next
             launch"

The demo's clock is the page's: the machine's time plus the offset the demo
moved it by, read through now_ms. A simulated fault can be armed on a step of
the next launch: the step does all its work, then fails before it commits, so
the database keeps none of it, and the launch's own code recovers, exactly as
from a cut connection. The fault says it is simulated wherever it shows (the
step's error, the incident, the log): the faults of the full system are
injected by its own tests, which stop the engine's process (tests/faults).
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from commerce.browser.pglite import Bridge, PGliteDatabase
from commerce.domain.localtime import format_instant
from commerce.engine.call import Call, Unauthenticated, bearer
from commerce.engine.engine import METHODS, Engine
from commerce.engine.errors import CODES, EngineError
from commerce.engine.jobs import Jobs, Logged
from commerce.engine.launches import STEPS
from commerce.engine.logs import JsonLog
from commerce.v1 import common_pb2

CHANGES = ("catalog", "changes", "launches", "accounts", "audit")


class DemoClock:
    """The demo's clock: the page says what time it is, in milliseconds since 1970 (Date.now() plus the demo's offset)."""

    def __init__(self, now_ms: Callable[[], float]) -> None:
        self._now_ms = now_ms

    def now(self) -> datetime:
        return datetime.fromtimestamp(float(self._now_ms()) / 1000, UTC)


class SimulatedFault(Exception):
    """A fault the demo simulates in a step of a launch."""


class DemoFaults:
    """The launch's probe (launches.py), in the demo only: armed on a step, it fails that step once, just before the
    step's transaction commits."""

    def __init__(self) -> None:
        self.armed: str | None = None

    def arm(self, step: str) -> None:
        if step not in STEPS:
            raise ValueError(f"a launch has the steps {', '.join(STEPS)}")
        self.armed = step

    def clear(self) -> None:
        self.armed = None

    async def probe(self, step: str, phase: str, tx) -> None:
        if phase == "end" and self.armed == step:
            self.armed = None
            raise SimulatedFault(
                f"simulated by the demo: the {step} step was cut just before it committed, so the database kept none "
                "of it, and the launch tries the step again")


def changed(logged: list[Logged]) -> list[str]:
    """What a pass of the jobs changed, for the tabs to read again."""
    found: set[str] = set()
    for line in logged:
        event, fields = line.event, line.fields
        if event.startswith(("launch_", "incident_")):
            found.add("launches")
            if event in ("launch_done", "launch_refused", "launch_failed", "launch_cancelled"):
                found.update(("changes", "audit"))
            if event == "launch_done":
                found.add("catalog")
            if event.startswith("incident_"):
                found.add("audit")
        elif event == "offer_ended":
            found.update(("catalog", "changes", "audit"))
        elif event in ("prepaid_code_expired", "price_change_settled"):
            found.update(("accounts", "audit"))
        elif event == "outbox_delivered":
            found.update(("catalog",) if fields.get("topic") == "catalog.published" else ("accounts", "audit"))
    return [word for word in CHANGES if word in found]


class _Lines:
    """The log's stream: each line to the page (console.debug there, out of sight unless asked for)."""

    def __init__(self, write_line: Callable[[str], Any]) -> None:
        self._write_line = write_line
        self._pending = ""

    def write(self, text: str) -> int:
        self._pending += text
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            self._write_line(line)
        return len(text)

    def flush(self) -> None:
        pass


class Sandbox:
    def __init__(self, bridge: Bridge, now_ms: Callable[[], float], token: str, write_line: Callable[[str], Any]) -> None:
        if len(token) < 32:
            raise ValueError("the internal token is at least 32 characters")
        self.clock = DemoClock(now_ms)
        self.faults = DemoFaults()
        self.log = JsonLog(self.clock.now, _Lines(write_line))
        self.engine = Engine(PGliteDatabase(bridge), self.clock, probe=self.faults.probe)
        self.jobs = Jobs(self.engine, self.log)
        self._token = token

    async def call(self, full_name: str, metadata_json: str, request: Any) -> tuple[int, str, bytes]:
        """As the gRPC server's handler: the response's bytes with code 0, or a status code and its message. The request
        is bytes, or the page's Uint8Array."""
        started = time.perf_counter()
        request = request.to_bytes() if hasattr(request, "to_bytes") else bytes(request)
        method = METHODS.get(full_name)
        if method is None:
            return CODES["UNIMPLEMENTED"], f"the engine has no method {full_name}", b""
        metadata = {str(k): str(v) for k, v in json.loads(metadata_json).items()}
        request_id = metadata.get("x-request-id")
        status, message, outcome, call, response = 0, "", "answer", None, None
        try:
            bearer(metadata.get("authorization"), self._token)
            try:
                parsed = method.request.FromString(request)
            except Exception as error:  # what gRPC answers for bytes that are not the request
                raise _Undecodable(f"the request is not a {method.request.__name__}") from error
            call = Call(request_id=request_id or "", actor=metadata.get("x-actor"), role=metadata.get("x-actor-role"),
                        idempotency_key=metadata.get("idempotency-key"))
            response = await self.engine.handle(method.full_name, call, parsed)
            if "outcome" in method.response.DESCRIPTOR.oneofs_by_name and response.WhichOneof("outcome") == "refusal":
                outcome = "refusal"
        except Unauthenticated as error:
            status, message, outcome = CODES["UNAUTHENTICATED"], str(error), "error"
        except _Undecodable as error:
            status, message, outcome = CODES["INTERNAL"], str(error), "error"
        except EngineError as error:
            status, message, outcome = CODES[error.status], str(error), "error"
        except Exception as error:  # a bug: the caller learns the request id, the log the rest
            status, outcome = CODES["INTERNAL"], "error"
            message = f"the engine failed on this call; its log has the details under request id {request_id}"
            self.log("error", "rpc_failed", method=method.full_name, request_id=request_id,
                     error=f"{type(error).__name__}: {error}")
        self.log("info" if outcome != "error" else "warning", "rpc", method=method.full_name, request_id=request_id,
                 actor=call.actor if call else None, role=call.role if call else None, outcome=outcome,
                 refusal=common_pb2.RefusalCode.Name(response.refusal.code) if outcome == "refusal" else None,
                 status=status, ms=round((time.perf_counter() - started) * 1000, 1))
        if status != 0:
            return status, message, b""
        return 0, "", response.SerializeToString()

    async def tick(self) -> str:
        """One pass of the jobs: how many changes of state it made, and what they changed (JSON)."""
        logged = await self.jobs.run_pass()
        made = [line for line in logged if line.event not in ("jobs_pass_failed", "jobs_working_again", "idempotency_keys_pruned")]
        return json.dumps({"ran": len(made), "changed": changed(logged)})

    async def next_due(self) -> str | None:
        moment = await self.engine.next_launch_due()
        return None if moment is None else format_instant(moment)

    async def launches_due(self, change: int | None = None) -> str:
        """The launches waiting for a moment of their own, the earliest first, one change's when given (JSON): what
        the demo's skip to the next launch walks along (packages/sandbox/src/engine/index.ts)."""
        due = await self.engine.launches_due(None if change is None else int(change))
        return json.dumps([{"at": format_instant(d.at), "change": d.change, "starts": format_instant(d.starts)} for d in due])

    async def launch_state(self, change: int) -> str | None:
        async with self.engine.db.transaction(readonly=True) as tx:
            return await tx.fetchval("select state from launch where change_id = $1", int(change))

    def arm_fault(self, step: str) -> None:
        self.faults.arm(step)

    def clear_fault(self) -> None:
        self.faults.clear()

    def armed_fault(self) -> str | None:
        return self.faults.armed


class _Undecodable(Exception):
    pass
