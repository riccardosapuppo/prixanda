"""What the database tests share: the people of the demo, a fixed clock, and
short ways to write changes, move them and sign them."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import asyncpg

# The time is injected, never read from the machine.
T0 = datetime(2026, 10, 24, 8, 42, tzinfo=UTC)

PEOPLE = {
    "marketing-1": ("Marketing", ["marketing"]),
    "marketing-2": ("Marketing, second", ["marketing"]),
    "commercial-lead-1": ("Commercial lead", ["commercial_lead"]),
    "finance-1": ("Finance", ["finance"]),
    "finance-2": ("Finance, second", ["finance"]),
    "catalog-manager-1": ("Catalog manager", ["catalog_manager"]),
    "on-call-1": ("On-call engineer", ["on_call"]),
    "auditor-1": ("Auditor", ["auditor"]),
    # Holds both signing roles, for the rule that one person gives one signature.
    "lead-and-finance-1": ("Commercial lead and finance", ["commercial_lead", "finance"]),
}


async def add_people(conn: asyncpg.Connection) -> None:
    for person, (label, roles) in PEOPLE.items():
        await conn.execute("insert into person (id, label) values ($1, $2)", person, label)
        for role in roles:
            await conn.execute("insert into person_role (person_id, role) values ($1, $2)", person, role)


async def sqlstate_of(statement) -> str:
    """The SQLSTATE the database refused with; failing the test if it accepted."""
    try:
        await statement
    except asyncpg.PostgresError as error:
        return error.sqlstate
    raise AssertionError("the database accepted it")


async def new_change(conn: asyncpg.Connection, *, kind: str = "offer", author: str = "marketing-1",
                     content: dict | None = None, at: datetime = T0) -> int:
    content = content if content is not None else {"title": "Student Autumn Pass", "market": "IT", "price_minor": 299}
    async with conn.transaction():
        change_id = await conn.fetchval(
            "insert into change (kind, title, created_by, created_at) values ($1, $2, $3, $4) returning id",
            kind, content.get("title", "A change"), author, at)
        await conn.execute(
            "insert into change_version (change_id, version, author, created_at, content, content_hash) "
            "values ($1, 1, $2, $3, $4::jsonb, $5)", change_id, author, at, json.dumps(content), bytes(32))
        await conn.execute("update change set current_version = 1 where id = $1", change_id)
    return change_id


async def new_version(conn: asyncpg.Connection, change_id: int, *, author: str, content: dict, at: datetime = T0) -> int:
    async with conn.transaction():
        version = await conn.fetchval("select current_version + 1 from change where id = $1", change_id)
        await conn.execute(
            "insert into change_version (change_id, version, author, created_at, content, content_hash) "
            "values ($1, $2, $3, $4, $5::jsonb, $6)", change_id, version, author, at, json.dumps(content), bytes(32))
        await conn.execute("update change set current_version = $2, state = 'draft', state_reason = null where id = $1",
                           change_id, version)
    return version


async def move(conn: asyncpg.Connection, change_id: int, *states: str, reason: str | None = None) -> None:
    for state in states:
        await conn.execute("update change set state = $2, state_reason = $3 where id = $1", change_id, state, reason)


async def approve(conn: asyncpg.Connection, change_id: int, approver: str, role: str, *, version: int | None = None,
                  content_hash: bytes | None = None, author: str | None = None, at: datetime = T0) -> None:
    row = await conn.fetchrow(
        "select v.version, v.author, v.content_hash from change c join change_version v "
        "on v.change_id = c.id and v.version = coalesce($2, c.current_version) where c.id = $1", change_id, version)
    await conn.execute(
        "insert into approval (change_id, version, author, content_hash, approver, role, decided_at) "
        "values ($1, $2, $3, $4, $5, $6, $7)",
        change_id, row["version"], author or row["author"], content_hash or row["content_hash"], approver, role, at)


async def audit(conn: asyncpg.Connection, action: str = "change.created", *, actor: str = "marketing-1",
                role: str = "marketing", subject: str = "change:1", reason: str | None = None,
                body: dict | None = None, at: datetime = T0, request_id: str = "req-test") -> None:
    await conn.execute(
        "insert into audit_event (at, actor, actor_role, action, subject, request_id, reason, body, prev_hash, hash) "
        "values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9)",
        at, actor, role, action, subject, request_id, reason, json.dumps(body or {}), bytes(32))
