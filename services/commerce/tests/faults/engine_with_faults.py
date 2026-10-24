"""The engine's server with one fault armed: for the fault-injection tests of
this folder, and for nothing else.

It is the server of `python -m commerce.server`, given two things that the
server's entry point never gives: a clock that runs from the instant the test
chose, and the probe of launches.py, armed for one step:

  FAULT_STEP  check, prepare, publish, notify or verify
  FAULT_KIND  stop: the process ends at once, inside the step's transaction,
              with nothing cleaned up, as when the machine loses power;
              cut: the step's own connection to the database is terminated,
              inside its transaction, and the engine goes on

The fault fires once, when the step's work is done and before its
transaction commits. Without FAULT_STEP this is the plain server on the
test's clock: the engine coming back after a stop.

  FAULT_CLOCK_BASE  the instant the clock starts from (ISO 8601 with Z)
  FAULT_CLOCK_WALL  the machine's time, in seconds, that instant stands for
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timedelta

from commerce.domain.localtime import parse_instant
from commerce.server.app import serve
from commerce.server.config import from_env

STOPPED = 75  # the exit code of a stop: the test knows the fault fired, and where


class RunningClock:
    """The test's instant, running on with the machine's time: the same in the engine that stopped and the one after."""

    def __init__(self, base: datetime, wall: float) -> None:
        self.base = base
        self.wall = wall

    def now(self) -> datetime:
        return self.base + timedelta(seconds=time.time() - self.wall)


def say(**fields) -> None:
    sys.stderr.write(json.dumps({"event": "fault", **fields}) + "\n")
    sys.stderr.flush()


def main() -> int:
    config = from_env(os.environ)
    clock = RunningClock(parse_instant(os.environ["FAULT_CLOCK_BASE"]), float(os.environ["FAULT_CLOCK_WALL"]))
    step, kind = os.environ.get("FAULT_STEP"), os.environ.get("FAULT_KIND")
    if step is not None and kind not in ("stop", "cut"):
        raise SystemExit(f"FAULT_KIND is stop or cut, not {kind!r}")
    fired = False

    async def probe(name: str, phase: str, tx) -> None:
        nonlocal fired
        if fired or name != step or phase != "end":
            return
        fired = True
        say(step=name, kind=kind)
        if kind == "stop":
            os._exit(STOPPED)
        await tx.execute("select pg_terminate_backend(pg_backend_pid())")

    return asyncio.run(serve(config, clock=clock, probe=probe if step else None))


if __name__ == "__main__":
    sys.exit(main())
