"""Prepaid passes (business book §9, §14.4) against PostgreSQL: three months
of Individual paid in advance, €29.99 in Italy, sold as a single-use code
that can be given as a gift; it never renews, a later price does not touch
it, and finance sees the value sold and not yet earned.

The pass goes on sale on 1 November 2026 at midnight in Rome. Listener 101
buys codes; 102 is given one and activates it; 105 is another free listener
in Italy, 106 pays for Individual, 201 is a free listener in Germany."""

from __future__ import annotations

import io
import json
from datetime import UTC, datetime

import pytest

from commerce.engine import prepaid
from commerce.engine.errors import InvalidArgument, NotFound
from commerce.engine.providers import FAILED, ChargeResult, ProviderEvent
from commerce.server.app import Jobs
from commerce.server.logs import JsonLog
from commerce.v1 import (
    catalog_pb2, changes_pb2, common_pb2, overview_pb2, simulation_pb2, subscriptions_pb2,
)
from engine_support import (
    FINANCE, LEAD, MARKETING, PUBLIC, apply, approved, create, eur, family_migration, gift_pass, nordflur, scheduled,
    student_autumn,
)

REFUSAL = common_pb2.RefusalCode


def at(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


async def on_sale(world) -> changes_pb2.Change:
    """The pass written by the commercial lead, signed by finance, on sale from 1 November at midnight in Rome."""
    change = await scheduled(world, gift_pass(), LEAD, FINANCE)
    world.clock.at = at(2026, 10, 31, 22, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    world.clock.at = at(2026, 11, 1, 9, 0)
    return change


async def buy(world, subscriber: int, pass_id: int, *, request_id: str | None = None):
    return await world.call("BuyPrepaidPass", subscriptions_pb2.BuyPrepaidPassRequest(
        subscriber_id=subscriber, pass_id=pass_id), PUBLIC, request_id_=request_id)


async def bought(world, subscriber: int, pass_id: int) -> subscriptions_pb2.PrepaidCode:
    """A code paid for: bought, and its payment settled by the provider through the outbox."""
    code = (await buy(world, subscriber, pass_id)).code
    await world.engine.deliver_outbox()
    return code


async def activate(world, subscriber: int, code: str, *, request_id: str | None = None):
    return await world.call("ActivatePrepaidPass", subscriptions_pb2.ActivatePrepaidPassRequest(
        subscriber_id=subscriber, code=code), PUBLIC, request_id_=request_id)


async def account(world, subscriber: int) -> subscriptions_pb2.Account:
    return (await world.call("GetAccount", subscriptions_pb2.GetAccountRequest(subscriber_id=subscriber), PUBLIC)).account


async def passes(world, market: str) -> list:
    return list((await world.call("ListPrepaidPasses", catalog_pb2.ListPrepaidPassesRequest(market=market), PUBLIC)).passes)


# -- on sale -------------------------------------------------------------------------------

async def test_the_pass_is_on_sale_from_its_start_in_its_market_only(world):
    change = await scheduled(world, gift_pass(), LEAD, FINANCE)
    assert await passes(world, "IT") == []
    world.clock.at = at(2026, 10, 31, 22, 59, 30)
    await world.engine.activate_due()
    world.clock.at = at(2026, 10, 31, 22, 59, 59)
    assert await passes(world, "IT") == []  # 23:59:59 in Rome
    world.clock.at = at(2026, 10, 31, 23, 0)
    [listed] = await passes(world, "IT")
    assert (listed.pass_id, listed.title, listed.plan, listed.months, listed.price, listed.code_valid_months) == (
        change.id, "Three-month gift pass", "individual", 3, eur(2999), 12)
    assert listed.terms.startswith("Single use")
    assert await passes(world, "DE") == []
    with pytest.raises(InvalidArgument):
        await passes(world, "it")


async def test_the_commercial_lead_writes_a_pass_and_finance_signs_it(world):
    refused = await world.call("CreateChange", changes_pb2.CreateChangeRequest(prepaid=gift_pass()), MARKETING)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    change = await create(world, gift_pass(), LEAD)
    validated = (await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=change.id, version=1),
                                  LEAD)).change
    assert validated.validation.valid
    assert [(s.role, list(s.conditions)) for s in validated.required_signatures] == [(common_pb2.ROLE_FINANCE, [1])]
    assert validated.sentence.startswith("Three-month gift pass: Individual for 3 months, paid in advance and never renewed; "
                                         "Italy: €29.99 (€10.49 a month at the list price), on sale from 1 November 2026")
    student = await create(world, gift_pass(title="Student gift", plan="student"), LEAD)
    refused = await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=student.id, version=1), LEAD)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_INVALID and "student verification" in refused.refusal.reason
    percent = gift_pass(prices=[changes_pb2.OfferPrice(market="IT", percent_off_bp=1_000)])
    with pytest.raises(InvalidArgument, match="a pass has a fixed price"):
        await world.call("CreateChange", changes_pb2.CreateChangeRequest(prepaid=percent), LEAD)


