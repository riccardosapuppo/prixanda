"""CreateChange and SaveVersion (business book §6.1, §6.3, §7.2): who writes
which kind of change, what a version may not hold, and nobody silently
overwriting a colleague."""

from __future__ import annotations

import asyncio

import pytest

from commerce.engine.errors import InvalidArgument, NotFound
from commerce.v1 import changes_pb2, common_pb2
from engine_support import (
    AUDITOR, FINANCE, LEAD, MARKETING, MARKETING_2, approved, create, eur, family_rise, gbp, scheduled, student_autumn,
)

KIND_OFFER, KIND_PRICE = changes_pb2.CHANGE_KIND_OFFER, changes_pb2.CHANGE_KIND_LIST_PRICE
REFUSAL = common_pb2.RefusalCode


async def test_marketing_creates_an_offer_and_the_commercial_lead_a_list_price(world):
    offer = await create(world, student_autumn(), MARKETING)
    price = await create(world, family_rise(), LEAD)
    assert (offer.kind, offer.state, offer.created_by, offer.title) == (KIND_OFFER, changes_pb2.CHANGE_STATE_DRAFT,
                                                                         "marketing-1", "Student Autumn Pass")
    assert price.kind == KIND_PRICE and price.versions[0].list_price.amount.amount_minor == 2_099
    stored = offer.versions[0]
    assert stored.offer == student_autumn() and len(stored.content_hash) == 32 and stored.author == "marketing-1"


@pytest.mark.parametrize(("content", "who"), [
    ({"list_price": family_rise()}, MARKETING), ({"offer": student_autumn()}, LEAD),
    ({"offer": student_autumn()}, FINANCE), ({"list_price": family_rise()}, AUDITOR),
])
async def test_each_kind_has_its_author_role(world, content, who):
    response = await world.call("CreateChange", changes_pb2.CreateChangeRequest(**content), who)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    assert await world.owner.fetchval("select count(*) from change") == 0


@pytest.mark.parametrize("changes", [
    {"title": "  "},
    {"plan": "platinum"},
    {"prices": [changes_pb2.OfferPrice(market="XX", fixed=eur(299))]},
    {"prices": [changes_pb2.OfferPrice(market="IT", fixed=gbp(299))]},
    {"prices": [changes_pb2.OfferPrice(market="IT", fixed=eur(-1))]},
    {"prices": [changes_pb2.OfferPrice(market="IT", percent_off_bp=10_000)]},
    {"prices": [changes_pb2.OfferPrice(market="IT")]},
    {"prices": [changes_pb2.OfferPrice(market="IT", fixed=eur(299)), changes_pb2.OfferPrice(market="IT", fixed=eur(199))]},
    {"periods": [changes_pb2.OfferPeriod(market="IT", starts_local="26/10/2026 09:00")]},
    {"periods": [changes_pb2.OfferPeriod(market="IT", starts_local="2026-10-26T09:00+01:00")]},
    {"periods": [changes_pb2.OfferPeriod(market="IT")]},
    {"audience": changes_pb2.Audience(segment=changes_pb2.SEGMENT_FREE_LISTENERS,
                                      listening=changes_pb2.ListeningRule(artist_id=999, min_seconds=60, within_days=30))},
    {"audience": changes_pb2.Audience(segment=changes_pb2.SEGMENT_SUBSCRIBERS_OF_PLAN, current_plan="free")},
    {"non_combinability_group": "Student Offers"},
    {"months_at_offer_price": 37},
    {"redemption_cap": -1},
    {"pages": [changes_pb2.OfferPage(market="IT", title="x" * 121)]},
])
async def test_a_version_that_cannot_mean_anything_is_malformed(world, changes):
    with pytest.raises(InvalidArgument):
        await world.call("CreateChange", changes_pb2.CreateChangeRequest(offer=student_autumn(**changes)), MARKETING)
    assert await world.owner.fetchval("select count(*) from change") == 0


async def test_a_change_needs_content(world):
    with pytest.raises(InvalidArgument):
        await world.call("CreateChange", changes_pb2.CreateChangeRequest(), MARKETING)


async def test_an_incomplete_draft_is_saved_and_left_for_validation_to_judge(world):
    draft = await create(world, changes_pb2.OfferContent(title="An idea for spring"), MARKETING)
    assert draft.state == changes_pb2.CHANGE_STATE_DRAFT and not draft.versions[0].offer.prices


