"""Idempotency keys (migration V7): the same key with the same request gives
the same outcome, refusals included, without doing the work twice; the same
key with another request is refused; a call that failed records nothing; and
the keys of calls finished a week ago are pruned (V11)."""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest

from commerce.engine.errors import InvalidArgument, NotFound
from commerce.v1 import changes_pb2, common_pb2, quotes_pb2
from engine_support import FINANCE, LEAD, MARKETING, MARKETING_2, PUBLIC, new_key, student_autumn

REFUSAL = common_pb2.RefusalCode


def create_request(**changes) -> changes_pb2.CreateChangeRequest:
    return changes_pb2.CreateChangeRequest(offer=student_autumn(**changes))


async def test_a_repeated_call_returns_the_first_outcome_and_does_the_work_once(world):
    key = new_key()
    first = await world.call("CreateChange", create_request(), MARKETING, key=key)
    world.clock.advance(minutes=5)
    again = await world.call("CreateChange", create_request(), MARKETING, key=key)
    assert again == first
    assert await world.owner.fetchval("select count(*) from change") == 1
    assert len(await world.events("change.created")) == 1
    row = await world.owner.fetchrow("select outcome, method from idempotent_call where key = $1", key)
    assert (row["outcome"], row["method"]) == ("answer", "commerce.v1.ChangeService/CreateChange")


async def test_a_refusal_is_an_outcome_and_comes_back_the_same(world):
    key = new_key()
    first = await world.call("CreateChange", create_request(), FINANCE, key=key)
    assert first.refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    again = await world.call("CreateChange", create_request(), FINANCE, key=key)
    assert again == first
    assert await world.owner.fetchval("select outcome from idempotent_call where key = $1", key) == "refusal"


async def test_a_key_is_bound_to_its_request_and_its_method(world):
    key = new_key()
    await world.call("CreateChange", create_request(), MARKETING, key=key)
    with pytest.raises(InvalidArgument):
        await world.call("CreateChange", create_request(title="Another offer"), MARKETING, key=key)
    change_id = await world.owner.fetchval("select id from change")
    with pytest.raises(InvalidArgument):
        await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=change_id, version=1), MARKETING, key=key)
    assert await world.owner.fetchval("select count(*) from change") == 1


async def test_a_key_belongs_to_whoever_sent_it(world):
    key = new_key()
    mine = await world.call("CreateChange", create_request(), MARKETING, key=key)
    theirs = await world.call("CreateChange", create_request(), MARKETING_2, key=key)
    assert mine.change.id != theirs.change.id


async def test_the_role_is_part_of_the_request(world):
    key = new_key()
    as_lead = ("lead-and-finance-1", "commercial_lead")
    await world.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn()), as_lead, key=key)
    with pytest.raises(InvalidArgument):
        await world.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn()),
                         ("lead-and-finance-1", "finance"), key=key)


async def test_a_failed_call_records_nothing_and_can_be_retried(world):
    key = new_key()
    request = changes_pb2.SaveVersionRequest(change_id=1, base_version=1, offer=student_autumn())
    with pytest.raises(NotFound):
        await world.call("SaveVersion", request, MARKETING, key=key)
    assert await world.owner.fetchval("select count(*) from idempotent_call") == 0
    created = await world.call("CreateChange", create_request(), MARKETING)
    assert created.change.id == 1
    saved = await world.call("SaveVersion", request, MARKETING, key=key)
    assert saved.change.current_version == 2


async def test_the_same_call_twice_at_once_is_done_once(world):
    key = new_key()
    first, second = await asyncio.gather(
        world.call("CreateChange", create_request(), MARKETING, key=key),
        world.call("CreateChange", create_request(), MARKETING, key=key))
    assert first == second
    assert await world.owner.fetchval("select count(*) from change") == 1


async def test_a_public_quote_with_a_key_is_the_same_quote(world):
    key = new_key()
    request = quotes_pb2.GetQuoteRequest(plan="individual", market="FR")
    first = await world.call("GetQuote", request, PUBLIC, key=key)
    world.clock.advance(minutes=1)
    again = await world.call("GetQuote", request, PUBLIC, key=key)
    assert again.quote.quote_id == first.quote.quote_id
    assert await world.owner.fetchval("select count(*) from quote") == 1
    assert await world.owner.fetchval("select scope from idempotent_call") == "(public)"
    other = await world.call("GetQuote", request, LEAD, key=key)
    assert other.quote.quote_id != first.quote.quote_id


async def test_the_keys_of_calls_finished_a_week_ago_are_pruned(world):
    old, recent = new_key(), new_key()
    first = await world.call("CreateChange", create_request(), MARKETING, key=old)
    world.clock.advance(days=6)
    await world.call("CreateChange", create_request(title="Student Winter Pass"), MARKETING, key=recent)
    # A call still running, as a stop of the engine in the middle of it would leave its claim.
    await world.owner.execute(
        "insert into idempotent_call (scope, key, method, request_hash, started_at, request_id) "
        "values ('marketing-1', 'key-still-running-1', 'commerce.v1.ChangeService/CreateChange', $1, $2, 'req-00000001')",
        bytes(32), world.clock.now() - timedelta(days=30))
    world.clock.advance(days=2)  # eight days after the first call, two after the recent one
    assert await world.engine.prune_idempotency_keys() == 1
    left = {r["key"] for r in await world.owner.fetch("select key from idempotent_call")}
    assert left == {recent, "key-still-running-1"}
    # What a week is for: a retry with a pruned key is a new call, and does the work again.
    again = await world.call("CreateChange", create_request(), MARKETING, key=old)
    assert again.change.id != first.change.id
    assert await world.engine.prune_idempotency_keys() == 0
