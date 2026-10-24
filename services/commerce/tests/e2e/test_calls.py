"""Every call of the contract over gRPC, server and client both real: each
one answering, each one refusing when its response can carry a refusal, and
each one failing with its status code. The last test checks, from what the
client saw, that no method of the contract was left out."""

from __future__ import annotations

from datetime import UTC, datetime

import grpc

from commerce.engine.engine import METHODS
from commerce.v1 import (
    audit_pb2, catalog_pb2, changes_pb2, common_pb2, launches_pb2, overview_pb2, quotes_pb2, simulation_pb2,
    subscriptions_pb2,
)
from engine_support import (
    AUDITOR, FINANCE, LEAD, MARKETING, ON_CALL, PUBLIC, approved, create, family_migration, family_rise, fingerprint,
    scheduled, student_autumn, submitted, validated,
)
from wire_support import SEEN, wire  # noqa: F401  (the fixture)

OK, CODE = grpc.StatusCode.OK, grpc.StatusCode
REFUSAL = common_pb2.RefusalCode


def refused(reply, code) -> bool:
    return reply.code is OK and reply.response.WhichOneof("outcome") == "refusal" and reply.response.refusal.code == code


async def test_catalog_calls(wire):
    markets = await wire.call("ListMarkets", catalog_pb2.ListMarketsRequest(), PUBLIC)
    assert markets.code is OK and [m.code for m in markets.response.markets] == ["DE", "FR", "GB", "IT"]
    assert (await wire.call("ListMarkets", catalog_pb2.ListMarketsRequest(), PUBLIC, token=None)).code is CODE.UNAUTHENTICATED

    plans = await wire.call("ListPlans", catalog_pb2.ListPlansRequest(market="FR"), PUBLIC)
    assert plans.code is OK and plans.response.plans[1].list_price.amount_minor == 1_099
    assert (await wire.call("ListPlans", catalog_pb2.ListPlansRequest(), PUBLIC)).code is CODE.INVALID_ARGUMENT
    assert (await wire.call("ListPlans", catalog_pb2.ListPlansRequest(market="ES"), PUBLIC)).code is CODE.NOT_FOUND

    prices = await wire.call("GetPriceList", catalog_pb2.GetPriceListRequest(market="GB"), PUBLIC)
    assert prices.code is OK and len(prices.response.entries) == 4
    assert (await wire.call("GetPriceList", catalog_pb2.GetPriceListRequest(plan="platinum"), PUBLIC)).code is CODE.NOT_FOUND

    offers = await wire.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT"), PUBLIC)
    assert offers.code is OK and list(offers.response.offers) == []
    assert (await wire.call("ListOffers", catalog_pb2.ListOffersRequest(market="it"), PUBLIC)).code is CODE.INVALID_ARGUMENT


async def test_quote_calls(wire):
    quote = await wire.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="duo", market="DE"), PUBLIC)
    assert quote.code is OK and quote.response.quote.price.amount_minor == 1_499
    assert quote.response.quote.quote_id.startswith("q_")
    other_market = await wire.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="duo", market="IT", subscriber_id=301), PUBLIC)
    assert refused(other_market, REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE)
    no_key = await wire.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="duo", market="DE"), PUBLIC, key=None)
    assert no_key.code is CODE.INVALID_ARGUMENT
    nobody = await wire.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="duo", market="DE", subscriber_id=9_999), PUBLIC)
    assert nobody.code is CODE.NOT_FOUND


async def test_people_calls(wire):
    people = await wire.call("ListPeople", overview_pb2.ListPeopleRequest(), PUBLIC)
    assert people.code is OK and len(people.response.people) == 9
    assert (await wire.call("ListPeople", overview_pb2.ListPeopleRequest(), PUBLIC, token="x" * 64)).code is CODE.UNAUTHENTICATED


