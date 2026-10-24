"""§14.1, the complete flow, through the engine's entrance: marketing creates
the Student Autumn Pass, finance approves it, it activates at 09:00 Italian
time the day after the clocks go back, it appears in the live catalog, and a
verified student who never paid gets a quote at the right price."""

from __future__ import annotations

from datetime import UTC, datetime

from commerce.v1 import catalog_pb2, changes_pb2, quotes_pb2
from engine_support import FINANCE, MARKETING, PUBLIC, fingerprint, student_autumn


async def test_from_draft_to_a_quote(world):
    created = await world.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn()), MARKETING)
    change = created.change
    assert change.state == changes_pb2.CHANGE_STATE_DRAFT and change.current_version == 1

    validated = await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=change.id, version=1), MARKETING)
    change = validated.change
    assert change.state == changes_pb2.CHANGE_STATE_VALIDATED
    assert change.sentence == "Italy, Student: from €5.79 to €2.99 for 3 months, new subscribers only; 1 eligible; conflicts: none."
    assert change.validation.eligible == 1
    # One eligible person: T = round(1 × 12%) = 0 takers. The simulation shows no effect, so
    # condition 4 counts as met (§7.3), next to condition 2, the price under the floor.
    assert [(s.role, list(s.conditions), s.signed) for s in change.required_signatures] == [(3, [2, 4], False)]

    submitted = await world.call("SubmitChange", changes_pb2.SubmitChangeRequest(
        change_id=change.id, version=1, author_reason="We are buying students for the autumn."), MARKETING)
    assert submitted.change.state == changes_pb2.CHANGE_STATE_IN_APPROVAL

    approved = await world.call("ApproveChange", changes_pb2.ApproveChangeRequest(
        change_id=change.id, version=1, content_hash=fingerprint(submitted.change)), FINANCE)
    assert approved.change.state == changes_pb2.CHANGE_STATE_APPROVED
    assert approved.change.required_signatures[0].signed

    scheduled = await world.call("ScheduleChange", changes_pb2.ScheduleChangeRequest(change_id=change.id), MARKETING)
    assert scheduled.change.state == changes_pb2.CHANGE_STATE_SCHEDULED

    # 09:00 in Rome on 26 October is 08:00 UTC: the clocks went back the night before.
    world.clock.at = datetime(2026, 10, 26, 7, 58, tzinfo=UTC)
    assert await world.engine.activate_due() == []
    world.clock.at = datetime(2026, 10, 26, 7, 59, 30, tzinfo=UTC)
    [outcome] = await world.engine.activate_due()
    assert outcome.action == "activated", outcome

    before = await world.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT", at="2026-10-26T07:59:59Z"), PUBLIC)
    assert list(before.offers) == []
    world.clock.at = datetime(2026, 10, 26, 8, 0, tzinfo=UTC)
    listed = await world.call("ListOffers", catalog_pb2.ListOffersRequest(market="IT"), PUBLIC)
    [offer] = listed.offers
    assert (offer.offer_id, offer.price.amount_minor, offer.list_price.amount_minor) == (change.id, 299, 579)
    assert offer.takeable_until.local == "2026-11-30T00:00" and offer.takeable_until.utc == "2026-11-29T23:00:00Z"
    assert offer.audience == "Verified students in Italy who have never had a paid plan"

    quote = await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="student", market="IT", offer_id=change.id,
                                                                     subscriber_id=101), PUBLIC)
    q = quote.quote
    assert (q.price.amount_minor, q.months_at_price, q.then_price.amount_minor, q.list_price.amount_minor) == (299, 3, 579, 579)
    assert q.breakdown.top_up.amount_minor == 153 and q.breakdown.artists.amount_minor == 300

    actions = [e["action"] for e in await world.events()]
    assert actions == ["change.created", "change.validated", "change.submitted", "change.approved", "change.scheduled",
                       "change.activated", "catalog.published"]
