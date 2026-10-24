"""The first month's payment (business book §4.5): asked for after the
confirmation commits, settled by the payment provider's events.

ConfirmQuote writes the subscription, the payment (pending) and an outbox
message in one transaction (subscribers.py). The relay hands the message to
Charges, which asks the provider for the charge outside any transaction, with
the payment's identifier as the idempotency key, and takes in the events the
provider answers with. ProviderEvents.receive is the one door the events come
through, as a webhook would be: an event counts once, by its own identifier,
and an event that arrives after a later one, out of order, is kept and moves
nothing.

A payment settles once: from pending to succeeded, when the receipt is
issued, or to failed, when the paid subscription ends at the end of that day
and the listener is back on the free plan the day after. The simulated
provider never declines; a real one can.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta

from commerce.domain import billing
from commerce.domain.localtime import format_instant
from commerce.domain.money import Money
from commerce.engine import contract, outbox, records, reference
from commerce.engine.call import Clock
from commerce.engine.database import Connection, Database, utc_text
from commerce.engine.providers import FAILED, PENDING, SUCCEEDED, Charge, PaymentProvider, ProviderEvent
from commerce.v1 import subscriptions_pb2

ACTOR, ROLE = "payments", "system"
TOPIC = "payment.charge"
RECEIPT_NOTE = ("Demonstration receipt from a simulated payment provider: no payment was taken, no money moved, "
                "and no subscription contract was made.")
# How far each event moves a payment: an event moves it only forward.
RANK = {"pending": 0, PENDING: 0, "succeeded": 1, SUCCEEDED: 1, "failed": 1, FAILED: 1}
STATES = {"pending": subscriptions_pb2.PAYMENT_STATE_PENDING, "succeeded": subscriptions_pb2.PAYMENT_STATE_SUCCEEDED,
          "failed": subscriptions_pb2.PAYMENT_STATE_FAILED}


def new_payment_id() -> str:
    return f"p_{secrets.token_hex(16)}"


async def request(tx: Connection, *, payment_id: str, quote_id: str, subscription_id: int, subscriber_id: int, price: Money,
                  description: str, provider: str, now: datetime, request_id: str) -> int:
    """The payment, pending, and the outbox message that asks for it, in the confirmation's transaction."""
    await tx.execute(
        "insert into payment (id, quote_id, subscription_id, subscriber_id, amount_minor, currency, provider, requested_at, "
        "request_id) values ($1, $2, $3, $4, $5, $6, $7, $8::text::timestamptz, $9)",
        payment_id, quote_id, subscription_id, subscriber_id, price.amount, price.currency, provider, format_instant(now),
        request_id)
    return await outbox.write(tx, topic=TOPIC, key=payment_id, now=now, request_id=request_id,
                              payload={"payment": payment_id, "description": description})


async def of_subscription(tx: Connection, subscription_id: int) -> subscriptions_pb2.Payment | None:
    """The payment of a subscription confirmed from a quote, with its receipt once it succeeded."""
    row = await tx.fetchrow(
        f"select p.id, p.state, p.amount_minor, p.currency, p.provider, {utc_text('p.requested_at')} as requested_at, "
        f"{utc_text('p.settled_at')} as settled_at, p.failure_reason, r.id as receipt_id, r.amount_minor as receipt_amount, "
        f"{utc_text('r.issued_at')} as issued_at, r.provider_reference, r.note "
        "from payment p left join receipt r on r.subscription_id = p.subscription_id where p.subscription_id = $1",
        subscription_id)
    if row is None:
        return None
    currency = row["currency"].strip()
    payment = subscriptions_pb2.Payment(
        payment_id=row["id"], state=STATES[row["state"]], amount=contract.money(Money(row["amount_minor"], currency)),
        provider=row["provider"], requested_at=records.iso(row["requested_at"]), settled_at=records.iso(row["settled_at"]),
        failure_reason=row["failure_reason"] or "")
    if row["receipt_id"] is not None:
        payment.receipt.CopyFrom(subscriptions_pb2.Receipt(
            receipt_id=row["receipt_id"], amount=contract.money(Money(row["receipt_amount"], currency)),
            issued_at=records.iso(row["issued_at"]), provider=row["provider"], provider_reference=row["provider_reference"],
            demonstration=True, note=row["note"]))
    return payment