async def test_writing_changes(wire):
    created = await wire.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn()), MARKETING)
    assert created.code is OK and created.response.change.state == changes_pb2.CHANGE_STATE_DRAFT
    change_id = created.response.change.id
    as_finance = await wire.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn()), FINANCE)
    assert refused(as_finance, REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED)
    assert (await wire.call("CreateChange", changes_pb2.CreateChangeRequest(), MARKETING)).code is CODE.INVALID_ARGUMENT
    anonymous = await wire.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn()), PUBLIC)
    assert anonymous.code is CODE.PERMISSION_DENIED

    saved = await wire.call("SaveVersion", changes_pb2.SaveVersionRequest(
        change_id=change_id, base_version=1, offer=student_autumn(title="Student Autumn Pass 2026")), MARKETING)
    assert saved.code is OK and saved.response.change.current_version == 2
    stale = await wire.call("SaveVersion", changes_pb2.SaveVersionRequest(
        change_id=change_id, base_version=1, offer=student_autumn()), MARKETING)
    assert refused(stale, REFUSAL.REFUSAL_CODE_STALE_VERSION) and stale.response.refusal.facts["newer_version"] == "2"
    missing = await wire.call("SaveVersion", changes_pb2.SaveVersionRequest(
        change_id=4_040, base_version=1, offer=student_autumn()), MARKETING)
    assert missing.code is CODE.NOT_FOUND


async def test_reading_changes(wire):
    change = await create(wire.world, student_autumn())
    got = await wire.call("GetChange", changes_pb2.GetChangeRequest(change_id=change.id), AUDITOR)
    assert got.code is OK and got.response.change == change
    assert (await wire.call("GetChange", changes_pb2.GetChangeRequest(change_id=77), AUDITOR)).code is CODE.NOT_FOUND
    batch = await wire.call("BatchGetChanges", changes_pb2.BatchGetChangesRequest(change_ids=[change.id, 77]), ON_CALL)
    assert batch.code is OK and [c.id for c in batch.response.changes] == [change.id]
    too_many = await wire.call("BatchGetChanges", changes_pb2.BatchGetChangesRequest(change_ids=list(range(1, 600))), ON_CALL)
    assert too_many.code is CODE.INVALID_ARGUMENT
    listed = await wire.call("ListChanges", changes_pb2.ListChangesRequest(), FINANCE)
    assert listed.code is OK and [c.id for c in listed.response.changes] == [change.id]
    bad_cursor = await wire.call("ListChanges", changes_pb2.ListChangesRequest(
        page=common_pb2.PageRequest(after="garbage")), FINANCE)
    assert bad_cursor.code is CODE.INVALID_ARGUMENT


