"""Campaigns that would reach the same people in the same period, in the same
non-combinability group (business book §6.1, §6.4, §10.3), never both get
through: not when they are validated at the same moment, and not at
scheduling or activation if they got past validation anyway."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from commerce.v1 import changes_pb2, common_pb2
from engine_support import FINANCE, LEAD, MARKETING, MARKETING_2, approved, create, family_rise, scheduled, student_autumn

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


async def past_validation_by_hand(world, content, who=MARKETING_2) -> changes_pb2.Change:
    """A second campaign moved along by the database's owner, as a validation
    race before this check, or a hand edit, could leave one."""
    change = await create(world, content, who)
    for state in ("validated", "in_approval"):
        await world.owner.execute("update change set state = $2 where id = $1", change.id, state)
    await world.owner.execute(
        "insert into approval (change_id, version, author, content_hash, approver, role, decided_at) "
        "select change_id, version, author, content_hash, 'finance-1', 'finance', $2 from change_version where change_id = $1",
        change.id, world.clock.now())
    await world.owner.execute("update change set state = 'approved' where id = $1", change.id)
    return change


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
