"""The subscriber's side (business book §4.3, §4.5, §6.1, §10, §14.1, §14.5):
the demo's listeners, a student verification, a quote confirmed into a
subscription at exactly its price, its payment asked for through the outbox
(test_payments.py follows the provider's events), and the account, with every
refusal."""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime

import pytest

from commerce.engine import payments
from commerce.engine.errors import FailedPrecondition, InvalidArgument, NotFound
from commerce.engine.providers import FAILED, ChargeResult, ProviderEvent
from commerce.invariants import check
from commerce.v1 import catalog_pb2, changes_pb2, common_pb2, overview_pb2, quotes_pb2, subscriptions_pb2
from engine_support import FINANCE, LEAD, MARKETING, ON_CALL, PUBLIC, family_rise, new_key, scheduled, student_autumn
from helpers import add_subscription

REFUSAL = common_pb2.RefusalCode


def at(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


async def verify(world, subscriber: int):
    return await world.call("VerifyStudent", subscriptions_pb2.VerifyStudentRequest(subscriber_id=subscriber), PUBLIC)


async def account(world, subscriber: int) -> subscriptions_pb2.Account:
    return (await world.call("GetAccount", subscriptions_pb2.GetAccountRequest(subscriber_id=subscriber), PUBLIC)).account


async def quote(world, **fields) -> quotes_pb2.Quote:
    response = await world.call("GetQuote", quotes_pb2.GetQuoteRequest(**fields), PUBLIC)
    assert response.WhichOneof("outcome") == "quote", response
    return response.quote


async def confirm(world, quote_id: str, subscriber: int, *, key: str | None = None):
    return await world.call("ConfirmQuote", subscriptions_pb2.ConfirmQuoteRequest(quote_id=quote_id, subscriber_id=subscriber),
                            PUBLIC, key=key)


async def autumn_on_sale(world, content=None) -> int:
    """The Student Autumn Pass, live from 09:00 in Rome on 26 October; the clock left at that minute."""
    change = await scheduled(world, content or student_autumn(), MARKETING, FINANCE)
    world.clock.at = at(2026, 10, 26, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated"
    world.clock.at = at(2026, 10, 26, 8, 0)
    return change.id


# -- ListDemoListeners --------------------------------------------------------------

async def test_the_demo_s_listeners_come_in_order_and_say_they_are_simulated(world):
    listeners = (await world.call("ListDemoListeners", subscriptions_pb2.ListDemoListenersRequest(), PUBLIC)).listeners
    assert [(l.subscriber_id, l.market, l.plan, l.student_verified) for l in listeners] == [
        (101, "IT", "free", True), (102, "IT", "free", False), (104, "IT", "free", True), (401, "FR", "free", False)]
    assert all(l.label.startswith("Simulated listener.") and l.title for l in listeners)


# -- VerifyStudent -------------------------------------------------------------------

async def test_the_simulated_provider_verifies_a_student_for_twelve_months(world):
    response = await verify(world, 102)
    v = response.verification
    assert (v.verified_on, v.valid_until, v.provider, v.valid) == ("2026-10-24", "2027-10-24", "simulated", True)
    assert v.reference.startswith("sim-student-")
    [event] = await world.events("student.verified")
    assert (event["actor"], event["actor_role"], event["subject"]) == ("subscriber-102", "subscriber", "subscriber:102")
    assert event["request_id"].startswith("req-") and '"valid_until": "2027-10-24"' in event["body"]
    assert (await quote(world, plan="student", market="IT", subscriber_id=102)).price.amount_minor == 579


async def test_a_verification_still_valid_comes_back_as_it_is(world):
    v = (await verify(world, 101)).verification
    assert (v.verified_on, v.valid_until, v.reference, v.valid) == ("2026-09-01", "2027-09-01", "", True)
    assert await world.events("student.verified") == []
    assert await world.owner.fetchval("select count(*) from student_verification where subscriber_id = 101") == 1


async def test_an_expired_verification_is_renewed(world):
    v = (await verify(world, 105)).verification  # 105's verification ended on 1 September
    assert (v.verified_on, v.valid) == ("2026-10-24", True)


async def test_the_simulated_provider_finds_no_student_record_for_a_listener_who_is_not_one(world):
    response = await verify(world, 401)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE and "simulated provider" in response.refusal.reason
    assert await world.owner.fetchval("select count(*) from student_verification where subscriber_id = 401") == 0
    assert await world.events("student.verified") == []


async def test_a_verification_falls_on_the_market_s_day(world):
    world.clock.at = at(2026, 10, 24, 22, 30)  # 00:30 on the 25th in Rome
    assert (await verify(world, 102)).verification.verified_on == "2026-10-25"


async def test_verification_errors(world):
    with pytest.raises(NotFound):
        await verify(world, 9_999)
    with pytest.raises(InvalidArgument):
        await verify(world, 0)


# -- ConfirmQuote --------------------------------------------------------------------

async def test_the_student_subscribes_at_the_quoted_price_and_sees_from_when_the_full_price_applies(world):
    offer = await autumn_on_sale(world)
    q = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=101)
    done = (await confirm(world, q.quote_id, 101)).confirmation
    s, p = done.subscription, done.payment
    assert (s.plan, s.market, s.paid, s.price.amount_minor, s.started_on, s.billing_day) == (
        "student", "IT", True, 299, "2026-10-26", 26)
    assert (s.offer_id, s.offer_title, s.offer_months, s.offer_months_left) == (offer, "Student Autumn Pass", 3, 3)
    assert (s.full_price_from, s.full_price.amount_minor) == ("2027-01-26", 579)
    assert (s.next_billing_on, s.next_charge.amount_minor) == ("2026-11-26", 299)
    # The charge comes after the confirmation commits: the payment is pending, and no receipt yet.
    assert (p.state, p.amount.amount_minor, p.provider, p.settled_at) == (subscriptions_pb2.PAYMENT_STATE_PENDING, 299,
                                                                          "simulated", "")
    assert not done.HasField("receipt") and not p.HasField("receipt")
    history = await world.owner.fetch("select plan_id, started_on, ended_on from subscription where subscriber_id = 101 "
                                      "order by started_on")
    assert [(h["plan_id"], h["started_on"], h["ended_on"]) for h in history] == [
        ("free", date(2026, 1, 10), date(2026, 10, 26)), ("student", date(2026, 10, 26), None)]
    [event] = await world.events("subscription.confirmed")
    assert (event["actor"], event["actor_role"], event["subject"]) == ("subscriber-101", "subscriber", f"subscription:{s.subscription_id}")
    assert f'"quote": "{q.quote_id}"' in event["body"] and '"full_price_from": "2027-01-26"' in event["body"]
    assert '"payment_state": "pending"' in event["body"]
    [delivery] = await world.engine.deliver_outbox()
    assert (delivery.topic, delivery.delivered, delivery.facts["applied"]) == ("payment.charge", True, 1)
    mine = await account(world, 101)
    assert mine.subscription == s and mine.student_verification == subscriptions_pb2.StudentVerification(
        verified_on="2026-09-01", valid_until="2027-09-01", provider="simulated", valid=True)
    assert (mine.payment.payment_id, mine.payment.state) == (p.payment_id, subscriptions_pb2.PAYMENT_STATE_SUCCEEDED)
    r = mine.payment.receipt
    assert (r.amount.amount_minor, r.provider, r.demonstration) == (299, "simulated", True)
    assert r.provider_reference.startswith("sim-pay-") and "no payment was taken" in r.note
    # The confirmation's request id follows the charge to the event that settled it.
    [settled] = await world.events("payment.succeeded")
    assert (settled["actor"], settled["actor_role"], settled["request_id"]) == ("payments", "system", event["request_id"])
    report = await check(world.owner)
    assert report["broken"] == 0, [i for i in report["invariants"] if i["violations"]]


async def test_the_account_follows_the_months_of_the_offer(world):
    offer = await autumn_on_sale(world)
    q = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=101)
    await confirm(world, q.quote_id, 101)
    world.clock.at = at(2026, 12, 26, 12, 0)
    s = (await account(world, 101)).subscription
    assert (s.offer_months_left, s.price.amount_minor, s.next_billing_on, s.next_charge.amount_minor) == (1, 299, "2027-01-26", 579)
    world.clock.at = at(2027, 1, 26, 12, 0)
    s = (await account(world, 101)).subscription
    assert (s.offer_months_left, s.price.amount_minor, s.next_billing_on, s.next_charge.amount_minor) == (0, 579, "2027-02-26", 579)