async def test_review_calls(wire):
    change = await create(wire.world, student_autumn())
    invalid = await create(wire.world, student_autumn(title="No pages", pages=[]))
    request = changes_pb2.ValidateChangeRequest
    assert refused(await wire.call("ValidateChange", request(change_id=invalid.id, version=1)), REFUSAL.REFUSAL_CODE_INVALID)
    assert (await wire.call("ValidateChange", request(change_id=999, version=1))).code is CODE.NOT_FOUND
    valid = await wire.call("ValidateChange", request(change_id=change.id, version=1))
    assert valid.code is OK and valid.response.change.state == changes_pb2.CHANGE_STATE_VALIDATED

    submit = changes_pb2.SubmitChangeRequest
    assert refused(await wire.call("SubmitChange", submit(change_id=invalid.id, version=1)), REFUSAL.REFUSAL_CODE_WRONG_STATE)
    assert (await wire.call("SubmitChange", submit(change_id=999, version=1))).code is CODE.NOT_FOUND
    sent = await wire.call("SubmitChange", submit(change_id=change.id, version=1, author_reason="Students first."))
    assert sent.code is OK and sent.response.change.state == changes_pb2.CHANGE_STATE_IN_APPROVAL

    approve = changes_pb2.ApproveChangeRequest
    forged = await wire.call("ApproveChange", approve(change_id=change.id, version=1, content_hash=b"\x00" * 32), FINANCE)
    assert refused(forged, REFUSAL.REFUSAL_CODE_FINGERPRINT_MISMATCH)
    lead = await wire.call("ApproveChange", approve(change_id=change.id, version=1, content_hash=fingerprint(sent.response.change)),
                           LEAD)
    assert refused(lead, REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED)
    assert (await wire.call("ApproveChange", approve(change_id=999, version=1, content_hash=b"\x00" * 32), FINANCE)).code \
        is CODE.NOT_FOUND
    signed = await wire.call("ApproveChange", approve(change_id=change.id, version=1,
                                                      content_hash=fingerprint(sent.response.change)), FINANCE)
    assert signed.code is OK and signed.response.change.state == changes_pb2.CHANGE_STATE_APPROVED

    other = await submitted(wire.world, student_autumn(title="Second pass", non_combinability_group="second-offers"))
    reject = changes_pb2.RejectChangeRequest
    assert refused(await wire.call("RejectChange", reject(change_id=other.id, version=1, reason=""), FINANCE),
                   REFUSAL.REFUSAL_CODE_REASON_REQUIRED)
    assert (await wire.call("RejectChange", reject(change_id=999, version=1, reason="No."), FINANCE)).code is CODE.NOT_FOUND
    back = await wire.call("RejectChange", reject(change_id=other.id, version=1, reason="It clashes with the first."), FINANCE)
    assert back.code is OK and back.response.change.state == changes_pb2.CHANGE_STATE_DRAFT


async def test_launch_calls(wire):
    change = await approved(wire.world, student_autumn())
    schedule = changes_pb2.ScheduleChangeRequest
    assert refused(await wire.call("ScheduleChange", schedule(change_id=change.id), FINANCE), REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED)
    assert (await wire.call("ScheduleChange", schedule(change_id=999))).code is CODE.NOT_FOUND
    assert (await wire.call("ScheduleChange", schedule(change_id=change.id))).response.change.state \
        == changes_pb2.CHANGE_STATE_SCHEDULED

    cancel = changes_pb2.CancelChangeRequest
    assert refused(await wire.call("CancelChange", cancel(change_id=change.id, reason=""), ON_CALL),
                   REFUSAL.REFUSAL_CODE_REASON_REQUIRED)
    assert (await wire.call("CancelChange", cancel(change_id=999, reason="x"), ON_CALL)).code is CODE.NOT_FOUND
    cancelled = await wire.call("CancelChange", cancel(change_id=change.id, reason="Moved to spring."), ON_CALL)
    assert cancelled.response.change.state == changes_pb2.CHANGE_STATE_CANCELLED

    live = await scheduled(wire.world, student_autumn(title="Live one", non_combinability_group="live-offers"))
    wire.world.clock.at = datetime(2026, 10, 26, 7, 59, 30, tzinfo=UTC)
    await wire.world.engine.activate_due()
    suspend = changes_pb2.SuspendChangeRequest
    assert refused(await wire.call("SuspendChange", suspend(change_id=live.id, reason="x"), MARKETING),
                   REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED)
    assert (await wire.call("SuspendChange", suspend(change_id=999, reason="x"), ON_CALL)).code is CODE.NOT_FOUND
    stopped = await wire.call("SuspendChange", suspend(change_id=live.id, reason="Wrong page."), ON_CALL)
    assert stopped.response.change.state == changes_pb2.CHANGE_STATE_SUSPENDED


async def test_simulation_calls(wire):
    change = await validated(wire.world, student_autumn())
    request = simulation_pb2.SimulateOfferRequest(change_id=change.id, market="IT", overrides=[
        simulation_pb2.AssumptionOverride(name="eligible", value=10_000)])
    result = await wire.call("SimulateOffer", request, FINANCE)
    assert result.code is OK and result.response.result.difference.contribution.amount_minor == -187_751
    assert refused(await wire.call("SimulateOffer", request, ON_CALL), REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED)
    missing = simulation_pb2.SimulateOfferRequest(change_id=999, market="IT")
    assert (await wire.call("SimulateOffer", missing, FINANCE)).code is CODE.NOT_FOUND