# -- scheduling ----------------------------------------------------------------------------

async def schedule(world, change: changes_pb2.Change):
    return await world.call("ScheduleChange", changes_pb2.ScheduleChangeRequest(change_id=change.id), LEAD)


async def test_a_pass_is_scheduled_beside_offers_approved_and_live(world):
    """A pass is a product of its own (§9): no offer clashes with it, so scheduling it reads no offer's audience,
    with offers approved and live in the same markets."""
    autumn = await scheduled(world, student_autumn())
    world.clock.at = at(2026, 10, 26, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome  # live in Italy until 30 November
    await approved(world, student_autumn(title="Student Winter Pass", periods=[changes_pb2.OfferPeriod(
        market="IT", starts_local="2026-12-01T09:00", ends_local="2027-01-31T00:00")]))
    await approved(world, nordflur())
    change = await approved(world, gift_pass(), LEAD, FINANCE)
    done = (await schedule(world, change)).change
    assert done.state == changes_pb2.CHANGE_STATE_SCHEDULED
    [event] = [e for e in await world.events("change.scheduled") if e["subject"] == f"change:{change.id}"]
    assert json.loads(event["body"])["starts"] == [{"market": "IT", "local": "2026-11-01T00:00", "utc": "2026-10-31T23:00:00Z"}]
    world.clock.at = at(2026, 10, 31, 22, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert (outcome.change_id, outcome.action) == (change.id, "activated"), outcome
    world.clock.at = at(2026, 11, 1, 9, 0)
    assert [p.pass_id for p in await passes(world, "IT")] == [change.id]
    offers = (await world.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT"), PUBLIC)).offers
    assert [o.offer_id for o in offers] == [autumn.id]


async def test_a_pass_whose_sale_has_ended_is_not_scheduled(world):
    october = [changes_pb2.OfferPeriod(market="IT", starts_local="2026-10-25T00:00", ends_local="2026-10-31T00:00")]
    in_time, too_late = [await approved(world, gift_pass(title=title, periods=october), LEAD, FINANCE)
                         for title in ("October gift pass", "October gift pass, again")]
    world.clock.at = at(2026, 10, 30, 22, 59)  # 23:59 in Rome, on the last day of sale
    assert (await schedule(world, in_time)).change.state == changes_pb2.CHANGE_STATE_SCHEDULED
    world.clock.at = at(2026, 10, 30, 23, 0)  # midnight in Rome: the sale is over
    refused = (await schedule(world, too_late)).refusal
    assert (refused.code, refused.facts["markets"]) == (REFUSAL.REFUSAL_CODE_INVALID, "IT")
    assert refused.reason.startswith("The pass's period of sale has already ended in IT")


# -- buying ------------------------------------------------------------------------------

async def test_a_code_is_sold_pending_and_ready_once_its_payment_succeeded(world):
    change = await on_sale(world)
    response = await buy(world, 101, change.id, request_id="site-buy-0101-001")
    code = response.code
    assert prepaid_code_shape(code.code)
    assert (code.pass_id, code.state, code.price, code.months, code.market, code.valid_until) == (
        change.id, "pending", eur(2999), 3, "IT", "2027-10-31")
    assert code.payment.state == subscriptions_pb2.PAYMENT_STATE_PENDING
    [sold] = await world.events("prepaid.sold")
    assert (sold["actor"], sold["actor_role"], sold["request_id"]) == ("subscriber-101", "subscriber", "site-buy-0101-001")
    assert code.code not in sold["body"] and code.code not in sold["subject"]  # a bearer secret stays out of the log
    assert '"net": 2458' in sold["body"]
    deliveries = await world.engine.deliver_outbox()
    assert [(d.consumer, d.delivered) for d in deliveries] == [("payments", True)]
    [mine] = (await account(world, 101)).prepaid_codes
    assert (mine.code, mine.state, mine.payment.state) == (code.code, "ready", subscriptions_pb2.PAYMENT_STATE_SUCCEEDED)
    assert mine.payment.receipt.demonstration and mine.payment.receipt.amount == eur(2999)
    [paid] = await world.events("payment.succeeded")
    assert code.code not in paid["body"] and '"prepaid":' in paid["body"]


def prepaid_code_shape(code: str) -> bool:
    from commerce.domain.prepaid import CODE
    return bool(CODE.match(code))


async def test_buying_refusals_and_errors(world):
    change = await on_sale(world)
    refused = await buy(world, 201, change.id)  # a listener in Germany: not on sale there
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE and "not on sale in Germany" in refused.refusal.reason
    with pytest.raises(NotFound):
        await buy(world, 101, 99_999)
    offer = await create(world, family_migration(), LEAD)
    with pytest.raises(NotFound):
        await buy(world, 101, offer.id)  # a change, but not a pass
    with pytest.raises(NotFound):
        await buy(world, 9_999, change.id)
    with pytest.raises(InvalidArgument):
        await buy(world, 101, 0)


async def test_a_declined_payment_leaves_a_code_that_never_works(world, monkeypatch):
    change = await on_sale(world)

    async def decline(charge):
        event = ProviderEvent("simulated", "evt_declined_pass_01", FAILED, charge.payment_id, "sim-pay-declined",
                              world.clock.now(), "The card was declined.")
        return ChargeResult("simulated", "sim-pay-declined", (event,))

    monkeypatch.setattr(world.engine.payments, "charge", decline)
    code = (await buy(world, 101, change.id)).code
    await world.engine.deliver_outbox()
    [mine] = (await account(world, 101)).prepaid_codes
    assert (mine.state, mine.payment.state, mine.payment.failure_reason) == (
        "failed", subscriptions_pb2.PAYMENT_STATE_FAILED, "The card was declined.")
    refused = await activate(world, 102, code.code)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and "declined" in refused.refusal.reason
    assert await world.owner.fetchval("select count(*) from receipt") == 0


# -- activating ------------------------------------------------------------------------------

async def test_a_gift_code_gives_three_months_never_charged_then_the_free_plan(world):
    change = await on_sale(world)
    code = await bought(world, 101, change.id)
    world.clock.at = at(2026, 11, 2, 9, 0)
    typed = code.code.lower().replace("-", " ")  # as a person types it
    response = await activate(world, 102, typed, request_id="site-activate-0102")
    s = response.subscription
    assert (s.plan, s.paid, s.price, s.prepaid_code, s.prepaid_price) == ("individual", True, eur(0), code.code, eur(2999))
    assert (s.started_on, s.ends_on, s.next_billing_on, s.HasField("next_charge")) == ("2026-11-02", "2027-02-02", "", False)
    rows = await world.owner.fetch("select plan_id, started_on::text, ended_on::text from subscription "
                                   "where subscriber_id = 102 order by started_on")
    assert [tuple(r) for r in rows] == [("free", "2026-01-10", "2026-11-02"), ("individual", "2026-11-02", "2027-02-02"),
                                        ("free", "2027-02-02", None)]
    assert await world.owner.fetchval("select price_minor from subscription_price where subscription_id = $1",
                                      s.subscription_id) == 0
    [activated] = await world.events("prepaid.activated")
    assert (activated["actor"], activated["request_id"]) == ("subscriber-102", "site-activate-0102")
    assert code.code not in activated["body"]
    # The buyer sees it used; the same listener again gets the same answer; anyone else is refused.
    [mine] = (await account(world, 101)).prepaid_codes
    assert (mine.state, mine.activated_by, mine.activated_on) == ("activated", 102, "2026-11-02")
    assert (await activate(world, 102, code.code)).subscription == s
    used = await activate(world, 105, code.code)
    assert used.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and "used already" in used.refusal.reason
    # After its months, the free plan, with nothing charged.
    world.clock.at = at(2027, 2, 2, 9, 0)
    after = (await account(world, 102)).subscription
    assert (after.plan, after.paid) == ("free", False)


async def test_activation_refusals_and_errors(world):
    change = await on_sale(world)
    ready = await bought(world, 101, change.id)
    pending = (await buy(world, 101, change.id)).code
    world.clock.at = at(2026, 11, 2, 9, 0)
    refused = await activate(world, 201, ready.code)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE and "for Italy" in refused.refusal.reason
    refused = await activate(world, 106, ready.code)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_ALREADY_SUBSCRIBED
    refused = await activate(world, 105, pending.code)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and "not settled yet" in refused.refusal.reason
    with pytest.raises(NotFound):
        await activate(world, 105, "ABCD-EFGH-JKMN")
    with pytest.raises(InvalidArgument):
        await activate(world, 105, "not a code")


# -- the end of codes not used, and finance's figures ------------------------------------

async def test_a_code_not_activated_by_its_last_day_expires_once(world):
    change = await on_sale(world)
    code = await bought(world, 101, change.id)
    world.clock.at = at(2027, 10, 31, 22, 59)  # 23:59 on 31 October 2027 in Rome: still its last day
    assert await world.engine.expire_prepaid_codes() == []
    world.clock.at = at(2027, 10, 31, 23, 0)
    refused = await activate(world, 105, code.code)  # past its day, before the job: refused all the same
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and "until 2027-10-31" in refused.refusal.reason
    logs = io.StringIO()
    jobs = Jobs(world.engine, JsonLog(world.clock.now, logs))
    await jobs.run_pass()
    await jobs.run_pass()
    expired = [json.loads(line) for line in logs.getvalue().splitlines() if '"prepaid_code_expired"' in line]
    assert [(e["market"], e["valid_until"]) for e in expired] == [("IT", "2027-10-31")]
    [mine] = (await account(world, 101)).prepaid_codes
    assert mine.state == "expired"
    [event] = await world.events("prepaid.expired")
    assert (event["actor"], event["subject"]) == ("prepaid", f"prepaid:{expired[0]['prepaid']}")


async def test_finance_sees_the_value_sold_and_not_yet_earned(world):
    change = await on_sale(world)
    used = await bought(world, 101, change.id)
    await bought(world, 101, change.id)
    await buy(world, 101, change.id)  # its payment not settled yet: nothing sold
    world.clock.at = at(2026, 11, 2, 9, 0)
    await activate(world, 102, used.code)
    home = await world.call("GetOverview", overview_pb2.GetOverviewRequest(), FINANCE)
    [italy] = home.prepaid
    # Two codes paid for at €24.58 net: one activated, which earned its first €8.19 today; one waiting.
    assert (italy.market, italy.sold, italy.activated, italy.expired, italy.unearned) == ("IT", 2, 1, 0, eur(2458 - 819 + 2458))
    assert home.prepaid_unearned_eur == eur(4097)
    # The pass running counts this month's part of its net amount in the revenue, and needs no top-up.
    before = await world.call("GetOverview", overview_pb2.GetOverviewRequest(at="2026-11-01T09:00:00Z"), FINANCE)
    [it_now] = [r for r in home.monthly_revenue if r.market == "IT"]
    [it_before] = [r for r in before.monthly_revenue if r.market == "IT"]
    assert it_now.revenue.amount_minor - it_before.revenue.amount_minor == 819
    assert home.monthly_top_ups == before.monthly_top_ups
    lead = await world.call("GetOverview", overview_pb2.GetOverviewRequest(), LEAD)
    assert (list(lead.prepaid), lead.HasField("prepaid_unearned_eur")) == ([], False)


async def test_a_price_migration_leaves_passes_alone(world):
    change = await on_sale(world)
    used = await bought(world, 101, change.id)
    await bought(world, 101, change.id)
    world.clock.at = at(2026, 11, 2, 9, 0)
    await activate(world, 102, used.code)
    rise = await scheduled(world, apply(family_migration(), {
        "title": "Individual price, Italy", "plan": "individual", "market": "IT", "amount": eur(1149),
        "notices_local": "2026-11-10T09:00", "starts_local": "2026-12-01T00:00"}), LEAD, FINANCE)
    simulated = (await world.call("SimulateMigration", simulation_pb2.SimulateMigrationRequest(change_id=rise.id),
                                  LEAD)).result
    # 106 pays Individual by the month; 102's pass runs, and one code waits: neither is asked.
    assert (simulated.existing, simulated.prepaid_passes_untouched) == (1, 2)
    world.clock.at = at(2026, 11, 10, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    asked = [r["subscriber_id"] for r in await world.owner.fetch(
        "select subscriber_id from price_change_request where change_id = $1", rise.id)]
    assert asked == [106]