class ProviderEvents:
    """Takes in the provider's events, each once."""

    def __init__(self, db: Database, clock: Clock) -> None:
        self.db = db
        self.clock = clock

    async def receive(self, event: ProviderEvent) -> str:
        """applied: it moved the payment; noted: kept, with nothing to move (the
        provider says the charge is pending); late: the payment had moved past
        it; again: it had arrived before, and only its arrivals grow."""
        now = self.clock.now()
        async with self.db.transaction() as tx:
            payment = await tx.fetchrow(
                "select id, quote_id, subscription_id, subscriber_id, amount_minor, currency, state, request_id "
                "from payment where id = $1 for update", event.payment_id)
            if payment is None:
                raise LookupError(f"the provider's event {event.event_id} names no payment of this platform")
            moves = payment["state"] == "pending" and RANK[event.type] > RANK[payment["state"]]
            fresh = await tx.fetchval(
                "insert into payment_event (provider, event_id, payment_id, type, occurred_at, received_at, applied) "
                "values ($1, $2, $3, $4, $5::text::timestamptz, $6::text::timestamptz, $7) "
                "on conflict (provider, event_id) do nothing returning 1",
                event.provider, event.event_id, event.payment_id, event.type, format_instant(event.occurred_at),
                format_instant(now), moves)
            if fresh is None:
                await tx.execute("update payment_event set arrivals = arrivals + 1 where provider = $1 and event_id = $2",
                                 event.provider, event.event_id)
                return "again"
            if not moves:
                return "noted" if payment["state"] == "pending" else "late"
            if event.type == SUCCEEDED:
                await self._succeeded(tx, payment, event, now)
            else:
                await self._failed(tx, payment, event, now)
            return "applied"

    async def _succeeded(self, tx: Connection, payment, event: ProviderEvent, now: datetime) -> None:
        receipt_id = f"r_{secrets.token_hex(16)}"
        currency = payment["currency"].strip()
        await tx.execute(
            "insert into receipt (id, subscription_id, quote_id, subscriber_id, amount_minor, currency, issued_at, provider, "
            "provider_reference, note) values ($1, $2, $3, $4, $5, $6, $7::text::timestamptz, $8, $9, $10)",
            receipt_id, payment["subscription_id"], payment["quote_id"], payment["subscriber_id"], payment["amount_minor"],
            currency, format_instant(now), event.provider, event.reference, RECEIPT_NOTE)
        await tx.execute(
            "update payment set state = 'succeeded', settled_at = $2::text::timestamptz, provider_reference = $3 where id = $1",
            payment["id"], format_instant(now), event.reference)
        await records.record(tx, at=now, actor=ACTOR, role=ROLE, action="payment.succeeded", subject=f"payment:{payment['id']}",
                             request_id=payment["request_id"], body={
                                 "payment": payment["id"], "subscription": payment["subscription_id"],
                                 "subscriber": payment["subscriber_id"], "amount": payment["amount_minor"], "currency": currency,
                                 "provider": event.provider, "provider_reference": event.reference, "receipt": receipt_id,
                                 "event": event.event_id})

    async def _failed(self, tx: Connection, payment, event: ProviderEvent, now: datetime) -> None:
        reason = event.failure_reason or "The payment provider declined the charge."
        await tx.execute(
            "update payment set state = 'failed', settled_at = $2::text::timestamptz, provider_reference = $3, "
            "failure_reason = $4 where id = $1", payment["id"], format_instant(now), event.reference, reason[:400])
        subscription = await tx.fetchrow(
            "select id, subscriber_id, market from subscription where id = $1 for update",
            payment["subscription_id"])
        market = (await reference.load(tx, now)).market(subscription["market"].strip())
        back_on_free = market.today(now) + timedelta(days=1)
        await tx.execute("update subscription set ended_on = $2::text::date where id = $1", subscription["id"],
                         back_on_free.isoformat())
        free = await tx.fetchval(
            "insert into subscription (id, subscriber_id, market, currency, plan_id, paid, price_minor, started_on, billing_day) "
            "values (nextval('subscription_id_seq'), $1, $2, $3, 'free', false, 0, $4::text::date, $5) returning id",
            subscription["subscriber_id"], market.code, market.currency, back_on_free.isoformat(),
            billing.billing_day_for(back_on_free))
        await records.record(tx, at=now, actor=ACTOR, role=ROLE, action="payment.failed", subject=f"payment:{payment['id']}",
                             request_id=payment["request_id"], body={
                                 "payment": payment["id"], "subscription": subscription["id"], "subscriber": subscription["subscriber_id"],
                                 "provider": event.provider, "provider_reference": event.reference, "reason": reason,
                                 "event": event.event_id, "ends_on": back_on_free.isoformat(), "free_subscription": free})


class Charges:
    """The consumer of "payment.charge": asks the provider, then takes in its events."""

    name = "payments"
    topic = TOPIC

    def __init__(self, db: Database, provider: PaymentProvider, events: ProviderEvents) -> None:
        self.db = db
        self.provider = provider
        self.events = events

    async def deliver(self, message: outbox.Message) -> dict[str, object]:
        payment_id = message.payload["payment"]
        async with self.db.transaction(readonly=True) as tx:
            row = await tx.fetchrow("select amount_minor, currency, state from payment where id = $1", payment_id)
        if row is None:
            raise LookupError(f"outbox message {message.id} names no payment ({payment_id})")
        if row["state"] != "pending":
            return {"payment": payment_id, "state": row["state"]}  # settled meanwhile, by an event that came on its own
        result = await self.provider.charge(Charge(payment_id, Money(row["amount_minor"], row["currency"].strip()),
                                                   message.payload["description"], idempotency_key=payment_id))
        taken = [await self.events.receive(event) for event in result.events]
        return {"payment": payment_id, "reference": result.reference, "events": len(taken),
                "applied": sum(1 for outcome in taken if outcome == "applied")}
