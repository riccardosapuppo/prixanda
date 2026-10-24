"""ValidateChange, SubmitChange, ApproveChange and RejectChange (business book
§6.4, §6.5, §7.2, §7.3, §7.4): every refusal they give, and the database's
rules turned into the same answers."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest

from commerce.engine.changes import Changes
from commerce.engine.database import DatabaseError
from commerce.engine.errors import NotFound, Refused
from commerce.engine.records import ChangeRow
from commerce.v1 import changes_pb2, common_pb2
from engine_support import (
    AUDITOR, FINANCE, FINANCE_2, LEAD, MARKETING, MARKETING_2, create, family_rise, fingerprint, student_autumn, submitted,
    validated,
)

REFUSAL = common_pb2.RefusalCode
STATE = changes_pb2
LEAD_AND_FINANCE = ("lead-and-finance-1", "commercial_lead")
LEAD_AND_FINANCE_AS_FINANCE = ("lead-and-finance-1", "finance")


async def add_students(world, count: int) -> None:
    """Verified students in Italy who never paid, beyond the seeded one."""
    for n in range(count):
        subscriber = 1_000 + n
        await world.owner.execute("insert into subscriber (id, market, joined_on) values ($1, 'IT', '2026-01-10')", subscriber)
        await world.owner.execute(
            "insert into subscription (id, subscriber_id, market, currency, plan_id, paid, price_minor, started_on, billing_day) "
            "values ($1, $1, 'IT', 'EUR', 'free', false, 0, '2026-01-10', 10)", subscriber)
        await world.owner.execute("insert into student_verification (subscriber_id, verified_on, valid_until, provider) "
                                  "values ($1, '2026-09-01', '2027-09-01', 'simulated')", subscriber)


async def validate(world, change, who=MARKETING, version: int | None = None):
    return await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(
        change_id=change.id, version=version or change.current_version), who)


async def submit(world, change, who=MARKETING, reason: str = ""):
    return await world.call("SubmitChange", changes_pb2.SubmitChangeRequest(
        change_id=change.id, version=change.current_version, author_reason=reason), who)


async def approve(world, change, who=FINANCE, *, version: int | None = None, content_hash: bytes | None = None):
    return await world.call("ApproveChange", changes_pb2.ApproveChangeRequest(
        change_id=change.id, version=version or change.current_version,
        content_hash=content_hash if content_hash is not None else fingerprint(change)), who)


async def reject(world, change, who=FINANCE, reason: str = "Keep it to people who have never paid."):
    return await world.call("RejectChange", changes_pb2.RejectChangeRequest(
        change_id=change.id, version=change.current_version, reason=reason), who)


# -- ValidateChange --------------------------------------------------------------

async def test_a_failed_validation_is_refused_and_its_report_kept(world):
    change = await create(world, student_autumn(pages=[]), MARKETING)
    response = await validate(world, change)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_INVALID
    assert response.refusal.facts["checks"] == "page_text" and response.refusal.facts["blocking"] == "1"
    shown = (await world.call("GetChange", changes_pb2.GetChangeRequest(change_id=change.id), MARKETING)).change
    assert shown.state == STATE.CHANGE_STATE_DRAFT and not shown.validation.valid
    assert [f.check for f in shown.validation.findings if f.severity == STATE.SEVERITY_BLOCKING] == ["page_text"]
    assert shown.sentence.startswith("Italy, Student: from €5.79 to €2.99")
    assert await world.events("change.validated") == []


async def test_validation_counts_the_audience_in_the_data(world):
    await add_students(world, 9)
    change = (await validate(world, await create(world, student_autumn()))).change
    assert change.validation.eligible == 10 and "10 eligible" in change.sentence
    [event] = await world.events("change.validated")
    assert '"eligible": 10' in event["body"]


async def test_a_campaign_that_loses_money_needs_finance_and_a_reason(world):
    await add_students(world, 100)
    change = (await validate(world, await create(world, student_autumn()))).change
    [need] = change.required_signatures
    assert (need.role, list(need.conditions)) == (common_pb2.ROLE_FINANCE, [2, 4])
    refused = await submit(world, change, reason="")
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_REASON_REQUIRED
    sent = (await submit(world, change, reason="Students first: the pass pays back in its second year.")).change
    assert sent.state == STATE.CHANGE_STATE_IN_APPROVAL and sent.author_reason.startswith("Students first")
    [event] = await world.events("change.submitted")
    assert event["reason"].startswith("Students first")


async def test_a_conflict_with_an_offer_already_on_its_way_blocks(world):
    await submitted(world, student_autumn(title="Student Black Friday"), MARKETING)
    second = await create(world, student_autumn(), MARKETING_2)
    response = await validate(world, second, MARKETING_2)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_INVALID and "conflict" in response.refusal.facts["checks"]


async def test_a_start_that_has_passed_is_found(world):
    change = await create(world, student_autumn())
    world.clock.at = datetime(2026, 10, 27, 0, 0, tzinfo=UTC)
    response = await validate(world, change)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_INVALID and response.refusal.facts["checks"] == "dates"


async def test_a_list_price_always_needs_finance(world):
    change = (await validate(world, await create(world, family_rise(), LEAD), LEAD)).change
    assert [(s.role, list(s.conditions)) for s in change.required_signatures] == [(common_pb2.ROLE_FINANCE, [1])]
    assert change.validation.eligible == 1  # subscriber 203 is on Family in Germany
    assert "1 current subscribers keep their price" in change.sentence


async def test_validation_refusals(world):
    change = await create(world, student_autumn())
    assert (await validate(world, change, LEAD)).refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    assert (await validate(world, change, version=2)).refusal.code == REFUSAL.REFUSAL_CODE_STALE_VERSION
    await validate(world, change)
    assert (await validate(world, change)).refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE
    with pytest.raises(NotFound):
        await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=999, version=1), MARKETING)


# -- SubmitChange -------------------------------------------------------------------

async def test_submission_refusals(world):
    change = await create(world, student_autumn())
    assert (await submit(world, change)).refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE
    change = (await validate(world, change)).change
    assert (await submit(world, change, FINANCE)).refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    stale = await world.call("SubmitChange", changes_pb2.SubmitChangeRequest(change_id=change.id, version=7), MARKETING)
    assert stale.refusal.code == REFUSAL.REFUSAL_CODE_STALE_VERSION


async def test_a_start_that_passed_since_validation_is_caught_on_submission(world):
    change = await validated(world, student_autumn())
    world.clock.at = datetime(2026, 10, 26, 8, 0, tzinfo=UTC)  # 09:00 in Rome, the start
    response = await submit(world, change)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_INVALID and response.refusal.facts["market"] == "IT"


# -- ApproveChange -------------------------------------------------------------------

async def test_the_signature_names_the_version_and_its_fingerprint(world):
    change = await submitted(world, student_autumn())
    stale = await approve(world, change, version=2)
    assert stale.refusal.code == REFUSAL.REFUSAL_CODE_FINGERPRINT_MISMATCH
    forged = await approve(world, change, content_hash=b"\x01" * 32)
    assert forged.refusal.code == REFUSAL.REFUSAL_CODE_FINGERPRINT_MISMATCH
    assert forged.refusal.facts["fingerprint"] == fingerprint(change).hex()
    signed = (await approve(world, change)).change
    assert signed.state == STATE.CHANGE_STATE_APPROVED
    [approval] = signed.approvals
    assert (approval.approver, approval.role, approval.content_hash) == ("finance-1", common_pb2.ROLE_FINANCE, fingerprint(change))


async def test_nobody_signs_a_change_they_wrote(world):
    # A person who holds both signing roles writes a list price as the
    # commercial lead, then tries to sign it as finance.
    change = await submitted(world, family_rise(), LEAD_AND_FINANCE)
    response = await approve(world, change, LEAD_AND_FINANCE_AS_FINANCE)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_OWN_VERSION


async def test_writing_any_version_bars_the_signature(world):
    change = await create(world, family_rise(), LEAD_AND_FINANCE)
    edited = await world.call("SaveVersion", changes_pb2.SaveVersionRequest(
        change_id=change.id, base_version=1, list_price=family_rise(title="Family price, Germany, from December")), LEAD)
    change = (await validate(world, edited.change, LEAD)).change
    change = (await submit(world, change, LEAD)).change
    # Version 2 is the commercial lead's; version 1 was the other person's, who still may not sign.
    assert (await approve(world, change, LEAD_AND_FINANCE_AS_FINANCE)).refusal.code == REFUSAL.REFUSAL_CODE_OWN_VERSION
    assert (await approve(world, change, FINANCE)).change.state == STATE.CHANGE_STATE_APPROVED


async def test_only_the_roles_the_version_needs_sign(world):
    change = await submitted(world, student_autumn())
    assert (await approve(world, change, MARKETING_2)).refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    assert (await approve(world, change, AUDITOR)).refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    # Below the floor: finance must sign, the commercial lead's signature is not the one needed.
    needs_finance = await approve(world, change, LEAD)
    assert needs_finance.refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    assert needs_finance.refusal.facts["needs"] == "finance"


async def test_an_offer_above_the_floor_may_be_signed_by_the_commercial_lead(world):
    content = student_autumn(plan="individual", audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_NEVER_PAID),
                             prices=[changes_pb2.OfferPrice(market="IT", fixed=common_pb2.Money(amount_minor=899, currency="EUR"))])
    change = await submitted(world, content)
    assert [s.role for s in change.required_signatures] == [common_pb2.ROLE_COMMERCIAL_LEAD]
    signed = (await approve(world, change, LEAD)).change
    assert signed.state == STATE.CHANGE_STATE_APPROVED and signed.required_signatures[0].signed


async def test_two_signatures_at_once_approve_once(world):
    change = await submitted(world, student_autumn())
    first, second = await asyncio.gather(approve(world, change, FINANCE), approve(world, change, FINANCE_2))
    outcomes = sorted([first.WhichOneof("outcome"), second.WhichOneof("outcome")])
    assert outcomes == ["change", "refusal"]
    refused = first if first.WhichOneof("outcome") == "refusal" else second
    assert refused.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE
    assert await world.owner.fetchval("select count(*) from approval where change_id = $1", change.id) == 1


async def test_a_change_not_in_approval_is_not_signed(world):
    change = await validated(world, student_autumn())
    assert (await approve(world, change)).refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE


@pytest.mark.parametrize(("sqlstate", "code"), [("23505", "ALREADY_SIGNED"), ("23514", "OWN_VERSION"),
                                                ("23503", "ROLE_NOT_ALLOWED"), ("RL003", "WRONG_STATE")])
def test_the_database_s_refusals_of_a_signature_become_answers(sqlstate, code):
    change = ChangeRow(1, "offer", "x", "in_approval", None, 3, "marketing-1")
    translated = Changes._approval_refusal(DatabaseError(sqlstate, "refused"), change)
    assert isinstance(translated, Refused) and translated.code == code


def test_any_other_database_error_stays_an_error():
    error = DatabaseError("XX000", "internal")
    assert Changes._approval_refusal(error, ChangeRow(1, "offer", "x", "in_approval", None, 1, "m")) is error


# -- RejectChange --------------------------------------------------------------------

async def test_a_rejection_sends_the_change_back_with_its_reason(world):
    change = await submitted(world, student_autumn())
    back = (await reject(world, change)).change
    assert back.state == STATE.CHANGE_STATE_DRAFT and back.state_reason == "Keep it to people who have never paid."
    [event] = await world.events("change.rejected")
    assert event["reason"] == "Keep it to people who have never paid." and event["actor"] == "finance-1"
    again = (await validate(world, back)).change
    assert again.state == STATE.CHANGE_STATE_VALIDATED and again.state_reason == ""


async def test_rejection_refusals(world):
    change = await submitted(world, student_autumn())
    assert (await reject(world, change, reason="   ")).refusal.code == REFUSAL.REFUSAL_CODE_REASON_REQUIRED
    assert (await reject(world, change, MARKETING_2)).refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    stale = await world.call("RejectChange", changes_pb2.RejectChangeRequest(change_id=change.id, version=9, reason="x"), FINANCE)
    assert stale.refusal.code == REFUSAL.REFUSAL_CODE_STALE_VERSION
    own = await submitted(world, family_rise(), LEAD_AND_FINANCE)
    assert (await reject(world, own, LEAD_AND_FINANCE_AS_FINANCE)).refusal.code == REFUSAL.REFUSAL_CODE_OWN_VERSION
    draft = await create(world, student_autumn(title="A draft"))
    assert (await reject(world, draft)).refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE


async def test_a_refusal_writes_nothing(world):
    change = await submitted(world, student_autumn())
    before = await world.owner.fetchval("select count(*) from audit_event")
    await approve(world, change, LEAD)
    await reject(world, change, reason="")
    assert await world.owner.fetchval("select count(*) from audit_event") == before
    assert await world.owner.fetchval("select state from change where id = $1", change.id) == "in_approval"


async def test_a_state_moved_by_hand_in_the_database_does_not_skip_the_review(world):
    # The database lets its owner move a draft along without a validation; the
    # engine still asks for a passing validation before a submission, and for
    # a report to sign against before an approval.
    change = await create(world, student_autumn())
    await world.owner.execute("update change set state = 'validated' where id = $1", change.id)
    response = await submit(world, change)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and "no passing validation" in response.refusal.reason
    await world.owner.execute("update change set state = 'in_approval' where id = $1", change.id)
    response = await approve(world, change)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_WRONG_STATE and "no validation" in response.refusal.reason
