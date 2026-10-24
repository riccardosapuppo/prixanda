"""Who may call at all, before any rule (business book §7.4): a person who
exists and holds the role they act in; no person only on the public methods;
an idempotency key on every call that changes something."""

from __future__ import annotations

import pytest

from commerce.engine.call import Call
from commerce.engine.engine import METHODS
from commerce.engine.errors import InvalidArgument, PermissionDenied
from commerce.v1 import catalog_pb2, changes_pb2, overview_pb2
from engine_support import AUDITOR, FINANCE, MARKETING, PUBLIC, new_key, request_id, student_autumn

# No person of the team: the site's catalog and quotes, the list of people, and
# the subscriber's calls, whose subscriber the gateway takes from the site's session.
PUBLIC_METHODS = {"ListPeople", "ListMarkets", "ListPlans", "GetPriceList", "ListOffers", "GetQuote",
                  "ListDemoListeners", "VerifyStudent", "ConfirmQuote", "GetAccount"}
WRITING_METHODS = {"CreateChange", "SaveVersion", "ValidateChange", "SubmitChange", "ApproveChange", "RejectChange",
                   "ScheduleChange", "CancelChange", "SuspendChange", "GetQuote", "ExportHead", "VerifyStudent",
                   "ConfirmQuote"}


def test_the_public_methods_are_the_ones_agreed_with_the_gateway():
    assert {m.name for m in METHODS.values() if m.public} == PUBLIC_METHODS
    assert {m.name for m in METHODS.values() if m.writes} == WRITING_METHODS


async def test_a_method_for_a_person_refuses_a_call_without_one(world):
    with pytest.raises(PermissionDenied):
        await world.call("GetOverview", overview_pb2.GetOverviewRequest(), PUBLIC)
    with pytest.raises(PermissionDenied):
        await world.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn()), PUBLIC)


@pytest.mark.parametrize("who", [("nobody-here", "marketing"), ("finance-1", "marketing"), ("auditor-1", "finance")])
async def test_the_person_must_exist_and_hold_the_role_they_act_in(world, who):
    with pytest.raises(PermissionDenied):
        await world.call("GetOverview", overview_pb2.GetOverviewRequest(), who)


async def test_a_public_method_checks_a_person_when_one_is_named(world):
    assert (await world.call("ListMarkets", catalog_pb2.ListMarketsRequest(), PUBLIC)).markets
    assert (await world.call("ListMarkets", catalog_pb2.ListMarketsRequest(), AUDITOR)).markets
    with pytest.raises(PermissionDenied):
        await world.call("ListMarkets", catalog_pb2.ListMarketsRequest(), ("finance-1", "auditor"))


@pytest.mark.parametrize(("actor", "role"), [("marketing-1", None), (None, "marketing"), ("Marketing 1", "marketing"),
                                             ("marketing-1", "ROLE_MARKETING"), ("marketing-1", "admin")])
def test_an_identity_comes_whole_and_in_the_book_s_names(actor, role):
    with pytest.raises(PermissionDenied):
        Call(request_id="req-00000001", actor=actor, role=role)


@pytest.mark.parametrize("value", ["short", "-starts-badly", "has space-1234", "x" * 101, "über-123456"])
def test_request_ids_and_keys_have_the_agreed_shape(value):
    with pytest.raises(InvalidArgument):
        Call(request_id=value)
    with pytest.raises(InvalidArgument):
        Call(request_id="req-00000001", idempotency_key=value)
    assert Call(request_id="7f3a9c1e-2b44-4f0e-9d1a-6c5b8e2f0a11", idempotency_key="a" * 100).scope == "(public)"


async def test_a_call_that_changes_something_needs_an_idempotency_key(world):
    spec = METHODS["commerce.v1.ChangeService/CreateChange"]
    call = Call(request_id=request_id(), actor="marketing-1", role="marketing")
    with pytest.raises(InvalidArgument):
        await world.engine.handle(spec.full_name, call, changes_pb2.CreateChangeRequest(offer=student_autumn()))
    assert await world.owner.fetchval("select count(*) from change") == 0


async def test_a_read_takes_a_key_without_recording_it(world):
    response = await world.call("ListPlans", catalog_pb2.ListPlansRequest(market="IT"), FINANCE, key=new_key())
    assert response.plans
    assert await world.owner.fetchval("select count(*) from idempotent_call") == 0


async def test_an_unknown_method_or_the_wrong_request_is_malformed(world):
    call = Call(request_id=request_id(), actor="marketing-1", role="marketing")
    with pytest.raises(InvalidArgument):
        await world.engine.handle("commerce.v1.ChangeService/DeleteChange", call, changes_pb2.GetChangeRequest())
    with pytest.raises(InvalidArgument):
        await world.engine.handle("commerce.v1.ChangeService/GetChange", call, changes_pb2.ListChangesRequest())


async def test_the_request_id_and_the_person_reach_the_audit_log(world):
    await world.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn()), MARKETING,
                     request_id_="console-7f3a9c1e")
    [event] = await world.events("change.created")
    assert (event["actor"], event["actor_role"], event["request_id"]) == ("marketing-1", "marketing", "console-7f3a9c1e")
