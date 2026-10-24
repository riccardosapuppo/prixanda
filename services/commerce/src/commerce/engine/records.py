"""Reading changes back as the contract's messages, and writing audit events.

Every change of state writes one audit event in the same transaction as the
change (business book §11.1): who (the person and the role they act in),
what, the state before and after, when, why, and the request identifier the
call arrived with.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

from commerce.domain.economics import SignatureNeed
from commerce.domain.localtime import format_instant, parse_instant
from commerce.domain.offers import Content, ListPrice, from_json
from commerce.engine import contract
from commerce.engine.database import Connection, utc_text
from commerce.engine.errors import NotFound
from commerce.v1 import changes_pb2

ZERO_HASH = "decode(repeat('00', 32), 'hex')"


async def record(tx: Connection, *, at: datetime, actor: str, role: str, action: str, subject: str, request_id: str,
                 body: dict, reason: str | None = None) -> int:
    """One audit event, and its sequence number; the database chains it under its lock (migration V4)."""
    return await tx.fetchval(
        "insert into audit_event (at, actor, actor_role, action, subject, request_id, reason, body, prev_hash, hash) "
        f"values ($1::text::timestamptz, $2, $3, $4, $5, $6, $7, $8::text::jsonb, {ZERO_HASH}, {ZERO_HASH}) returning seq",
        format_instant(at), actor, role, action, subject, request_id, reason, json.dumps(body, sort_keys=True))


def iso(text: str | None) -> str:
    """Timestamps as the contract writes them: UTC with Z, microseconds only when there are some."""
    return "" if text is None else format_instant(parse_instant(text))


def _ids(ids: Iterable[int]) -> str:
    return json.dumps(sorted(set(ids)))


IDS = "(select jsonb_array_elements_text($1::text::jsonb)::bigint)"


@dataclass(frozen=True)
class ChangeRow:
    id: int
    kind: str
    title: str
    state: str
    state_reason: str | None
    current_version: int | None
    created_by: str


async def lock_change(tx: Connection, change_id: int) -> ChangeRow:
    """The change's row, locked until the transaction ends: calls on one change go one at a time."""
    row = await tx.fetchrow(
        "select id, kind, title, state, state_reason, current_version, created_by from change where id = $1 for update",
        change_id)
    if row is None:
        raise NotFound(f"no change #{change_id}")
    return ChangeRow(**row)


async def version_content(tx: Connection, change_id: int, version: int) -> tuple[Content, str, str]:
    """A version's content, its author and its fingerprint in hex."""
    row = await tx.fetchrow(
        "select content::text as content, author, encode(content_hash, 'hex') as content_hash "
        "from change_version where change_id = $1 and version = $2", change_id, version)
    if row is None:
        raise NotFound(f"change #{change_id} has no version {version}")
    return from_json(json.loads(row["content"])), row["author"], row["content_hash"]


async def authors(tx: Connection, change_id: int) -> set[str]:
    return {row["author"] for row in await tx.fetch("select distinct author from change_version where change_id = $1", change_id)}


async def latest_validation(tx: Connection, change_id: int, version: int) -> dict | None:
    row = await tx.fetchrow(
        "select valid, eligible, sentence, report::text as report from change_validation "
        "where change_id = $1 and version = $2 order by id desc limit 1", change_id, version)
    if row is None:
        return None
    return {"valid": row["valid"], "eligible": row["eligible"], "sentence": row["sentence"], **json.loads(row["report"])}


def needs_from_report(report: dict) -> list[SignatureNeed]:
    return [SignatureNeed(s["role"], tuple(s["conditions"]), s["why"]) for s in report.get("signatures", [])]


def starts_of(content: Content) -> list[tuple[str, datetime]]:
    """The local start of each market a change starts in."""
    if isinstance(content, ListPrice):
        return [(content.market, content.starts)] if content.market and content.starts else []
    return [(p.market, p.starts) for p in content.periods if p.starts is not None]


def markets_of(content: Content) -> list[str]:
    if isinstance(content, ListPrice):
        return [content.market] if content.market else []
    seen: list[str] = []
    for entry in (*content.prices, *content.periods, *content.pages):
        if entry.market not in seen:
            seen.append(entry.market)
    return seen


