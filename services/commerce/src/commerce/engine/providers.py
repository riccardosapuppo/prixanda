"""The two outside providers the subscriber's side needs, behind small
interfaces: a payment provider and a student verifier (business book §10.1,
§15). The engine knows only these interfaces; a real provider would plug in
here. The implementations below are simulated, and say so in every answer:
no money moves, and no student record is checked.

With a real payment provider the charge is an outside effect, so the call
would move out of the database transaction behind the outbox of stage 6; its
idempotency key, one per quote, already makes a retry charge once.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date
from typing import Protocol

from commerce.domain.money import Money


@dataclass(frozen=True)
class Charge:
    amount: Money
    description: str
    idempotency_key: str  # the provider's own: the same key never charges twice


@dataclass(frozen=True)
class ChargeResult:
    succeeded: bool
    provider: str
    reference: str
    declined_reason: str = ""


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


def _reference(prefix: str, key: str) -> str:
    return f"{prefix}-{hashlib.sha256(key.encode()).hexdigest()[:24]}"


class SimulatedPayments:
    """Takes no money. Every charge succeeds, with a reference made from its
    idempotency key, so a retried charge gives the same reference."""

    name = "simulated"

    async def charge(self, charge: Charge) -> ChargeResult:
        return ChargeResult(True, self.name, _reference("sim-pay", charge.idempotency_key))


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
