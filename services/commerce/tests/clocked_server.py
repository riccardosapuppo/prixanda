"""The engine's server with a clock that a test drives, for the integration
tests of the engine and the gateway (tools/check.ts, suite integration).

It is a test's launcher, not part of the engine: the server that runs for
real (python -m commerce.server) reads the machine's clock, and no variable
or mode of it moves time. This file starts the same server, configured from
the same environment, through the same serve(), and hands it a clock whose
time comes from standard input:

  python tests/clocked_server.py 2026-10-24T10:00:00Z

starts it at that instant. Each line `at <instant>` moves the clock, and is
acknowledged on standard output with `clock <instant>`. The engine's own log
goes to standard error, as it always does. When standard input closes, the
engine stops in order, as on Ctrl+C.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from datetime import UTC, datetime

from commerce.server.app import serve
from commerce.server.config import ConfigError, from_env


def instant(text: str) -> datetime:
    """An ISO 8601 instant with its offset (Z included), in UTC."""
    at = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if at.tzinfo is None:
        raise ValueError(f"{text} has no offset: an instant needs one")
    return at.astimezone(UTC)


class PilotedClock:
    """What the engine reads as now: the last instant the test sent."""

    def __init__(self, at: datetime) -> None:
        self._at = at

    def now(self) -> datetime:
        return self._at

    def move(self, at: datetime) -> None:
        self._at = at


async def run(start: datetime) -> int:
    config = from_env(os.environ)
    if config.stop_on_stdin_close:
        raise ConfigError("standard input drives the clock here: leave COMMERCE_STOP_ON_STDIN_CLOSE unset")
    clock = PilotedClock(start)
    loop = asyncio.get_running_loop()
    closed = asyncio.Event()

    def acknowledge(at: datetime) -> None:
        clock.move(at)
        sys.stdout.write(f"clock {at:%Y-%m-%dT%H:%M:%SZ}\n")
        sys.stdout.flush()

    def read_commands() -> None:
        for line in sys.stdin:
            words = line.split()
            if not words:
                continue
            try:
                if len(words) != 2 or words[0] != "at":
                    raise ValueError(f"unknown command {line.strip()!r}: send `at <instant>`")
                at = instant(words[1])
            except ValueError as error:
                sys.stdout.write(json.dumps({"clock_error": str(error)}) + "\n")
                sys.stdout.flush()
                continue
            # The clock moves in the loop's own thread, before the acknowledgement.
            loop.call_soon_threadsafe(acknowledge, at)
        loop.call_soon_threadsafe(closed.set)

    threading.Thread(target=read_commands, name="clock-commands", daemon=True).start()
    serving = asyncio.create_task(serve(config, clock=clock))
    waiting = asyncio.create_task(closed.wait())
    done, _ = await asyncio.wait({serving, waiting}, return_when=asyncio.FIRST_COMPLETED)
    if serving in done:
        waiting.cancel()
        return serving.result()
    # serve() stops in order when it is cancelled: health first, then the
    # calls in flight, the timers and the pool, and its last log line.
    serving.cancel()
    try:
        await serving
    except asyncio.CancelledError:
        pass
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: python tests/clocked_server.py <starting instant, such as 2026-10-24T10:00:00Z>\n")
        return 2
    try:
        start = instant(sys.argv[1])
        return asyncio.run(run(start))
    except (ConfigError, ValueError) as error:
        sys.stderr.write(json.dumps({"level": "error", "event": "configuration", "error": str(error)}) + "\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
