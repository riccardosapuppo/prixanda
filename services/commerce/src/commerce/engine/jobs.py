"""The engine's jobs, one pass at a time: the launches, the end of offers,
the expiry of prepaid codes, the end of price migrations' windows, the
outbox's deliveries and the pruning of idempotency keys (engine.py).

The server runs a pass on its timer and when a call leaves work (server/app.py);
the browser's demo runs one when its worker ticks (browser/sandbox.py). A pass
logs each change of state once, and returns the lines it logged, which the
demo reads to tell its tabs what to read again: a launch that waits for its
next attempt, or that was refused, writes nothing more until something
happens to it, and a job that keeps failing for the same reason says so
once, then once more when it works again.

Each job runs whatever the ones before it did: one that fails, for a fault
of its own, holds up neither the others nor the pass after (a window that
cannot be settled must not keep the outbox from delivering). A database that
cannot be reached ends the pass instead, since every job needs it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from commerce.engine.engine import Engine
from commerce.engine.errors import Unavailable
from commerce.engine.launches import run_id

PRUNE_EVERY = timedelta(hours=1)


@dataclass(frozen=True)
class Logged:
    level: str
    event: str
    fields: dict[str, Any]


class Jobs:
    """The engine's jobs, one pass at a time, with a log line for each change of state."""

    def __init__(self, engine: Engine, log: Callable[..., None]) -> None:
        self.engine = engine
        self.log = log
        self.pruned_at: datetime | None = None
        self.failing: dict[str, str] = {}  # the error each job last failed with
        self.ending: dict[int, str] = {}  # the error an offer's end last failed with
        self.settling: dict[int, str] = {}  # the error a price change's window last failed to settle with

    async def run_pass(self) -> list[Logged]:
        engine = self.engine
        logged: list[Logged] = []

        def log(level: str, event: str, **fields: Any) -> None:
            self.log(level, event, **fields)
            logged.append(Logged(level, event, fields))

        async def launches() -> None:
            for happened in await engine.run_launches():
                log(happened.level, happened.event, **{"launch": happened.launch, "run": run_id(happened.launch),
                                                       "change": happened.change, **happened.detail})

        async def offers() -> None:
            for outcome in await engine.end_due():
                if outcome.action == "ended":
                    self.ending.pop(outcome.change_id, None)
                    log("info", "offer_ended", change=outcome.change_id, snapshot=outcome.snapshot_id)
                elif outcome.action == "failed" and self.ending.get(outcome.change_id) != outcome.error:
                    self.ending[outcome.change_id] = outcome.error or ""
                    log("warning", "offer_end_failed", change=outcome.change_id, error=outcome.error)

        async def prepaid_codes() -> None:
            for expired in await engine.expire_prepaid_codes():
                log("info", "prepaid_code_expired", prepaid=expired.code_id, market=expired.market,
                    valid_until=expired.valid_until)

        async def price_changes() -> None:
            for settled in await engine.settle_migrations():
                if settled.error is not None:
                    if self.settling.get(settled.price_change) != settled.error:
                        self.settling[settled.price_change] = settled.error
                        log("warning", "price_change_settle_failed", price_change=settled.price_change,
                            change=settled.change, subscription=settled.subscription, error=settled.error)
                    continue
                self.settling.pop(settled.price_change, None)
                log("info", "price_change_settled", **{**settled.dates, "price_change": settled.price_change,
                                                       "change": settled.change, "subscription": settled.subscription,
                                                       "state": settled.state, "effect": settled.effect})

        async def outbox() -> None:
            for delivery in await engine.deliver_outbox():
                if delivery.delivered:
                    log("info", "outbox_delivered", **{**delivery.facts, "message": delivery.message_id, "topic": delivery.topic,
                                                       "consumer": delivery.consumer, "attempts": delivery.attempts})
                else:
                    log("warning", "outbox_delivery_failed", message=delivery.message_id, topic=delivery.topic,
                        consumer=delivery.consumer, attempts=delivery.attempts, error=delivery.error)

        async def idempotency_keys() -> None:
            now = engine.clock.now()
            if self.pruned_at is None or now - self.pruned_at >= PRUNE_EVERY:
                pruned = await engine.prune_idempotency_keys()
                self.pruned_at = now
                if pruned:
                    log("info", "idempotency_keys_pruned", keys=pruned)

        jobs: list[tuple[str, Callable[[], Awaitable[None]]]] = [
            ("launches", launches), ("offers", offers), ("prepaid codes", prepaid_codes),
            ("price changes", price_changes), ("outbox", outbox), ("idempotency keys", idempotency_keys)]
        for name, job in jobs:
            try:
                await job()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # the next pass tries again; a launch resumes where it stopped
                text = f"{type(error).__name__}: {error}"
                if self.failing.get(name) != text:
                    log("warning", "jobs_pass_failed", job=name, error=text)
                self.failing[name] = text
                if isinstance(error, Unavailable):
                    break  # the database: the jobs after this one need it as well
                continue
            if name in self.failing:
                log("info", "jobs_working_again", job=name, after=self.failing.pop(name))
        return logged