async def test_the_full_price_is_the_list_price_in_force_then(world):
    offer = await autumn_on_sale(world)
    await world.owner.execute("update list_price set valid = tsrange(lower(valid), '2027-01-01') "
                              "where plan_id = 'student' and market = 'IT'")
    await world.owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                              "values ('student', 'IT', 'EUR', 599, tsrange('2027-01-01', null))")
    q = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=101)
    s = (await confirm(world, q.quote_id, 101)).confirmation.subscription
    assert (s.price.amount_minor, s.full_price_from, s.full_price.amount_minor) == (299, "2027-01-26", 599)


async def test_a_list_price_subscription_falls_on_the_market_s_day(world):
    world.clock.at = at(2026, 10, 24, 22, 30)  # 00:30 on Sunday the 25th in Paris, the night the clocks go back
    q = await quote(world, plan="individual", market="FR", subscriber_id=401)
    s = (await confirm(world, q.quote_id, 401)).confirmation.subscription
    assert (s.price.amount_minor, s.started_on, s.billing_day, s.offer_id, s.full_price_from) == (1099, "2026-10-25", 25, 0, "")
    assert (s.next_billing_on, s.next_charge.amount_minor) == ("2026-11-25", 1099)


async def test_the_same_key_confirms_once(world):
    offer = await autumn_on_sale(world)
    q = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=101)
    key = new_key()
    first = await confirm(world, q.quote_id, 101, key=key)
    again = await confirm(world, q.quote_id, 101, key=key)
    assert again == first
    assert await world.owner.fetchval("select count(*) from payment") == 1
    assert await world.owner.fetchval("select count(*) from outbox_message where topic = 'payment.charge'") == 1