async def load_changes(tx: Connection, ids: list[int]) -> dict[int, changes_pb2.Change]:
    """Changes as the contract shows them, in five queries whatever their number."""
    if not ids:
        return {}
    payload = _ids(ids)
    rows = await tx.fetch(
        "select id, kind, title, state, state_reason, current_version, created_by, "
        f"{utc_text('created_at')} as created_at from change where id in {IDS}", payload)
    if not rows:
        return {}
    versions = await tx.fetch(
        f"select change_id, version, author, {utc_text('created_at')} as created_at, "
        "encode(content_hash, 'hex') as content_hash, content::text as content "
        f"from change_version where change_id in {IDS} order by change_id, version", payload)
    approvals = await tx.fetch(
        f"select change_id, version, approver, role, {utc_text('decided_at')} as decided_at, "
        f"encode(content_hash, 'hex') as content_hash from approval where change_id in {IDS} "
        "order by change_id, decided_at, role", payload)
    validations = await tx.fetch(
        "select distinct on (v.change_id) v.change_id, v.version, v.valid, v.eligible, v.sentence, v.report::text as report "
        "from change_validation v join change c on c.id = v.change_id and c.current_version = v.version "
        f"where v.change_id in {IDS} order by v.change_id, v.id desc", payload)
    submissions = await tx.fetch(
        "select distinct on (s.change_id) s.change_id, s.author_reason "
        "from change_submission s join change c on c.id = s.change_id and c.current_version = s.version "
        f"where s.change_id in {IDS} order by s.change_id, s.id desc", payload)

    out: dict[int, changes_pb2.Change] = {}
    for row in rows:
        out[row["id"]] = changes_pb2.Change(
            id=row["id"], kind=contract.kind_to_proto(row["kind"]), title=row["title"],
            state=contract.state_to_proto(row["state"]), state_reason=row["state_reason"] or "",
            current_version=row["current_version"] or 0, created_by=row["created_by"], created_at=iso(row["created_at"]))
    for row in versions:
        version = changes_pb2.ChangeVersion(version=row["version"], author=row["author"], created_at=iso(row["created_at"]),
                                            content_hash=bytes.fromhex(row["content_hash"]))
        field, message = contract.content_to_proto(from_json(json.loads(row["content"])))
        getattr(version, field).CopyFrom(message)
        out[row["change_id"]].versions.append(version)
    signed: dict[int, set[str]] = {}
    for row in approvals:
        change = out[row["change_id"]]
        change.approvals.append(changes_pb2.Approval(
            version=row["version"], approver=row["approver"], role=contract.role_to_proto(row["role"]),
            decided_at=iso(row["decided_at"]), content_hash=bytes.fromhex(row["content_hash"])))
        if row["version"] == change.current_version:
            signed.setdefault(row["change_id"], set()).add(row["role"])
    for row in validations:
        change = out[row["change_id"]]
        report = json.loads(row["report"])
        change.validation.CopyFrom(changes_pb2.ValidationReport(
            version=row["version"], valid=row["valid"], eligible=row["eligible"],
            findings=[changes_pb2.ValidationFinding(check=f["check"], severity=contract.severity_to_proto(f["severity"]),
                                                    market=f["market"], message=f["message"], facts=f["facts"])
                      for f in report["findings"]]))
        roles = signed.get(row["change_id"], set())
        for need in needs_from_report(report):
            change.required_signatures.append(changes_pb2.RequiredSignature(
                role=contract.role_to_proto(need.role), conditions=list(need.conditions), why=need.why,
                signed=need.met_by(roles)))
        change.sentence = row["sentence"]
    for row in submissions:
        out[row["change_id"]].author_reason = row["author_reason"] or ""
    return out


async def load_change(tx: Connection, change_id: int) -> changes_pb2.Change:
    found = await load_changes(tx, [change_id])
    if change_id not in found:
        raise NotFound(f"no change #{change_id}")
    return found[change_id]


def summary(change: changes_pb2.Change, updated_at: str) -> changes_pb2.ChangeSummary:
    current = next((v for v in change.versions if v.version == change.current_version), None)
    markets: list[str] = []
    if current is not None:
        field = current.WhichOneof("content")
        content = contract.offer_from_proto(current.offer) if field == "offer" else contract.list_price_from_proto(current.list_price)
        markets = markets_of(content)
    return changes_pb2.ChangeSummary(
        id=change.id, kind=change.kind, title=change.title, state=change.state, current_version=change.current_version,
        created_by=change.created_by, markets=markets, required_signatures=list(change.required_signatures),
        updated_at=updated_at)
