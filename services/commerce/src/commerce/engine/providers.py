"""The two outside providers the subscriber's side needs, behind small
interfaces: a payment provider and a student verifier (business book §4.5,
§10.1, §15). The engine knows only these interfaces; a real provider would
plug in here. The implementations below are simulated, and say so in every
answer: no money moves, and no student record is checked.

A charge is an outside effect, so the engine never asks for one inside a
database transaction: the confirmation writes the payment and an outbox
message in its transaction, and the outbox asks the provider after the commit
(engine/payments.py). The provider answers with the events it sends about the
charge, as a real provider sends them to a webhook; the engine takes each in
once, by the event's own identifier, whatever the order they arrive in. The
idempotency key, one per payment, makes a charge asked for twice a single
charge, with the same events.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Protocol

from commerce.domain.money import Money
from commerce.engine.call import Clock

PENDING, SUCCEEDED, FAILED = "charge.pending", "charge.succeeded", "charge.failed"


@dataclass(frozen=True)
class Charge:
    payment_id: str
    amount: Money
    description: str
    idempotency_key: str  # the provider's own: the same key never charges twice


@dataclass(frozen=True)
class ProviderEvent:
    """What the provider says about a charge, under the event's own identifier."""

    provider: str
    event_id: str
    type: str  # charge.pending, charge.succeeded, charge.failed
    payment_id: str  # the engine's identifier, which the charge was asked with
    reference: str  # the provider's identifier of the charge
    occurred_at: datetime
    failure_reason: str = ""


@dataclass(frozen=True)
class ChargeResult:
    provider: str
    reference: str
    events: tuple[ProviderEvent, ...] = field(default=())


class PaymentProvider(Protocol):
    name: str

    async def charge(self, charge: Charge) -> ChargeResult: ...


@dataclass(frozen=True)
class StudentClaim:
    subscriber_id: int
    market: str
    on: date
    # What the demo says about this listener; a real verifier checks documents instead.
    demo_student: bool | None


@dataclass(frozen=True)
class VerifierAnswer:
    confirmed: bool
    provider: str
    reference: str
    reason: str = ""


class StudentVerifier(Protocol):
    name: str

    async def verify(self, claim: StudentClaim) -> VerifierAnswer: ...


def _digest(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:24]


def _reference(prefix: str, key: str) -> str:
    return f"{prefix}-{_digest(key)}"


class SimulatedPayments:
    """Takes no money. Every charge succeeds: the provider says it is pending,
    then that it succeeded. The reference and the events' identifiers are made
    from the idempotency key, so a charge asked for again gives the same
    reference and the same events, as a real provider's would."""

    name = "simulated"

    def __init__(self, clock: Clock) -> None:
        self.clock = clock

    async def charge(self, charge: Charge) -> ChargeResult:
        reference = _reference("sim-pay", charge.idempotency_key)
        now = self.clock.now()
        events = tuple(ProviderEvent(self.name, f"evt_{_digest(f'{charge.idempotency_key}/{kind}')}", kind, charge.payment_id,
                                     reference, now) for kind in (PENDING, SUCCEEDED))
        return ChargeResult(self.name, reference, events)


class SimulatedStudentVerifier:
    """Checks no student record. It confirms every listener except those the
    demo marks as not being students."""

    name = "simulated"

    async def verify(self, claim: StudentClaim) -> VerifierAnswer:
        reference = _reference("sim-student", f"{claim.subscriber_id}/{claim.on.isoformat()}")
        if claim.demo_student is False:
            return VerifierAnswer(False, self.name, reference,
                                  "The simulated provider found no student record for this listener.")
        return VerifierAnswer(True, self.name, reference)