async def test_an_expired_quote_is_refused(world):
    q = await quote(world, plan="individual", market="FR", subscriber_id=401)
    world.clock.advance(minutes=30)
    response = await confirm(world, q.quote_id, 401)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED


async def test_a_quote_names_its_listener(world):
    offer = await autumn_on_sale(world)
    q = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=101)
    with pytest.raises(NotFound):
        await confirm(world, q.quote_id, 102)
    with pytest.raises(NotFound):
        await confirm(world, "q_" + "0" * 32, 101)
    with pytest.raises(InvalidArgument):
        await confirm(world, "not-a-quote", 101)
    with pytest.raises(InvalidArgument):
        await confirm(world, q.quote_id, 0)


async def test_a_listener_already_paying_is_not_subscribed_twice(world):
    q = await quote(world, plan="individual", market="IT", subscriber_id=103)
    response = await confirm(world, q.quote_id, 103)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_ALREADY_SUBSCRIBED and response.refusal.facts["plan"] == "student"


async def test_an_offer_taken_off_sale_after_the_quote_is_refused(world):
    offer = await autumn_on_sale(world)
    q = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=101)
    await world.call("SuspendChange", changes_pb2.SuspendChangeRequest(change_id=offer, reason="Wrong page."), ON_CALL)
    response = await confirm(world, q.quote_id, 101)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED


async def test_eligibility_is_checked_again_at_confirmation(world):
    offer = await autumn_on_sale(world)
    anonymous = await quote(world, plan="student", market="IT", offer_id=offer)
    refused = await confirm(world, anonymous.quote_id, 102)  # never paid, but not verified yet
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE and refused.refusal.facts["check"] == "student"
    paid_before = await confirm(world, anonymous.quote_id, 104)
    assert paid_before.refusal.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE and "never had a paid plan" in paid_before.refusal.reason
    elsewhere = await confirm(world, anonymous.quote_id, 401)
    assert elsewhere.refusal.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE and elsewhere.refusal.facts["market"] == "FR"
    await verify(world, 102)
    assert (await confirm(world, anonymous.quote_id, 102)).confirmation.subscription.price.amount_minor == 299


