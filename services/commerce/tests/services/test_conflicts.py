"""Campaigns that would reach the same people in the same period, in the same
non-combinability group (business book §6.1, §6.4, §10.3), never both get
through: not when they are validated at the same moment, and not at
scheduling or activation if they got past validation anyway. Campaigns for
listeners of different artists reach the same people when someone is in both
audiences, and every check counts them."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest

from commerce.v1 import changes_pb2, common_pb2
from engine_support import (
    FINANCE, LEAD, MARKETING, MARKETING_2, approved, create, family_rise, nordflur, past_validation_by_hand, scheduled,
    student_autumn,
)

REFUSAL = common_pb2.RefusalCode


async def validate(world, change, who=MARKETING):
    return await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(
        change_id=change.id, version=change.current_version), who)


def meet_after_reading(world, monkeypatch, wait: float = 1.0) -> None:
    """Holds each validation, once it has read the other changes, until the other
    validation has read them too (or the wait runs out). Without a lock between
    them, both read the other as a draft before either writes."""
    original = world.engine.changes._context
    arrived = {"count": 0}
    both = asyncio.Event()

    async def read_then_meet(*args, **kwargs):
        context = await original(*args, **kwargs)
        arrived["count"] += 1
        if arrived["count"] >= 2:
            both.set()
        try:
            await asyncio.wait_for(both.wait(), wait)
        except TimeoutError:
            pass  # the other validation is waiting for this one to finish
        return context

    monkeypatch.setattr(world.engine.changes, "_context", read_then_meet)


async def test_two_conflicting_campaigns_validated_at_the_same_moment_let_one_through(world, monkeypatch):
    first = await create(world, student_autumn(title="Student Autumn Pass"))
    second = await create(world, student_autumn(title="Student Black Friday"), MARKETING_2)
    meet_after_reading(world, monkeypatch)
    one, two = await asyncio.gather(validate(world, first), validate(world, second, MARKETING_2))
    assert sorted([one.WhichOneof("outcome"), two.WhichOneof("outcome")]) == ["change", "refusal"]
    refused = one if one.WhichOneof("outcome") == "refusal" else two
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_INVALID and "conflict" in refused.refusal.facts["checks"]
    assert await world.owner.fetchval("select count(*) from change where state = 'validated'") == 1


async def test_campaigns_in_different_groups_are_validated_at_the_same_moment(world, monkeypatch):
    first = await create(world, student_autumn(title="Student Autumn Pass"))
    second = await create(world, student_autumn(title="Autumn gift", non_combinability_group="gift-offers"), MARKETING_2)
    meet_after_reading(world, monkeypatch, wait=5.0)
    one, two = await asyncio.gather(validate(world, first), validate(world, second, MARKETING_2))
    assert one.WhichOneof("outcome") == two.WhichOneof("outcome") == "change"


async def test_scheduling_checks_the_conflict_again(world):
    await scheduled(world, student_autumn(title="Student Autumn Pass"), MARKETING, FINANCE)
    second = await past_validation_by_hand(world, student_autumn(title="Student Black Friday"))
    response = await world.call("ScheduleChange", changes_pb2.ScheduleChangeRequest(change_id=second.id), MARKETING_2)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_INVALID
    assert response.refusal.facts["check"] == "conflict" and response.refusal.facts["market"] == "IT"
    assert "Student Autumn Pass" in response.refusal.reason
    assert await world.owner.fetchval("select state from change where id = $1", second.id) == "approved"


async def test_activation_checks_the_conflict_again_and_leaves_the_later_one_off_the_site(world):
    first = await scheduled(world, student_autumn(title="Student Autumn Pass"), MARKETING, FINANCE)
    second = await past_validation_by_hand(world, student_autumn(title="Student Black Friday"))
    await world.owner.execute("update change set state = 'scheduled' where id = $1", second.id)
    world.clock.at = datetime(2026, 10, 26, 7, 59, 30, tzinfo=UTC)
    outcomes = {o.change_id: o for o in await world.engine.activate_due()}
    assert outcomes[first.id].action == "activated"
    assert outcomes[second.id].action == "refused" and "Student Autumn Pass" in outcomes[second.id].error
    states = {r["id"]: r["state"] for r in await world.owner.fetch("select id, state from change")}
    assert (states[first.id], states[second.id]) == ("active", "scheduled")
    live = await world.owner.fetchval(
        "select count(*) from catalog_offer where snapshot_id = (select snapshot_id from catalog_publication "
        "order by seq desc limit 1) and change_id = $1", second.id)
    assert live == 0


async def test_a_campaign_with_no_clash_still_schedules(world):
    await scheduled(world, student_autumn(title="Student Autumn Pass"), MARKETING, FINANCE)
    other = await approved(world, student_autumn(title="Autumn gift", non_combinability_group="gift-offers"),
                           MARKETING_2, FINANCE)
    response = await world.call("ScheduleChange", changes_pb2.ScheduleChangeRequest(change_id=other.id), MARKETING_2)
    assert response.change.state == changes_pb2.CHANGE_STATE_SCHEDULED


async def test_two_changes_of_one_list_price_validated_at_the_same_moment_let_one_through(world, monkeypatch):
    first = await create(world, family_rise(), LEAD)
    second = await create(world, family_rise(title="Family price, Germany, rounder", amount=common_pb2.Money(
        amount_minor=1_999, currency="EUR")), LEAD)
    meet_after_reading(world, monkeypatch)
    one, two = await asyncio.gather(validate(world, first, LEAD), validate(world, second, LEAD))
    assert sorted([one.WhichOneof("outcome"), two.WhichOneof("outcome")]) == ["change", "refusal"]
    refused = one if one.WhichOneof("outcome") == "refusal" else two
    assert "overlap" in refused.refusal.facts["checks"]


async def test_scheduling_a_list_price_meets_another_already_on_its_way(world):
    await scheduled(world, family_rise(), LEAD, FINANCE)
    second = await past_validation_by_hand(world, family_rise(title="Family price, Germany, rounder", amount=common_pb2.Money(
        amount_minor=1_999, currency="EUR"), starts_local="2027-02-01T00:00"), LEAD)
    response = await world.call("ScheduleChange", changes_pb2.ScheduleChangeRequest(change_id=second.id), LEAD)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_OVERLAP and "only one of them" in response.refusal.reason


HALDE = 7


def release_for(artist: int, title: str, seconds: int) -> changes_pb2.OfferContent:
    """A release campaign in Germany for Free listeners of one artist, in the group release-offers."""
    return nordflur(title=title, audience=changes_pb2.Audience(
        segment=changes_pb2.SEGMENT_FREE_LISTENERS,
        listening=changes_pb2.ListeningRule(artist_id=artist, min_seconds=seconds, within_days=30)))


async def listen(world, subscriber: int, artist: int, days: int, seconds: int) -> None:
    for day in range(days):
        await world.owner.execute("insert into listening_day (subscriber_id, artist_id, day, seconds) values ($1, $2, $3, $4)",
                                  subscriber, artist, datetime(2026, 10, 10 + day).date(), seconds)


async def test_campaigns_for_two_artists_clash_when_someone_listens_to_both(world):
    # 201 has 7 hours of Doppelfenster this month; now also 2 hours of Halde, above both thresholds.
    await listen(world, 201, HALDE, 2, 3_600)
    first = await create(world, release_for(4, "Nordflur release", 10_800))
    assert (await validate(world, first)).change.state == changes_pb2.CHANGE_STATE_VALIDATED
    second = await create(world, release_for(HALDE, "Abraum release", 3_600), MARKETING_2)
    response = await validate(world, second, MARKETING_2)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_INVALID and response.refusal.facts["checks"] == "conflict"
    assert response.refusal.facts["shared"] == "1"
    report = (await world.call("GetChange", changes_pb2.GetChangeRequest(change_id=second.id), MARKETING_2)).change.validation
    [finding] = [f for f in report.findings if f.check == "conflict"]
    assert finding.facts["shared"] == "1" and "1 person" in finding.message


async def test_campaigns_for_two_artists_with_nobody_in_both_do_not_clash(world):
    await listen(world, 202, HALDE, 2, 3_600)  # 202 listens to Halde, but has 2 hours of Doppelfenster only
    first = await create(world, release_for(4, "Nordflur release", 10_800))
    await validate(world, first)
    second = await create(world, release_for(HALDE, "Abraum release", 3_600), MARKETING_2)
    assert (await validate(world, second, MARKETING_2)).change.state == changes_pb2.CHANGE_STATE_VALIDATED


@pytest.mark.parametrize(("listener", "clash"), [(201, True), (202, False)])
async def test_scheduling_counts_the_people_in_both_audiences_again(world, listener, clash):
    await scheduled(world, release_for(4, "Nordflur release", 10_800))
    second = await past_validation_by_hand(world, release_for(HALDE, "Abraum release", 3_600))
    await listen(world, listener, HALDE, 2, 3_600)
    response = await world.call("ScheduleChange", changes_pb2.ScheduleChangeRequest(change_id=second.id), MARKETING_2)
    if clash:
        assert response.refusal.code == REFUSAL.REFUSAL_CODE_INVALID
        assert (response.refusal.facts["check"], response.refusal.facts["shared"]) == ("conflict", "1")
        assert "1 person is in both audiences" in response.refusal.reason
    else:
        assert response.change.state == changes_pb2.CHANGE_STATE_SCHEDULED


async def test_activation_counts_the_people_in_both_audiences_again(world):
    first = await scheduled(world, release_for(4, "Nordflur release", 10_800))
    second = await past_validation_by_hand(world, release_for(HALDE, "Abraum release", 3_600))
    await world.owner.execute("update change set state = 'scheduled' where id = $1", second.id)
    await listen(world, 201, HALDE, 2, 3_600)
    world.clock.at = datetime(2026, 11, 5, 22, 59, 30, tzinfo=UTC)  # half a minute before midnight in Berlin
    outcomes = {o.change_id: o for o in await world.engine.activate_due()}
    assert outcomes[first.id].action == "activated"
    assert outcomes[second.id].action == "refused" and "1 person is in both audiences" in outcomes[second.id].error
