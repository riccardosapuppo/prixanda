"""The outbox (business book §7.5, §4.5): a notice for the site or a charge for
the payment provider is written in the transaction of what it announces, and
delivered after it at least once; the site takes a notice once however often
it arrives, the provider charges once per payment, and its events count once
whatever their order."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from commerce.domain.money import Money
from commerce.engine import outbox
from commerce.engine.providers import Charge, ProviderEvent, SimulatedPayments
from commerce.v1 import changes_pb2, quotes_pb2, subscriptions_pb2
from engine_support import FINANCE, MARKETING, ON_CALL, PUBLIC, scheduled, student_autumn


def at(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


async def live_offer(world) -> int:
    change = await scheduled(world, student_autumn(), MARKETING, FINANCE)
    world.clock.at = at(2026, 10, 26, 7, 59, 30)
    await world.engine.run_launches()
    return change.id


async def waiting(world) -> list[outbox.Message]:
    async with world.engine.db.transaction(readonly=True) as tx:
        ids = [r["id"] for r in await tx.fetch("select id from outbox_message where delivered_at is null order by id")]
        return [await outbox.load(tx, message_id) for message_id in ids]


async def confirmed(world) -> subscriptions_pb2.Confirmation:
    """Listener 401 in France takes Individual at the list price, on 24 October."""
    quote = (await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="individual", market="FR", subscriber_id=401),
                              PUBLIC)).quote
    response = await world.call("ConfirmQuote", subscriptions_pb2.ConfirmQuoteRequest(quote_id=quote.quote_id,
                                                                                       subscriber_id=401), PUBLIC)
    return response.confirmation


async def test_a_suspension_tells_the_site_once_however_often_the_notice_arrives(world):
    change = await live_offer(world)
    world.clock.at = at(2026, 10, 27, 10, 0)
    await world.call("SuspendChange", changes_pb2.SuspendChangeRequest(change_id=change, reason="Wrong page."), ON_CALL)
    [notice] = await waiting(world)  # written with the publication, in its transaction
    live = await world.owner.fetchrow("select seq, snapshot_id from catalog_publication order by seq desc limit 1")
    assert (notice.topic, notice.key, notice.payload["snapshot"], notice.payload["publication"]) == (
        "catalog.published", f"publication:{live['seq']}", live["snapshot_id"], live["seq"])
    assert notice.payload["cause"] == {"suspended": change}
    [delivery] = await world.engine.deliver_outbox()
    assert (delivery.consumer, delivery.delivered, delivery.facts["arrivals"]) == ("site", True, 1)
    again = await world.engine.relay.deliver(notice)  # a delivery that came twice: the engine stopped before marking it
    assert again.facts["arrivals"] == 2
    rows = await world.owner.fetch("select snapshot_id, arrivals from site_notice where message_id = $1", notice.id)
    assert [(r["snapshot_id"], r["arrivals"]) for r in rows] == [(live["snapshot_id"], 2)]
    first = await world.owner.fetchval("select delivered_at from outbox_message where id = $1", notice.id)
    assert first == at(2026, 10, 27, 10, 0)  # marked once, by the first delivery


async def test_a_delivery_that_fails_waits_and_is_tried_again(world, monkeypatch):
    change = await live_offer(world)
    await world.call("SuspendChange", changes_pb2.SuspendChangeRequest(change_id=change, reason="Wrong page."), ON_CALL)
    inbox = world.engine.relay.consumer("catalog.published")
    original = inbox.deliver
    calls = {"n": 0}

    async def down_once(message):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("the site's inbox does not answer")
        return await original(message)

    monkeypatch.setattr(inbox, "deliver", down_once)
    [failed] = await world.engine.deliver_outbox()
    assert (failed.delivered, failed.attempts) == (False, 1) and "does not answer" in failed.error
    row = await world.owner.fetchrow("select available_at, last_error from outbox_message where id = $1", failed.message_id)
    assert row["available_at"] == world.clock.now() + timedelta(seconds=5) and "does not answer" in row["last_error"]
    assert await world.engine.deliver_outbox() == []  # not before its wait
    world.clock.advance(seconds=5)
    [delivered] = await world.engine.deliver_outbox()
    assert (delivered.delivered, delivered.attempts) == (True, 2)
    assert await world.owner.fetchval("select arrivals from site_notice where message_id = $1", delivered.message_id) == 1


def test_the_waits_grow_and_a_message_is_never_dropped():
    assert [outbox.wait_after(n).total_seconds() for n in range(1, 8)] == [5, 15, 45, 135, 300, 300, 300]


async def test_a_confirmation_asks_for_its_charge_after_it_commits(world):
    done = await confirmed(world)
    assert done.payment.state == subscriptions_pb2.PAYMENT_STATE_PENDING
    [charge] = await waiting(world)
    assert (charge.topic, charge.key, charge.payload["payment"]) == ("payment.charge", done.payment.payment_id,
                                                                     done.payment.payment_id)
    assert await world.owner.fetchval("select count(*) from receipt") == 0
    [delivery] = await world.engine.deliver_outbox()
    assert (delivery.consumer, delivery.facts["events"], delivery.facts["applied"]) == ("payments", 2, 1)
    assert await world.owner.fetchval("select state from payment") == "succeeded"
    assert await world.owner.fetchval("select count(*) from receipt") == 1


async def test_the_provider_s_events_count_once_however_often_and_in_whatever_order_they_arrive(world):
    done = await confirmed(world)
    payment = done.payment.payment_id
    result = await SimulatedPayments(world.clock).charge(Charge(payment, Money(1_099, "EUR"), "Individual, France",
                                                                idempotency_key=payment))
    pending, succeeded = result.events
    receive = world.engine.provider_events.receive
    # The success comes first, then the pending one, then each again.
    assert [await receive(e) for e in (succeeded, pending, succeeded, pending)] == ["applied", "late", "again", "again"]
    rows = await world.owner.fetch("select type, arrivals, applied from payment_event order by type")
    assert [(r["type"], r["arrivals"], r["applied"]) for r in rows] == [("charge.pending", 2, False),
                                                                        ("charge.succeeded", 2, True)]
    assert await world.owner.fetchval("select count(*) from receipt") == 1
    assert len(await world.events("payment.succeeded")) == 1
    # The outbox's own delivery comes after: the payment has settled, and the provider is not asked again.
    [delivery] = await world.engine.deliver_outbox()
    assert delivery.facts == {"payment": payment, "state": "succeeded"}
    account = (await world.call("GetAccount", subscriptions_pb2.GetAccountRequest(subscriber_id=401), PUBLIC)).account
    assert account.payment.state == subscriptions_pb2.PAYMENT_STATE_SUCCEEDED and account.payment.receipt.receipt_id


async def test_a_charge_asked_for_again_after_a_fault_charges_once(world, monkeypatch):
    done = await confirmed(world)
    asked: list[Charge] = []
    provider = world.engine.payments
    original = provider.charge

    async def counting(charge):
        asked.append(charge)
        return await original(charge)

    monkeypatch.setattr(provider, "charge", counting)
    events = world.engine.provider_events
    taking = events.receive

    async def lost_once(event):
        if len(asked) == 1:
            raise ConnectionError("the engine lost its database before it took the provider's answer in")
        return await taking(event)

    monkeypatch.setattr(events, "receive", lost_once)
    [failed] = await world.engine.deliver_outbox()
    assert not failed.delivered and await world.owner.fetchval("select state from payment") == "pending"
    world.clock.advance(seconds=5)
    [delivered] = await world.engine.deliver_outbox()
    assert delivered.delivered and delivered.facts["applied"] == 1
    assert [c.idempotency_key for c in asked] == [done.payment.payment_id] * 2  # asked twice, with one key
    assert await world.owner.fetchval("select count(distinct provider_reference) from payment") == 1
    assert await world.owner.fetchval("select count(*) from receipt") == 1


async def test_an_event_for_no_payment_of_the_platform_is_not_taken_in(world):
    stray = ProviderEvent("simulated", "evt_stray_000000000001", "charge.succeeded", "p_" + "0" * 32, "sim-pay-x",
                          world.clock.now())
    with pytest.raises(LookupError):
        await world.engine.provider_events.receive(stray)
    assert await world.owner.fetchval("select count(*) from payment_event") == 0
