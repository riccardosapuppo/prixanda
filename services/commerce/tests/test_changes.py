"""Changes move only along the states of the business book (§7.1), and their
versions are written once (§6.3, §7.2)."""

from __future__ import annotations

import hashlib
import json

from helpers import T0, add_people, approve, move, new_change, new_version, sqlstate_of


async def test_a_change_walks_the_whole_path_of_the_book(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    await move(db.app, change, "validated", "in_approval")
    await approve(db.app, change, "finance-1", "finance")
    await move(db.app, change, "approved", "scheduled", "active", "ended")
    assert await db.app.fetchval("select state from change where id = $1", change) == "ended"


async def test_a_change_starts_as_a_draft_without_a_version(db):
    await add_people(db.owner)
    statement = db.app.execute(
        "insert into change (kind, title, created_by, created_at, state) values ('offer', 'x', 'marketing-1', $1, 'approved')", T0)
    assert await sqlstate_of(statement) == "RL002"


async def test_no_state_is_skipped(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    for state in ("in_approval", "approved", "scheduled", "active", "ended"):
        assert await sqlstate_of(move(db.app, change, state)) == "RL002", state


async def test_nothing_is_approved_without_a_signature(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    await move(db.app, change, "validated", "in_approval")
    assert await sqlstate_of(move(db.app, change, "approved")) == "RL003"


async def test_a_rejection_carries_its_reason(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    await move(db.app, change, "validated", "in_approval")
    assert await sqlstate_of(move(db.app, change, "draft")) == "RL002"
    await move(db.app, change, "draft", reason="Keep it to people who have never paid.")
    assert await db.app.fetchval("select state from change where id = $1", change) == "draft"


async def test_suspending_or_cancelling_needs_a_reason(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    await move(db.app, change, "validated", "in_approval")
    await approve(db.app, change, "finance-1", "finance")
    await move(db.app, change, "approved", "scheduled")
    assert await sqlstate_of(move(db.app, change, "cancelled")) == "23514"
    await move(db.app, change, "active")
    assert await sqlstate_of(move(db.app, change, "suspended")) == "23514"
    await move(db.app, change, "suspended", reason="The publish step failed twice.")
    assert await sqlstate_of(move(db.app, change, "active")) == "RL002"


async def test_a_new_version_returns_the_change_to_draft_and_needs_new_signatures(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    await move(db.app, change, "validated", "in_approval")
    await approve(db.app, change, "finance-1", "finance")
    version = await new_version(db.app, change, author="marketing-1", content={"title": "Student Autumn Pass", "price_minor": 249})
    assert version == 2
    assert await db.app.fetchval("select state from change where id = $1", change) == "draft"
    await move(db.app, change, "validated", "in_approval")
    # Version 1's signature does not carry over to version 2.
    assert await sqlstate_of(move(db.app, change, "approved")) == "RL003"


async def test_a_scheduled_change_takes_no_new_version(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    await move(db.app, change, "validated", "in_approval")
    await approve(db.app, change, "finance-1", "finance")
    await move(db.app, change, "approved", "scheduled")
    statement = new_version(db.app, change, author="marketing-1", content={"title": "late edit"})
    assert await sqlstate_of(statement) == "RL004"


async def test_versions_follow_each_other(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    statement = db.app.execute(
        "insert into change_version (change_id, version, author, created_at, content, content_hash) "
        "values ($1, 3, 'marketing-1', $2, '{}'::jsonb, $3)", change, T0, bytes(32))
    assert await sqlstate_of(statement) == "RL004"


async def test_a_version_is_never_edited_or_deleted(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    assert await sqlstate_of(db.owner.execute(
        "update change_version set content = '{\"price_minor\": 1}' where change_id = $1", change)) == "RL004"
    assert await sqlstate_of(db.owner.execute("delete from change_version where change_id = $1", change)) == "RL004"


async def test_the_fingerprint_is_computed_from_the_content_not_taken_from_the_caller(db):
    await add_people(db.owner)
    content = {"title": "Student Autumn Pass", "market": "IT", "price_minor": 299}
    change = await new_change(db.app, content=content)
    row = await db.app.fetchrow("select content::text as text, content_hash from change_version where change_id = $1", change)
    assert bytes(row["content_hash"]) != bytes(32)
    assert bytes(row["content_hash"]) == hashlib.sha256(row["text"].encode("utf-8")).digest()
    assert json.loads(row["text"]) == content


async def test_a_change_keeps_its_kind_and_author_and_is_never_deleted(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    assert await sqlstate_of(db.owner.execute("update change set kind = 'list_price' where id = $1", change)) == "RL002"
    assert await sqlstate_of(db.owner.execute("update change set created_by = 'marketing-2' where id = $1", change)) == "RL002"
    assert await sqlstate_of(db.owner.execute("delete from change where id = $1", change)) == "RL002"


async def test_the_title_changes_only_in_draft(db):
    await add_people(db.owner)
    change = await new_change(db.app)
    await db.app.execute("update change set title = 'Student Autumn Pass 2026' where id = $1", change)
    await move(db.app, change, "validated")
    assert await sqlstate_of(db.app.execute("update change set title = 'Renamed' where id = $1", change)) == "RL002"