async def test_price_migration_calls(wire):
    world = wire.world
    change = await create(world, family_migration(), LEAD)
    simulate = simulation_pb2.SimulateMigrationRequest
    simulated = await wire.call("SimulateMigration", simulate(change_id=change.id), FINANCE)
    assert simulated.code is OK and simulated.response.result.after.net.amount_minor == 1_764
    assert refused(await wire.call("SimulateMigration", simulate(change_id=change.id), ON_CALL),
                   REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED)
    assert (await wire.call("SimulateMigration", simulate(change_id=999), FINANCE)).code is CODE.NOT_FOUND
    typed = [simulation_pb2.AssumptionOverride(name="acceptance", value=20_000)]
    assert (await wire.call("SimulateMigration", simulate(change_id=change.id, overrides=typed), FINANCE)).code is (
        CODE.INVALID_ARGUMENT)

    started = await scheduled(world, family_migration(title="Family price rise, Germany, again"), LEAD, FINANCE)
    world.clock.at = datetime(2026, 11, 2, 8, 0, tzinfo=UTC)
    await world.engine.run_launches()
    asked = await world.owner.fetchval("select id from price_change_request where change_id = $1 and subscriber_id = 203",
                                       started.id)
    answer = subscriptions_pb2.AnswerPriceChangeRequest
    said = await wire.call("AnswerPriceChange", answer(subscriber_id=203, price_change_id=asked, accept=True), PUBLIC,
                           request_id="site-answer-0203")
    assert said.code is OK and said.response.price_change.state == "accepted"
    [event] = await world.events("price_change.answered")
    assert (event["request_id"], event["actor"], event["actor_role"]) == ("site-answer-0203", "subscriber-203", "subscriber")
    assert refused(await wire.call("AnswerPriceChange", answer(subscriber_id=203, price_change_id=asked, accept=False), PUBLIC),
                   REFUSAL.REFUSAL_CODE_WRONG_STATE)
    assert (await wire.call("AnswerPriceChange", answer(subscriber_id=203, price_change_id=999, accept=True),
                            PUBLIC)).code is CODE.NOT_FOUND
    assert (await wire.call("AnswerPriceChange", answer(subscriber_id=203, price_change_id=asked, accept=True), PUBLIC,
                            key=None)).code is CODE.INVALID_ARGUMENT


async def test_audit_calls(wire):
    await create(wire.world, student_autumn())
    events = await wire.call("ListEvents", audit_pb2.ListEventsRequest(), MARKETING)
    assert events.code is OK and [e.action for e in events.response.events] == ["change.created"]
    assert (await wire.call("ListEvents", audit_pb2.ListEventsRequest(
        page=common_pb2.PageRequest(after="x")), MARKETING)).code is CODE.INVALID_ARGUMENT
    assert (await wire.call("ListEvents", audit_pb2.ListEventsRequest(), PUBLIC)).code is CODE.PERMISSION_DENIED

    exported = await wire.call("ExportHead", audit_pb2.ExportHeadRequest(), AUDITOR)
    assert exported.code is OK and exported.response.head.seq == 1
    assert refused(await wire.call("ExportHead", audit_pb2.ExportHeadRequest(), MARKETING), REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED)
    assert (await wire.call("ExportHead", audit_pb2.ExportHeadRequest(), AUDITOR, key=None)).code is CODE.INVALID_ARGUMENT

    verified = await wire.call("VerifyChain", audit_pb2.VerifyChainRequest(anchor=exported.response.head), AUDITOR)
    assert verified.code is OK and verified.response.ok and verified.response.events == 2
    assert (await wire.call("VerifyChain", audit_pb2.VerifyChainRequest(), MARKETING)).code is CODE.PERMISSION_DENIED