async def test_one_offer_of_a_group_per_listener(world):
    autumn = await autumn_on_sale(world)
    q = await quote(world, plan="student", market="IT", offer_id=autumn, subscriber_id=101)
    await confirm(world, q.quote_id, 101)
    # The pass ends in November and 101 goes back to Free (by hand: cancellations are not modelled yet).
    await world.owner.execute("update subscription set ended_on = '2026-11-26' where subscriber_id = 101 and ended_on is null")
    await add_subscription(world.owner, 101, "IT", "free", 0, "2026-11-26", subscription=90001, billing_day=26)
    # For verified students on Free, which 101 is again: only the group keeps them out.
    winter = await scheduled(world, student_autumn(
        title="Student Winter Pass",
        audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_FREE_LISTENERS, needs_student_check=True),
        periods=[changes_pb2.OfferPeriod(market="IT", starts_local="2026-12-01T09:00", ends_local="2027-01-01T00:00")]),
        MARKETING, FINANCE)
    world.clock.at = at(2026, 12, 1, 7, 59, 30)
    await world.engine.activate_due()
    world.clock.at = at(2026, 12, 1, 8, 0)
    q = await quote(world, plan="student", market="IT", offer_id=winter.id, subscriber_id=101)
    response = await confirm(world, q.quote_id, 101)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_NOT_COMBINABLE
    assert response.refusal.facts == {"group": "student-offers", "taken": "Student Autumn Pass"}


async def test_an_offer_stops_at_its_cap(world):
    offer = await autumn_on_sale(world, student_autumn(redemption_cap=1))
    await verify(world, 102)
    first = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=101)
    second = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=102)
    await confirm(world, first.quote_id, 101)
    response = await confirm(world, second.quote_id, 102)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_CAP_REACHED and response.refusal.facts["cap"] == "1"


async def test_the_last_place_goes_to_one_listener_when_two_confirm_at_once(world):
    offer = await autumn_on_sale(world, student_autumn(redemption_cap=1))
    await verify(world, 102)
    first = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=101)
    second = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=102)
    one, two = await asyncio.gather(confirm(world, first.quote_id, 101), confirm(world, second.quote_id, 102))
    outcomes = sorted([one.WhichOneof("outcome"), two.WhichOneof("outcome")])
    assert outcomes == ["confirmation", "refusal"]
    assert await world.owner.fetchval("select count(*) from subscription where offer_change_id = $1", offer) == 1


async def test_two_confirmations_of_one_listener_at_once_subscribe_once(world):
    first = await quote(world, plan="individual", market="FR", subscriber_id=401)
    second = await quote(world, plan="duo", market="FR", subscriber_id=401)
    one, two = await asyncio.gather(confirm(world, first.quote_id, 401), confirm(world, second.quote_id, 401))
    refused = one if one.WhichOneof("outcome") == "refusal" else two
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_ALREADY_SUBSCRIBED
    assert await world.owner.fetchval("select count(*) from subscription where subscriber_id = 401 and paid") == 1


async def test_a_declined_payment_ends_the_paid_plan_at_the_end_of_the_day(world, monkeypatch):
    async def decline(charge):
        event = ProviderEvent("simulated", "evt_declined_0001", FAILED, charge.payment_id, "sim-pay-declined",
                              world.clock.now(), "The card was declined.")
        return ChargeResult("simulated", "sim-pay-declined", (event,))

    monkeypatch.setattr(world.engine.payments, "charge", decline)
    q = await quote(world, plan="individual", market="FR", subscriber_id=401)
    confirmed = (await confirm(world, q.quote_id, 401)).confirmation
    assert confirmed.payment.state == subscriptions_pb2.PAYMENT_STATE_PENDING
    await world.engine.deliver_outbox()
    today = await account(world, 401)
    assert (today.subscription.plan, today.payment.state, today.payment.failure_reason) == (
        "individual", subscriptions_pb2.PAYMENT_STATE_FAILED, "The card was declined.")
    assert not today.payment.HasField("receipt")
    history = await world.owner.fetch("select plan_id, started_on, ended_on from subscription where subscriber_id = 401 "
                                      "order by started_on")
    assert [(h["plan_id"], h["started_on"], h["ended_on"]) for h in history] == [
        ("free", date(2026, 1, 10), date(2026, 10, 24)), ("individual", date(2026, 10, 24), date(2026, 10, 25)),
        ("free", date(2026, 10, 25), None)]
    assert await world.owner.fetchval("select count(*) from receipt") == 0
    [failed] = await world.events("payment.failed")
    [confirmation] = await world.events("subscription.confirmed")
    assert failed["request_id"] == confirmation["request_id"]
    world.clock.advance(days=1)
    tomorrow = await account(world, 401)
    assert (tomorrow.subscription.plan, tomorrow.HasField("payment")) == ("free", False)


