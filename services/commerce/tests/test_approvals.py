"""Separation of duties and approvals bound to one version (business book
§7.2, §7.4), enforced by the database whatever the engine does."""

from __future__ import annotations

from helpers import add_people, approve, move, new_change, new_version, sqlstate_of


async def in_approval(db, author: str = "marketing-1") -> int:
    await add_people(db.owner)
    change = await new_change(db.app, author=author)
    await move(db.app, change, "validated", "in_approval")
    return change


async def test_the_author_cannot_approve_their_own_version(db):
    change = await in_approval(db, author="lead-and-finance-1")
    assert await sqlstate_of(approve(db.app, change, "lead-and-finance-1", "finance")) == "23514"


async def test_the_approver_holds_the_role_they_sign_with(db):
    change = await in_approval(db)
    assert await sqlstate_of(approve(db.app, change, "commercial-lead-1", "finance")) == "23503"


async def test_only_the_commercial_lead_and_finance_sign(db):
    change = await in_approval(db)
    assert await sqlstate_of(approve(db.app, change, "marketing-2", "marketing")) == "23514"


async def test_an_approval_names_the_real_author_and_fingerprint(db):
    change = await in_approval(db)
    assert await sqlstate_of(approve(db.app, change, "finance-1", "finance", content_hash=b"\x01" * 32)) == "23503"
    assert await sqlstate_of(approve(db.app, change, "finance-1", "finance", author="marketing-2")) == "23503"


async def test_one_person_gives_one_signature_to_a_version(db):
    change = await in_approval(db)
    await approve(db.app, change, "lead-and-finance-1", "finance")
    assert await sqlstate_of(approve(db.app, change, "lead-and-finance-1", "commercial_lead")) == "23505"


async def test_a_role_signs_a_version_once(db):
    change = await in_approval(db)
    await approve(db.app, change, "finance-1", "finance")
    assert await sqlstate_of(approve(db.app, change, "finance-2", "finance")) == "23505"


async def test_two_people_with_two_roles_sign_together(db):
    change = await in_approval(db)
    await approve(db.app, change, "finance-1", "finance")
    await approve(db.app, change, "commercial-lead-1", "commercial_lead")
    assert await db.app.fetchval("select count(*) from approval where change_id = $1", change) == 2


async def test_only_a_change_in_approval_is_signed(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    assert await sqlstate_of(approve(db.app, change, "finance-1", "finance")) == "RL003"


async def test_an_older_version_cannot_be_signed_after_a_new_one(db):
    change = await in_approval(db)
    await new_version(db.app, change, author="marketing-1", content={"title": "v2"})
    await move(db.app, change, "validated", "in_approval")
    assert await sqlstate_of(approve(db.app, change, "finance-1", "finance", version=1)) == "RL003"
    await approve(db.app, change, "finance-1", "finance")
    assert await db.app.fetchval("select version from approval where change_id = $1", change) == 2


async def test_an_approval_is_never_edited_or_withdrawn(db):
    change = await in_approval(db)
    await approve(db.app, change, "finance-1", "finance")
    assert await sqlstate_of(db.owner.execute("update approval set approver = 'finance-2' where change_id = $1", change)) == "RL003"
    assert await sqlstate_of(db.owner.execute("delete from approval where change_id = $1", change)) == "RL003"
    assert await sqlstate_of(db.app.execute("delete from approval where change_id = $1", change)) == "42501"
