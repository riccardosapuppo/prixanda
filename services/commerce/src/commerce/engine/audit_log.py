"""The audit log through the contract (business book §11): read it page by
page, verify its chain, export its head. Nobody changes it through the
engine; exporting the head writes one more event, saying who exported which
head and when.
"""

from __future__ import annotations

from commerce.domain import policy
from commerce.domain.chain import Anchor, ChainWalk
from commerce.engine import records
from commerce.engine.call import Call, Clock
from commerce.engine.changes import require_role
from commerce.engine.database import Connection, utc_text
from commerce.engine.errors import InvalidArgument, PermissionDenied, Refused
from commerce.v1 import audit_pb2

PAGE_DEFAULT, PAGE_MAX = 50, 500
WALK_PAGE = 2_000

CANONICAL = (
    "select seq, encode(hash, 'hex') as hash, encode(prev_hash, 'hex') as prev_hash, "
    "pg_catalog.jsonb_build_array(seq, pg_catalog.to_char(pg_catalog.timezone('UTC', at), "
    "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), actor, actor_role, action, subject, request_id, reason, body)::text as canonical "
    "from audit_event where seq > $1 order by seq limit $2")


class AuditLog:
    def __init__(self, clock: Clock) -> None:
        self.clock = clock

    async def list_events(self, tx: Connection, call: Call, request: audit_pb2.ListEventsRequest) -> audit_pb2.ListEventsResponse:
        args: list = []

        def param(value) -> str:
            args.append(value)
            return f"${len(args)}"

        where = []
        for column, value in (("actor", request.actor), ("action", request.action), ("subject", request.subject)):
            if value:
                where.append(f"{column} = {param(value)}")
        if request.page.after:
            if not request.page.after.isdigit():
                raise InvalidArgument("page.after is not a cursor this engine gave")
            where.append(f"seq < {param(int(request.page.after))}::bigint")
        size = min(request.page.size if request.page.size > 0 else PAGE_DEFAULT, PAGE_MAX)
        rows = await tx.fetch(
            f"select seq, {utc_text('at')} as at, actor, actor_role, action, subject, request_id, reason, body::text as body, "
            "encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash from audit_event "
            f"{'where ' + ' and '.join(where) if where else ''} order by seq desc limit {size + 1}", *args)
        page = rows[:size]
        response = audit_pb2.ListEventsResponse(events=[audit_pb2.AuditEvent(
            seq=r["seq"], at=records.iso(r["at"]), actor=r["actor"], actor_role=r["actor_role"], action=r["action"],
            subject=r["subject"], request_id=r["request_id"], reason=r["reason"] or "", body_json=r["body"],
            prev_hash=bytes.fromhex(r["prev_hash"]), hash=bytes.fromhex(r["hash"])) for r in page])
        if len(rows) > size:
            response.page.next = str(page[-1]["seq"])
        return response

    async def verify_chain(self, tx: Connection, call: Call, request: audit_pb2.VerifyChainRequest) -> audit_pb2.VerifyChainResponse:
        if call.role not in policy.CHAIN_VERIFIERS:
            raise PermissionDenied(f"{policy.who(policy.CHAIN_VERIFIERS).capitalize()} verify the audit chain")
        anchor = None
        if request.HasField("anchor"):
            if request.anchor.seq <= 0 or len(request.anchor.hash) != 32:
                raise InvalidArgument("an exported head is a sequence number and a 32-byte hash")
            anchor = Anchor(request.anchor.seq, bytes(request.anchor.hash))
        walk = ChainWalk(anchor)
        after = 0
        while True:
            rows = await tx.fetch(CANONICAL, after, WALK_PAGE)
            for row in rows:
                if walk.feed(row["seq"], bytes.fromhex(row["prev_hash"]), bytes.fromhex(row["hash"]), row["canonical"]):
                    break
            if walk.failure is not None or len(rows) < WALK_PAGE:
                break
            after = rows[-1]["seq"]
        report = walk.finish()
        response = audit_pb2.VerifyChainResponse(ok=report.ok, events=report.events, why=report.why or "",
                                                 broken_at=report.broken_at or 0)
        if report.head is not None:
            response.head.CopyFrom(audit_pb2.ChainHead(seq=report.events, hash=report.head))
        return response

    async def export_head(self, tx: Connection, call: Call, request: audit_pb2.ExportHeadRequest) -> audit_pb2.ExportHeadResponse:
        require_role(call, policy.HEAD_EXPORTERS, "export the head of the audit log")
        row = await tx.fetchrow("select seq, encode(hash, 'hex') as hash from audit_event order by seq desc limit 1")
        if row is None:
            raise Refused("INVALID", "The audit log is empty: there is no head to export yet.")
        now = self.clock.now()
        await records.record(tx, at=now, actor=call.actor, role=call.role, action="audit.exported", subject="audit",
                             request_id=call.request_id, body={"through_seq": row["seq"], "head": row["hash"]})
        return audit_pb2.ExportHeadResponse(head=audit_pb2.ChainHead(seq=row["seq"], hash=bytes.fromhex(row["hash"])))