@pytest.mark.parametrize(("local", "kind"), [("2026-10-25T02:30", "repeated"), ("2027-03-28T02:30", "skipped")])
async def test_a_local_time_the_clocks_skip_or_repeat_is_refused(world, local, kind):
    content = student_autumn(periods=[changes_pb2.OfferPeriod(market="IT", starts_local=local)])
    response = await world.call("CreateChange", changes_pb2.CreateChangeRequest(offer=content), MARKETING)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_AMBIGUOUS_LOCAL_TIME
    assert response.refusal.facts["kind"] == kind and response.refusal.facts["zone"] == "Europe/Rome"
    price = family_rise(starts_local="2026-10-25T02:15")
    refused = await world.call("CreateChange", changes_pb2.CreateChangeRequest(list_price=price), LEAD)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_AMBIGUOUS_LOCAL_TIME


async def save(world, change_id: int, base: int, content, who=MARKETING):
    return await world.call("SaveVersion", changes_pb2.SaveVersionRequest(change_id=change_id, base_version=base, offer=content), who)


async def test_a_new_version_follows_the_one_it_started_from(world):
    change = await create(world, student_autumn(), MARKETING)
    saved = await save(world, change.id, 1, student_autumn(title="Student Autumn Pass 2026"), MARKETING_2)
    assert saved.change.current_version == 2 and saved.change.title == "Student Autumn Pass 2026"
    assert [v.author for v in saved.change.versions] == ["marketing-1", "marketing-2"]
    [event] = await world.events("change.version_saved")
    assert event["actor"] == "marketing-2" and '"version": 2' in event["body"]


async def test_saving_over_a_superseded_version_is_refused_with_the_newer_one(world):
    change = await create(world, student_autumn(), MARKETING)
    await save(world, change.id, 1, student_autumn(title="Edited by a colleague"), MARKETING_2)
    stale = await save(world, change.id, 1, student_autumn(title="My edit"), MARKETING)
    assert stale.refusal.code == REFUSAL.REFUSAL_CODE_STALE_VERSION
    assert stale.refusal.facts["newer_version"] == "2" and stale.refusal.facts["saved_by"] == "marketing-2"
    current = await world.call("GetChange", changes_pb2.GetChangeRequest(change_id=change.id), MARKETING)
    assert current.change.title == "Edited by a colleague"


async def test_two_saves_from_the_same_version_at_once_keep_one(world):
    change = await create(world, student_autumn(), MARKETING)
    first, second = await asyncio.gather(
        save(world, change.id, 1, student_autumn(title="One"), MARKETING),
        save(world, change.id, 1, student_autumn(title="Two"), MARKETING_2))
    outcomes = sorted([first.WhichOneof("outcome"), second.WhichOneof("outcome")])
    assert outcomes == ["change", "refusal"]
    refused = first if first.WhichOneof("outcome") == "refusal" else second
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_STALE_VERSION
    assert await world.owner.fetchval("select count(*) from change_version where change_id = $1", change.id) == 2


async def test_a_new_version_voids_the_approval_of_the_old_one(world):
    change = await approved(world, student_autumn(), MARKETING, FINANCE)
    assert change.state == changes_pb2.CHANGE_STATE_APPROVED
    saved = await save(world, change.id, 1, student_autumn(title="Student Autumn Pass, longer"), MARKETING)
    assert saved.change.state == changes_pb2.CHANGE_STATE_DRAFT and saved.change.current_version == 2
    assert not saved.change.required_signatures and not saved.change.HasField("validation")
    assert [a.version for a in saved.change.approvals] == [1]


async def test_a_scheduled_change_takes_no_new_version(world):
    change = await scheduled(world, student_autumn(), MARKETING, FINANCE)
    refused = await save(world, change.id, 1, student_autumn(title="Too late"), MARKETING)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE


async def test_a_version_keeps_the_kind_and_the_author_role_of_its_change(world):
    change = await create(world, student_autumn(), MARKETING)
    with pytest.raises(InvalidArgument):
        await world.call("SaveVersion", changes_pb2.SaveVersionRequest(change_id=change.id, base_version=1,
                                                                        list_price=family_rise()), MARKETING)
    refused = await save(world, change.id, 1, student_autumn(), LEAD)
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    with pytest.raises(InvalidArgument):
        await save(world, change.id, 0, student_autumn(), MARKETING)


async def test_saving_a_change_that_does_not_exist(world):
    with pytest.raises(NotFound):
        await save(world, 4_242, 1, student_autumn(), MARKETING)