async def test_overview_calls(wire):
    home = await wire.call("GetOverview", overview_pb2.GetOverviewRequest(), FINANCE)
    assert home.code is OK and home.response.monthly_revenue_eur.amount_minor > 0
    stranger = await wire.call("GetOverview", overview_pb2.GetOverviewRequest(), ("stranger-1", "finance"))
    assert stranger.code is CODE.PERMISSION_DENIED


async def test_subscriber_calls(wire):
    listeners = await wire.call("ListDemoListeners", subscriptions_pb2.ListDemoListenersRequest(), PUBLIC)
    assert listeners.code is OK and [l.subscriber_id for l in listeners.response.listeners] == [101, 102, 104, 401]
    no_token = await wire.call("ListDemoListeners", subscriptions_pb2.ListDemoListenersRequest(), PUBLIC, token=None)
    assert no_token.code is CODE.UNAUTHENTICATED

    verify = subscriptions_pb2.VerifyStudentRequest
    verified = await wire.call("VerifyStudent", verify(subscriber_id=102), PUBLIC, request_id="site-verify-0102")
    assert verified.code is OK and verified.response.verification.valid
    [event] = await wire.world.events("student.verified")
    assert (event["request_id"], event["actor"]) == ("site-verify-0102", "subscriber-102")
    assert refused(await wire.call("VerifyStudent", verify(subscriber_id=401), PUBLIC), REFUSAL.REFUSAL_CODE_NOT_ELIGIBLE)
    assert (await wire.call("VerifyStudent", verify(subscriber_id=9_999), PUBLIC)).code is CODE.NOT_FOUND
    assert (await wire.call("VerifyStudent", verify(subscriber_id=102), PUBLIC, key=None)).code is CODE.INVALID_ARGUMENT

    quote = (await wire.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="individual", market="FR", subscriber_id=401),
                             PUBLIC)).response.quote
    confirm = subscriptions_pb2.ConfirmQuoteRequest
    done = await wire.call("ConfirmQuote", confirm(quote_id=quote.quote_id, subscriber_id=401), PUBLIC,
                           request_id="site-confirm-0401")
    assert done.code is OK and done.response.confirmation.payment.state == subscriptions_pb2.PAYMENT_STATE_PENDING
    assert done.response.confirmation.subscription.price.amount_minor == 1_099
    [event] = await wire.world.events("subscription.confirmed")
    assert (event["request_id"], event["actor"], event["actor_role"]) == ("site-confirm-0401", "subscriber-401", "subscriber")
    other = (await wire.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="duo", market="FR", subscriber_id=401),
                             PUBLIC)).response.quote
    again = await wire.call("ConfirmQuote", confirm(quote_id=other.quote_id, subscriber_id=401), PUBLIC)
    assert refused(again, REFUSAL.REFUSAL_CODE_ALREADY_SUBSCRIBED)
    unknown = await wire.call("ConfirmQuote", confirm(quote_id="q_" + "f" * 32, subscriber_id=401), PUBLIC)
    assert unknown.code is CODE.NOT_FOUND
    malformed = await wire.call("ConfirmQuote", confirm(quote_id="nonsense", subscriber_id=401), PUBLIC)
    assert malformed.code is CODE.INVALID_ARGUMENT

    await wire.world.engine.deliver_outbox()  # the server's jobs would, right after the confirmation
    account = await wire.call("GetAccount", subscriptions_pb2.GetAccountRequest(subscriber_id=401), PUBLIC)
    assert account.code is OK and account.response.account.subscription == done.response.confirmation.subscription
    assert account.response.account.payment.receipt.demonstration
    [settled] = await wire.world.events("payment.succeeded")
    assert settled["request_id"] == "site-confirm-0401"
    nobody = await wire.call("GetAccount", subscriptions_pb2.GetAccountRequest(subscriber_id=9_999), PUBLIC)
    assert nobody.code is CODE.NOT_FOUND