async def test_a_free_plan_that_started_today_cannot_end_today(world):
    await world.owner.execute("insert into subscriber (id, market, joined_on) values (402, 'FR', '2026-10-24')")
    await add_subscription(world.owner, 402, "FR", "free", 0, "2026-10-24", subscription=90002, billing_day=24)
    q = await quote(world, plan="individual", market="FR", subscriber_id=402)
    with pytest.raises(FailedPrecondition):
        await confirm(world, q.quote_id, 402)


# -- GetAccount ----------------------------------------------------------------------

async def test_a_free_listener_s_account(world):
    a = await account(world, 102)
    s = a.subscription
    assert (a.market, s.plan, s.paid, s.price.amount_minor, s.billing_day, s.next_billing_on) == ("IT", "free", False, 0, 0, "")
    assert not a.HasField("student_verification")
    paid = (await account(world, 106)).subscription  # Individual since March, billing on the 10th
    assert (paid.plan, paid.price.amount_minor, paid.next_billing_on, paid.next_charge.amount_minor) == (
        "individual", 1049, "2026-11-10", 1049)
    expired = (await account(world, 105)).student_verification
    assert (expired.valid_until, expired.valid) == ("2026-09-01", False)


async def test_account_errors(world):
    with pytest.raises(NotFound):
        await account(world, 9_999)
    with pytest.raises(InvalidArgument):
        await account(world, 0)


async def test_a_second_confirmation_waits_for_the_first_and_reads_what_it_wrote(world, monkeypatch):
    first = await quote(world, plan="individual", market="FR", subscriber_id=401)
    second = await quote(world, plan="duo", market="FR", subscriber_id=401)
    release = asyncio.Event()
    asking = payments.request

    async def held(tx, **fields):
        message = await asking(tx, **fields)
        await release.wait()  # the first confirmation keeps its transaction, and its locks, open
        return message

    monkeypatch.setattr(payments, "request", held)
    one = asyncio.create_task(confirm(world, first.quote_id, 401))
    await asyncio.sleep(0.3)
    monkeypatch.setattr(payments, "request", asking)
    two = asyncio.create_task(confirm(world, second.quote_id, 401))
    await asyncio.sleep(0.3)  # the second is waiting for the first
    release.set()
    assert (await one).WhichOneof("outcome") == "confirmation"
    assert (await two).refusal.code == REFUSAL.REFUSAL_CODE_ALREADY_SUBSCRIBED


async def test_a_confirmation_never_takes_an_offer_suspended_before_it(world):
    # Two engines whose clocks differ a little: the suspension is published at 08:01, while the clock of the engine that
    # confirms still says 08:00:30. The offer's state, read under its lock, decides, not the snapshot live at an instant.
    offer = await autumn_on_sale(world)
    q = await quote(world, plan="student", market="IT", offer_id=offer, subscriber_id=101)
    world.clock.at = at(2026, 10, 26, 8, 1)
    suspended = await world.call("SuspendChange", changes_pb2.SuspendChangeRequest(
        change_id=offer, reason="The page shows the wrong price."), ON_CALL)
    assert suspended.change.state == changes_pb2.CHANGE_STATE_SUSPENDED
    world.clock.at = at(2026, 10, 26, 8, 0, 30)
    response = await confirm(world, q.quote_id, 101)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED and "no longer on sale" in response.refusal.reason
    assert await world.owner.fetchval("select count(*) from subscription where subscriber_id = 101 and paid") == 0


