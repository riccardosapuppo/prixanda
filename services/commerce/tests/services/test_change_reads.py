"""GetChange, BatchGetChanges and ListChanges: what the console reads, in as
few round trips as the gateway's DataLoader needs."""

from __future__ import annotations

import pytest

from commerce.engine.errors import InvalidArgument, NotFound
from commerce.v1 import changes_pb2, common_pb2
from engine_support import AUDITOR, LEAD, MARKETING, ON_CALL, create, family_rise, student_autumn, submitted

STATE = changes_pb2


async def test_a_change_is_read_back_as_written(world):
    change = await submitted(world, student_autumn())
    read = (await world.call("GetChange", changes_pb2.GetChangeRequest(change_id=change.id), AUDITOR)).change
    assert read == change
    assert read.versions[0].offer == student_autumn()
    assert read.created_at == "2026-10-24T08:42:00Z" and read.created_by == "marketing-1"


async def test_an_unknown_change_is_not_found(world):
    with pytest.raises(NotFound):
        await world.call("GetChange", changes_pb2.GetChangeRequest(change_id=77), ON_CALL)


async def test_a_batch_keeps_the_order_asked_and_leaves_out_unknown_ids(world):
    a = await create(world, student_autumn(title="A"))
    b = await create(world, family_rise(title="B"), LEAD)
    c = await create(world, student_autumn(title="C"))
    response = await world.call("BatchGetChanges", changes_pb2.BatchGetChangesRequest(change_ids=[c.id, 999, a.id, c.id, b.id]))
    assert [x.title for x in response.changes] == ["C", "A", "B"]


async def test_a_batch_has_a_limit(world):
    with pytest.raises(InvalidArgument):
        await world.call("BatchGetChanges", changes_pb2.BatchGetChangesRequest(change_ids=list(range(1, 502))))


async def make_changes(world, count: int) -> list[int]:
    ids = []
    for n in range(count):
        world.clock.advance(minutes=1)
        ids.append((await create(world, student_autumn(title=f"Offer {n}"))).id)
    return ids


async def test_the_list_runs_newest_first_by_keyset(world):
    ids = await make_changes(world, 5)
    first = await world.call("ListChanges", changes_pb2.ListChangesRequest(page=common_pb2.PageRequest(size=2)))
    assert [c.id for c in first.changes] == ids[::-1][:2] and first.page.next
    second = await world.call("ListChanges", changes_pb2.ListChangesRequest(
        page=common_pb2.PageRequest(size=2, after=first.page.next)))
    third = await world.call("ListChanges", changes_pb2.ListChangesRequest(
        page=common_pb2.PageRequest(size=2, after=second.page.next)))
    assert [c.id for c in [*second.changes, *third.changes]] == ids[::-1][2:]
    assert third.page.next == ""
    summary = first.changes[0]
    assert summary.markets == ["IT"] and summary.updated_at == "2026-10-24T08:47:00Z"


async def test_the_list_filters_by_state_kind_and_market(world):
    offer = await submitted(world, student_autumn())
    price = await create(world, family_rise(), LEAD)
    in_approval = await world.call("ListChanges", changes_pb2.ListChangesRequest(states=[STATE.CHANGE_STATE_IN_APPROVAL]))
    assert [c.id for c in in_approval.changes] == [offer.id]
    prices = await world.call("ListChanges", changes_pb2.ListChangesRequest(kind=STATE.CHANGE_KIND_LIST_PRICE))
    assert [c.id for c in prices.changes] == [price.id]
    germany = await world.call("ListChanges", changes_pb2.ListChangesRequest(market="DE"))
    assert [c.id for c in germany.changes] == [price.id]
    nothing = await world.call("ListChanges", changes_pb2.ListChangesRequest(market="GB"))
    assert list(nothing.changes) == []


async def test_list_filters_and_cursors_that_mean_nothing(world):
    with pytest.raises(InvalidArgument):
        await world.call("ListChanges", changes_pb2.ListChangesRequest(page=common_pb2.PageRequest(after="not-a-cursor")))
    with pytest.raises(InvalidArgument):
        await world.call("ListChanges", changes_pb2.ListChangesRequest(states=[STATE.CHANGE_STATE_UNSPECIFIED]))
    with pytest.raises(NotFound):
        await world.call("ListChanges", changes_pb2.ListChangesRequest(market="ES"))


async def test_a_moved_change_comes_back_to_the_top(world):
    ids = await make_changes(world, 3)
    world.clock.advance(minutes=1)
    await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=ids[0], version=1))
    listed = await world.call("ListChanges", changes_pb2.ListChangesRequest())
    assert [c.id for c in listed.changes] == [ids[0], ids[2], ids[1]]