async def test_launch_service_calls(wire):
    world = wire.world
    change = await scheduled(world, family_rise(), LEAD, FINANCE)
    # A later price slipped into the price list by hand: the launch is refused at its check.
    await world.owner.execute("update list_price set valid = tsrange(lower(valid), '2026-12-15') "
                              "where plan_id = 'family' and market = 'DE'")
    await world.owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                              "values ('family', 'DE', 'EUR', 1949, tsrange('2026-12-15', null))")
    world.clock.at = datetime(2026, 11, 30, 23, 0, tzinfo=UTC)
    await world.engine.run_launches()
    state = launches_pb2.LaunchState
    listed = await wire.call("ListLaunches", launches_pb2.ListLaunchesRequest(), AUDITOR)
    assert listed.code is OK
    assert [(l.change_id, l.state, l.run) for l in listed.response.launches] == [
        (change.id, state.LAUNCH_STATE_REFUSED, f"launch-{listed.response.launches[0].launch_id}")]
    launch_id = listed.response.launches[0].launch_id
    bad_page = launches_pb2.ListLaunchesRequest(page=common_pb2.PageRequest(after="x"))
    assert (await wire.call("ListLaunches", bad_page, AUDITOR)).code is CODE.INVALID_ARGUMENT

    got = await wire.call("GetLaunch", launches_pb2.GetLaunchRequest(launch_id=launch_id), MARKETING)
    assert got.code is OK and [s.name for s in got.response.launch.steps] == ["check", "prepare", "publish", "notify", "verify"]
    assert [i.kind for i in got.response.launch.incidents] == ["refused"]
    assert (await wire.call("GetLaunch", launches_pb2.GetLaunchRequest(launch_id=999), MARKETING)).code is CODE.NOT_FOUND

    retry = launches_pb2.RetryLaunchRequest
    assert refused(await wire.call("RetryLaunch", retry(launch_id=launch_id), MARKETING), REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED)
    assert (await wire.call("RetryLaunch", retry(launch_id=999), ON_CALL)).code is CODE.NOT_FOUND
    retried = await wire.call("RetryLaunch", retry(launch_id=launch_id, reason="Checking the later price again."), ON_CALL)
    assert retried.code is OK and retried.response.launch.state == state.LAUNCH_STATE_RUNNING
    await world.engine.run_launches()  # the later price is still there: refused again

    cancel = launches_pb2.CancelLaunchRequest
    assert refused(await wire.call("CancelLaunch", cancel(launch_id=launch_id, reason=""), ON_CALL),
                   REFUSAL.REFUSAL_CODE_REASON_REQUIRED)
    assert (await wire.call("CancelLaunch", cancel(launch_id=999, reason="x"), ON_CALL)).code is CODE.NOT_FOUND
    cancelled = await wire.call("CancelLaunch", cancel(launch_id=launch_id, reason="The price list needs a fix first."),
                                ON_CALL)
    assert cancelled.code is OK and cancelled.response.launch.state == state.LAUNCH_STATE_CANCELLED
    assert await world.owner.fetchval("select state from change where id = $1", change.id) == "cancelled"


def test_every_call_of_the_contract_was_seen_answering_refusing_and_failing():
    """Runs last in this module: what the client saw over the wire, method by method."""
    gaps = []
    for method in METHODS.values():
        seen = SEEN.get(method.name, set())
        refuses = "outcome" in method.response.DESCRIPTOR.oneofs_by_name
        needed = {"answer"} | ({"refusal"} if refuses else set())
        missing = needed - seen
        if missing:
            gaps.append(f"{method.name}: never seen {', '.join(sorted(missing))}")
        if not seen - {"answer", "refusal"}:
            gaps.append(f"{method.name}: never seen failing with a status code")
    assert len(METHODS) == 33
    assert not gaps, gaps