async def test_a_confirmation_decides_at_the_time_it_holds_its_locks(world):
    q = await quote(world, plan="individual", market="FR", subscriber_id=401)  # at 08:42, valid for 30 minutes
    world.clock.at = at(2026, 10, 24, 9, 11, 50)
    free = await world.owner.fetchval("select id from subscription where subscriber_id = 401 and ended_on is null")
    holding = world.owner.transaction()
    await holding.start()
    await world.owner.execute("select id from subscription where id = $1 for update", free)
    confirming = asyncio.create_task(confirm(world, q.quote_id, 401))
    await asyncio.sleep(0.3)  # the confirmation waits for the listener's subscription
    world.clock.advance(seconds=20)  # 09:12:10: the quote expires meanwhile
    await holding.commit()
    response = await confirming
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED


async def test_a_confirmation_reads_the_list_price_in_force_at_that_moment(world):
    # Individual at 8,99 €, quoted at 08:55 in Rome. At 09:00 the list price drops from 10,49 € to 8,49 €: from then the
    # offer no longer costs less than the list price, the catalog stops selling it, and a confirmation at 09:05 is refused.
    content = student_autumn(title="Individual for less", plan="individual",
                             audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_NEVER_PAID),
                             prices=[changes_pb2.OfferPrice(market="IT", fixed=common_pb2.Money(amount_minor=899, currency="EUR"))])
    offer = await autumn_on_sale(world, content)
    world.clock.at = at(2026, 10, 27, 7, 55)
    q = await quote(world, plan="individual", market="IT", offer_id=offer, subscriber_id=101)
    assert (q.price.amount_minor, q.list_price.amount_minor) == (899, 1_049)
    await world.owner.execute("update list_price set valid = tsrange(lower(valid), '2026-10-27 09:00') "
                              "where plan_id = 'individual' and market = 'IT'")
    await world.owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                              "values ('individual', 'IT', 'EUR', 849, tsrange('2026-10-27 09:00', null))")
    world.clock.at = at(2026, 10, 27, 8, 5)
    on_sale = await world.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT"), PUBLIC)
    assert list(on_sale.offers) == []
    response = await confirm(world, q.quote_id, 101)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_QUOTE_EXPIRED and "no longer costs less" in response.refusal.reason


async def test_a_confirmation_outside_the_audience_names_the_market_as_it_is_written(world):
    offer = await autumn_on_sale(world)
    q = await quote(world, plan="student", market="IT", offer_id=offer)  # asked before signing in: no listener yet
    refused = (await confirm(world, q.quote_id, 104)).refusal  # 104 has had a paid plan
    assert refused.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE
    assert refused.reason == "The offer is for verified students in Italy who have never had a paid plan."
    assert refused.facts["subscriber"] == "104" and "#" not in refused.reason


async def test_the_account_and_the_home_read_the_price_from_the_subscription_s_history(world):
    # Family in Germany at 18,99 €, charged on the 10th; from 10 November its history says 20,99 €.
    rise = await world.call("CreateChange", changes_pb2.CreateChangeRequest(list_price=family_rise()), LEAD)
    family = await world.owner.fetchval("select id from subscription where subscriber_id = 203 and ended_on is null")
    await world.owner.execute("insert into subscription_price (subscription_id, from_on, price_minor, change_id) "
                              "values ($1, '2026-11-10', 2099, $2)", family, rise.change.id)
    now = (await account(world, 203)).subscription
    assert (now.price.amount_minor, now.next_billing_on, now.next_charge.amount_minor) == (1899, "2026-11-10", 2099)
    world.clock.at = at(2026, 11, 15, 12, 0)
    assert (await account(world, 203)).subscription.price.amount_minor == 2099
    home = await world.call("GetOverview", overview_pb2.GetOverviewRequest(), FINANCE)
    assert {r.market: r.revenue.amount_minor for r in home.monthly_revenue}["DE"] == 1764  # 20,99 € net of 19% VAT
