"""From approved to live and back (business book §4.2, §7.1, §7.5, §12):
ScheduleChange, CancelChange, SuspendChange, and the minimal activation that
publishes the catalog in one transaction."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from commerce.v1 import catalog_pb2, changes_pb2, common_pb2, quotes_pb2
from engine_support import (
    FINANCE, LEAD, MARKETING, ON_CALL, PUBLIC, approved, family_rise, scheduled, student_autumn,
)

REFUSAL = common_pb2.RefusalCode
STATE = changes_pb2


def at(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


async def schedule(world, change, who=MARKETING):
    return await world.call("ScheduleChange", changes_pb2.ScheduleChangeRequest(change_id=change.id), who)


async def cancel(world, change, who=MARKETING, reason="The campaign moves to spring."):
    return await world.call("CancelChange", changes_pb2.CancelChangeRequest(change_id=change.id, reason=reason), who)


async def suspend(world, change, who=ON_CALL, reason="The page shows the wrong price."):
    return await world.call("SuspendChange", changes_pb2.SuspendChangeRequest(change_id=change.id, reason=reason), who)


async def offers(world, market: str = "IT", when: str = "") -> list:
    return list((await world.call("ListOffers", catalog_pb2.ListOffersRequest(market=market, at=when), PUBLIC)).offers)


async def live(world) -> changes_pb2.Change:
    """Scheduled, then activated a minute before its 09:00 start in Rome."""
    change = await scheduled(world, student_autumn(), MARKETING, FINANCE)
    world.clock.at = at(2026, 10, 26, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome
    return change


# -- ScheduleChange ----------------------------------------------------------------

async def test_scheduling_records_the_start_of_each_market_in_local_time_and_utc(world):
    change = await approved(world, student_autumn())
    done = (await schedule(world, change)).change
    assert done.state == STATE.CHANGE_STATE_SCHEDULED
    [event] = await world.events("change.scheduled")
    assert '"local": "2026-10-26T09:00"' in event["body"] and '"utc": "2026-10-26T08:00:00Z"' in event["body"]


async def test_finance_approves_but_does_not_schedule(world):
    change = await approved(world, student_autumn())
    assert (await schedule(world, change, FINANCE)).refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    assert (await schedule(world, change, LEAD)).change.state == STATE.CHANGE_STATE_SCHEDULED


async def test_only_an_approved_change_is_scheduled(world):
    change = await scheduled(world, student_autumn())
    assert (await schedule(world, change)).refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE


async def test_an_offer_whose_period_is_over_is_not_scheduled(world):
    change = await approved(world, student_autumn())
    world.clock.at = at(2026, 12, 1, 0, 0)
    response = await schedule(world, change)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_INVALID and response.refusal.facts["markets"] == "IT"


async def test_a_list_price_that_would_overlap_the_price_list_is_not_scheduled(world):
    change = await approved(world, family_rise(), LEAD, FINANCE)
    # Meanwhile, the price list got a later Family price in Germany.
    await world.owner.execute("update list_price set valid = tsrange(lower(valid), '2027-01-01') "
                              "where plan_id = 'family' and market = 'DE'")
    await world.owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                              "values ('family', 'DE', 'EUR', 1999, tsrange('2027-01-01', null))")
    response = await schedule(world, change, LEAD)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_OVERLAP


# -- CancelChange -------------------------------------------------------------------

async def test_a_scheduled_launch_is_cancelled_with_a_reason(world):
    change = await scheduled(world, student_autumn())
    assert (await cancel(world, change, reason=" ")).refusal.code == REFUSAL.REFUSAL_CODE_REASON_REQUIRED
    assert (await cancel(world, change, FINANCE)).refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    done = (await cancel(world, change, ON_CALL)).change
    assert done.state == STATE.CHANGE_STATE_CANCELLED and done.state_reason == "The campaign moves to spring."
    world.clock.at = at(2026, 10, 26, 8, 0)
    assert await world.engine.activate_due() == []
    assert (await cancel(world, change)).refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE


# -- Activation -----------------------------------------------------------------------

async def test_an_offer_appears_exactly_at_its_local_start(world):
    change = await live(world)
    assert await offers(world, when="2026-10-26T07:59:59Z") == []
    [offer] = await offers(world, when="2026-10-26T08:00:00Z")
    assert offer.offer_id == change.id
    state = await world.owner.fetchval("select state from change where id = $1", change.id)
    assert state == "active"
    actions = [e["action"] for e in await world.events()][-2:]
    assert actions == ["change.activated", "catalog.published"]


async def test_activation_waits_for_its_minute(world):
    await scheduled(world, student_autumn())
    world.clock.at = at(2026, 10, 26, 7, 58, 59)
    assert await world.engine.activate_due() == []
    assert await world.owner.fetchval("select count(*) from catalog_publication") == 0


async def test_two_activations_of_one_change_at_once_publish_once(world):
    change = await scheduled(world, student_autumn())
    now = at(2026, 10, 26, 7, 59, 30)
    publisher = world.engine.publisher

    async def activate(request_id: str):
        async with world.engine.db.transaction() as tx:
            return await publisher.activate(tx, change.id, now, request_id)

    first, second = await asyncio.gather(activate("activation-first-1"), activate("activation-second-1"))
    assert sorted([first.action, second.action]) == ["activated", "skipped"]
    assert await world.owner.fetchval("select count(*) from catalog_publication") == 1
    assert len(await world.events("change.activated")) == 1


async def test_a_list_price_enters_the_price_list_exactly_at_its_start(world):
    change = await scheduled(world, family_rise(), LEAD, FINANCE)
    world.clock.at = at(2026, 11, 30, 22, 59, 30)  # a minute before midnight in Berlin
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated"
    rows = await world.owner.fetch("select amount_minor, lower(valid) as starts, upper(valid) as ends, change_id from list_price "
                                   "where plan_id = 'family' and market = 'DE' order by lower(valid)")
    assert [(r["amount_minor"], r["change_id"]) for r in rows] == [(1899, None), (2099, change.id)]
    assert rows[0]["ends"] == rows[1]["starts"] == datetime(2026, 12, 1, 0, 0)
    before = await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="family", market="DE"), PUBLIC)
    assert before.quote.price.amount_minor == 1899
    world.clock.at = at(2026, 11, 30, 23, 0)
    after = await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="family", market="DE"), PUBLIC)
    assert after.quote.price.amount_minor == 2099


async def test_a_late_activation_applies_the_price_from_when_it_really_ran(world):
    await scheduled(world, family_rise(), LEAD, FINANCE)
    world.clock.at = at(2026, 12, 1, 9, 30, 0, 250_000)  # the engine was down all night
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated"
    starts = await world.owner.fetchval("select lower(valid) from list_price where plan_id = 'family' and market = 'DE' "
                                        "and upper_inf(valid)")
    assert starts == datetime(2026, 12, 1, 10, 30, 1)  # Berlin time, rounded up to the next second
    [event] = await world.events("change.activated")
    assert '"effective": "2026-12-01T10:30:01"' in event["body"] and '"starts": "2026-12-01T00:00"' in event["body"]


async def test_a_list_price_ends_when_a_later_one_takes_over(world):
    first = await scheduled(world, family_rise(), LEAD, FINANCE)
    world.clock.at = at(2026, 11, 30, 23, 0)
    await world.engine.activate_due()
    second = await scheduled(world, family_rise(title="Family price, Germany, spring", amount=common_pb2.Money(
        amount_minor=2_199, currency="EUR"), starts_local="2027-03-01T00:00"), LEAD, FINANCE)
    world.clock.at = at(2027, 2, 28, 23, 0)
    await world.engine.activate_due()
    states = {r["id"]: r["state"] for r in await world.owner.fetch("select id, state from change")}
    assert (states[first.id], states[second.id]) == ("ended", "active")
    assert len(await world.events("change.ended")) == 1


async def test_a_failed_activation_leaves_nothing_half_done(world):
    change = await scheduled(world, family_rise(), LEAD, FINANCE)
    # A later price slipped into the price list after scheduling (by hand, as an
    # administrator could): the activation must fail whole.
    await world.owner.execute("update list_price set valid = tsrange(lower(valid), '2026-12-15') "
                              "where plan_id = 'family' and market = 'DE'")
    await world.owner.execute("insert into list_price (plan_id, market, currency, amount_minor, valid) "
                              "values ('family', 'DE', 'EUR', 1949, tsrange('2026-12-15', null))")
    events_before = await world.owner.fetchval("select count(*) from audit_event")
    world.clock.at = at(2026, 11, 30, 23, 0)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "failed" and "overlap" in outcome.error
    assert await world.owner.fetchval("select state from change where id = $1", change.id) == "scheduled"
    assert await world.owner.fetchval("select count(*) from catalog_publication") == 0
    assert await world.owner.fetchval("select count(*) from audit_event") == events_before
    assert await world.owner.fetchval("select count(*) from list_price where change_id = $1", change.id) == 0


async def test_an_offer_ends_when_its_periods_are_over(world):
    change = await live(world)
    world.clock.at = at(2026, 11, 29, 22, 59)
    assert await world.engine.end_due() == []
    world.clock.at = at(2026, 11, 29, 23, 0)  # midnight in Rome
    [outcome] = await world.engine.end_due()
    assert (outcome.change_id, outcome.action) == (change.id, "ended")
    assert await offers(world) == []
    snapshot = await world.owner.fetchval("select snapshot_id from catalog_publication order by seq desc limit 1")
    assert await world.owner.fetchval("select count(*) from catalog_offer where snapshot_id = $1", snapshot) == 0


# -- SuspendChange -------------------------------------------------------------------

async def test_the_on_call_engineer_takes_an_offer_off_the_site(world):
    change = await live(world)
    world.clock.at = at(2026, 10, 27, 10, 0)
    assert len(await offers(world)) == 1
    done = (await suspend(world, change)).change
    assert done.state == STATE.CHANGE_STATE_SUSPENDED and done.state_reason == "The page shows the wrong price."
    assert await offers(world) == []
    # The site's history still shows what was live before.
    assert len(await offers(world, when="2026-10-27T09:00:00Z")) == 1
    actions = [e["action"] for e in await world.events()][-2:]
    assert actions == ["change.suspended", "catalog.published"]


async def test_suspension_refusals(world):
    change = await live(world)
    assert (await suspend(world, change, MARKETING)).refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    assert (await suspend(world, change, reason="")).refusal.code == REFUSAL.REFUSAL_CODE_REASON_REQUIRED
    await suspend(world, change)
    assert (await suspend(world, change)).refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE


async def test_a_list_price_in_force_is_not_suspended(world):
    change = await scheduled(world, family_rise(), LEAD, FINANCE)
    world.clock.at = at(2026, 11, 30, 23, 0)
    await world.engine.activate_due()
    response = await suspend(world, change)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and response.refusal.facts["kind"] == "list_price"


async def test_an_activation_interleaved_with_a_suspension_stays_on_the_site(world, monkeypatch):
    # The activation pass reads the clock, then a suspension publishes with a later time before the
    # activation takes the publication lock: the activation's catalog comes later in the sequence with
    # an earlier time. The site must still show the activated offer.
    first = await live(world)  # live from 26 October
    gift = student_autumn(title="Autumn gift", plan="individual", non_combinability_group="gift-offers",
                          audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_NEVER_PAID),
                          prices=[changes_pb2.OfferPrice(market="IT", fixed=common_pb2.Money(amount_minor=899, currency="EUR"))],
                          periods=[changes_pb2.OfferPeriod(market="IT", starts_local="2026-10-27T09:00")])
    second = await scheduled(world, gift, MARKETING, FINANCE)
    publisher = world.engine.publisher
    original = publisher.activate

    async def suspend_first_then_activate(tx, change_id, now, request_id):
        world.clock.at = at(2026, 10, 27, 8, 5)  # five minutes after the pass read its clock
        await suspend(world, first, reason="The page shows the wrong price.")
        return await original(tx, change_id, now, request_id)

    monkeypatch.setattr(publisher, "activate", suspend_first_then_activate)
    world.clock.at = at(2026, 10, 27, 7, 59, 30)
    [outcome] = await world.engine.activate_due()
    assert (outcome.change_id, outcome.action) == (second.id, "activated")
    world.clock.at = at(2026, 10, 27, 9, 0)
    assert [o.offer_id for o in await offers(world)] == [second.id]
    times = await world.owner.fetch("select published_at from catalog_publication order by seq")
    assert [t["published_at"] for t in times] == sorted(t["published_at"] for t in times)
