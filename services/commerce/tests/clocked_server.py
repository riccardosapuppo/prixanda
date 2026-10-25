"""The engine's server with a clock that a test drives, for the integration
tests of the engine and the gateway (tools/check.ts, suite integration).

It is a test's launcher, not part of the engine: the server that runs for
real (python -m commerce.server) reads the machine's clock, and no variable
or mode of it moves time. This file starts the same server, configured from
the same environment, through the same serve(), and hands it a clock whose
time comes from standard input:

  python tests/clocked_server.py 2026-10-24T10:00:00Z

starts it at that instant. Each line `at <instant>` moves the clock, and is
acknowledged on standard output with `clock <instant>`. The payment provider
is the simulated one, which the test can keep from answering, as a real
provider may take its time: `payments hold` holds each charge asked for from
then on, and its payment stays pending; `payments answer` lets the provider
answer them, and the ones after. They are acknowledged with `payments held`
and `payments answering`. The engine's own log goes to standard error, as it
always does. When standard input closes, the engine stops in order, as on
Ctrl+C.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from datetime import UTC, datetime

from commerce.engine.providers import Charge, ChargeResult, SimulatedPayments
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


class HeldPayments:
    """The simulated payment provider, kept from answering while the test holds it: a charge asked for
    meanwhile waits, outside any transaction as every charge is asked, and its payment stays pending."""

    def __init__(self, provider: SimulatedPayments) -> None:
        self.provider = provider
        self.name = provider.name
        self.answering = asyncio.Event()
        self.answering.set()

    async def charge(self, charge: Charge) -> ChargeResult:
        await self.answering.wait()
        return await self.provider.charge(charge)


async def run(start: datetime) -> int:
    config = from_env(os.environ)
    if config.stop_on_stdin_close:
        raise ConfigError("standard input drives the clock here: leave COMMERCE_STOP_ON_STDIN_CLOSE unset")
    clock = PilotedClock(start)
    payments = HeldPayments(SimulatedPayments(clock))
    loop = asyncio.get_running_loop()
    closed = asyncio.Event()

    def acknowledge(at: datetime) -> None:
        clock.move(at)
        sys.stdout.write(f"clock {at:%Y-%m-%dT%H:%M:%SZ}\n")
        sys.stdout.flush()

    def provider(answer: bool) -> None:
        if answer:
            payments.answering.set()
        else:
            payments.answering.clear()
        sys.stdout.write("payments answering\n" if answer else "payments held\n")
        sys.stdout.flush()

    def read_commands() -> None:
        for line in sys.stdin:
            words = line.split()
            if not words:
                continue
            if words in (["payments", "hold"], ["payments", "answer"]):
                loop.call_soon_threadsafe(provider, words[1] == "answer")
                continue
            try:
                if len(words) != 2 or words[0] != "at":
                    raise ValueError(f"unknown command {line.strip()!r}: send `at <instant>`, `payments hold` or `payments answer`")
                at = instant(words[1])
            except ValueError as error:
                sys.stdout.write(json.dumps({"clock_error": str(error)}) + "\n")
                sys.stdout.flush()
                continue
            # The clock moves in the loop's own thread, before the acknowledgement.
            loop.call_soon_threadsafe(acknowledge, at)
        loop.call_soon_threadsafe(closed.set)

    threading.Thread(target=read_commands, name="clock-commands", daemon=True).start()
    serving = asyncio.create_task(serve(config, clock=clock, payments=payments))
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
