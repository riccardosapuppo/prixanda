"""Changes and their approvals (business book §6, §7, §12).

Every call locks the change's row first, so calls on one change go one at a
time and each decides on what is really stored: two signatures arriving
together see each other, and the second completes the approval. The engine
says no with a typed refusal before the database would; the database's own
rules (migration V2) stay underneath, and a refusal they raise in a race is
turned into the same answer.

The engine is stricter than the database in one place: anyone who wrote any
version of a change cannot sign it, so that a colleague's small edit does not
turn the original author into a reviewer (§7.4).
"""

from __future__ import annotations

import base64
import binascii
import json
from datetime import datetime

from commerce.domain import policy
from commerce.domain.economics import Book
from commerce.domain.localtime import AmbiguousLocalTime, format_instant, format_local, to_instant, to_local
from commerce.domain.money import Money
from commerce.domain.offers import (
    Content, ListPrice, Offer, PrepaidPass, PriceMigration, from_json, local_times, shape_problems, to_json,
)
from commerce.domain.validation import (
    BLOCKING, PENDING_OR_LIVE, Context, MarketFacts, Neighbour, report_to_json, validate,
)
from commerce.engine import clashes, contract, eligibility, launches, records, reference
from commerce.engine.call import Call, Clock
from commerce.engine.database import (
    CHECK_VIOLATION, FOREIGN_KEY_VIOLATION, UNIQUE_VIOLATION, Connection, DatabaseError, utc_text,
)
from commerce.engine.errors import InvalidArgument, Refused
from commerce.engine.publication import Publisher
from commerce.v1 import changes_pb2

REASON_MAX = 2_000
BATCH_MAX = 500
PAGE_DEFAULT, PAGE_MAX = 50, 200


def require_role(call: Call, roles: frozenset[str], doing: str) -> None:
    if call.role not in roles:
        raise Refused("ROLE_NOT_ALLOWED", f"{policy.who(roles).capitalize()} may {doing}; you act as {policy.ROLE_NAMES[call.role]}.",
                      {"role": call.role, "allowed": ",".join(sorted(roles))})


def require_state(change: records.ChangeRow, *states: str, doing: str) -> None:
    if change.state not in states:
        raise Refused("WRONG_STATE", f"Change #{change.id} is {change.state.replace('_', ' ')}: it cannot be {doing} now.",
                      {"state": change.state, "allowed": ",".join(states)})


def require_current(change: records.ChangeRow, version: int, code: str = "STALE_VERSION") -> None:
    if version <= 0:
        raise InvalidArgument("name the version you are acting on")
    if version != change.current_version:
        raise Refused(code, f"Version {version} is not the current one: change #{change.id} is at version {change.current_version}.",
                      {"newer_version": change.current_version, "named_version": version})


def reason_text(text: str, why: str) -> str:
    reason = text.strip()
    if not reason:
        raise Refused("REASON_REQUIRED", f"Say why {why}.")
    if len(reason) > REASON_MAX:
        raise InvalidArgument(f"a reason is at most {REASON_MAX} characters")
    return reason


class Changes:
    def __init__(self, clock: Clock, book: Book, publisher: Publisher) -> None:
        self.clock = clock
        self.book = book
        self.publisher = publisher

    # -- writing versions -------------------------------------------------

    async def _check_shape(self, tx: Connection, content: Content, ref: reference.Reference) -> None:
        artist_ids = set()
        if isinstance(content, Offer) and content.audience.listening is not None:
            artist_ids.add(content.audience.listening.artist_id)
        known_artists = frozenset((await reference.artist_names(tx, artist_ids)).keys())
        problems = shape_problems(content, ref.known(known_artists))
        if problems:
            raise InvalidArgument("; ".join(problems))
        for market, moment in local_times(content):
            try:
                to_instant(moment, ref.markets[market].zone)
            except AmbiguousLocalTime as clash:
                raise Refused("AMBIGUOUS_LOCAL_TIME", f"{ref.markets[market].name}: {clash}.",
                              {"market": market, "local": format_local(moment), "zone": clash.zone, "kind": clash.kind,
                               "offsets": " ".join(clash.offsets)}) from clash

    async def _write_version(self, tx: Connection, change_id: int, version: int, author: str, content: Content,
                             now: datetime) -> None:
        await tx.execute(
            "insert into change_version (change_id, version, author, created_at, content, content_hash) "
            "values ($1, $2, $3, $4::text::timestamptz, $5::text::jsonb, decode(repeat('00', 32), 'hex'))",
            change_id, version, author, format_instant(now), json.dumps(to_json(content)))

    async def _event(self, tx: Connection, call: Call, now: datetime, action: str, change: records.ChangeRow | int,
                     body: dict, reason: str | None = None) -> int:
        change_id = change if isinstance(change, int) else change.id
        return await records.record(tx, at=now, actor=call.actor, role=call.role, action=action, subject=f"change:{change_id}",
                                    request_id=call.request_id, body={"change": change_id, **body}, reason=reason)

    async def _move(self, tx: Connection, change: records.ChangeRow, to: str, now: datetime, reason: str | None = None) -> None:
        await tx.execute("update change set state = $2, state_reason = $3, updated_at = $4::text::timestamptz where id = $1",
                         change.id, to, reason, format_instant(now))

    async def create(self, tx: Connection, call: Call, request: changes_pb2.CreateChangeRequest) -> changes_pb2.CreateChangeResponse:
        content = contract.content_from_request(request)
        require_role(call, policy.AUTHORS[content.kind], f"create {policy.KIND_NAMES[content.kind]}")
        now = self.clock.now()
        ref = await reference.load(tx, now)
        await self._check_shape(tx, content, ref)
        change_id = await tx.fetchval(
            "insert into change (kind, title, created_by, created_at, updated_at) "
            "values ($1, $2, $3, $4::text::timestamptz, $4::text::timestamptz) returning id",
            content.kind, content.title.strip(), call.actor, format_instant(now))
        await self._write_version(tx, change_id, 1, call.actor, content, now)
        await tx.execute("update change set current_version = 1 where id = $1", change_id)
        await self._event(tx, call, now, "change.created", change_id, {"kind": content.kind, "version": 1, "to": "draft"})
        return changes_pb2.CreateChangeResponse(change=await records.load_change(tx, change_id))

    async def save_version(self, tx: Connection, call: Call, request: changes_pb2.SaveVersionRequest) -> changes_pb2.SaveVersionResponse:
        change = await records.lock_change(tx, request.change_id)
        content = contract.content_from_request(request)
        if content.kind != change.kind:
            raise InvalidArgument(f"change #{change.id} is {policy.KIND_NAMES[change.kind]}: its versions say the same kind of thing")
        require_role(call, policy.AUTHORS[change.kind], f"edit {policy.KIND_NAMES[change.kind]}")
        require_state(change, *policy.TAKES_NEW_VERSIONS, doing="edited (a scheduled change takes no new versions: start a new change)")
        if request.base_version <= 0:
            raise InvalidArgument("base_version names the version you started from")
        if request.base_version != change.current_version:
            newer = await tx.fetchrow(
                f"select author, {utc_text('created_at')} as created_at from change_version where change_id = $1 and version = $2",
                change.id, change.current_version)
            raise Refused("STALE_VERSION",
                          f"Version {change.current_version} was saved by {newer['author']} after the version {request.base_version} "
                          f"you started from: open it and make your edit again.",
                          {"newer_version": change.current_version, "saved_by": newer["author"],
                           "saved_at": records.iso(newer["created_at"]), "base_version": request.base_version})
        now = self.clock.now()
        ref = await reference.load(tx, now)
        await self._check_shape(tx, content, ref)
        version = change.current_version + 1
        await self._write_version(tx, change.id, version, call.actor, content, now)
        await tx.execute(
            "update change set current_version = $2, state = 'draft', state_reason = null, title = $3, "
            "updated_at = $4::text::timestamptz where id = $1",
            change.id, version, content.title.strip(), format_instant(now))
        await self._event(tx, call, now, "change.version_saved", change,
                          {"version": version, "from": change.state, "to": "draft"})
        return changes_pb2.SaveVersionResponse(change=await records.load_change(tx, change.id))

    # -- reading ------------------------------------------------------------

    async def get(self, tx: Connection, call: Call, request: changes_pb2.GetChangeRequest) -> changes_pb2.GetChangeResponse:
        return changes_pb2.GetChangeResponse(change=await records.load_change(tx, request.change_id))

    async def batch_get(self, tx: Connection, call: Call, request: changes_pb2.BatchGetChangesRequest) -> changes_pb2.BatchGetChangesResponse:
        ids = list(dict.fromkeys(request.change_ids))
        if len(ids) > BATCH_MAX:
            raise InvalidArgument(f"at most {BATCH_MAX} changes in one call")
        found = await records.load_changes(tx, ids)
        return changes_pb2.BatchGetChangesResponse(changes=[found[i] for i in ids if i in found])

    async def list(self, tx: Connection, call: Call, request: changes_pb2.ListChangesRequest) -> changes_pb2.ListChangesResponse:
        args: list = []

        def param(value) -> str:
            args.append(value)
            return f"${len(args)}"

        where = []
        states = [contract.state_from_proto(s) for s in request.states]
        if any(s is None for s in states):
            raise InvalidArgument("a state filter names a state")
        if states:
            where.append(f"c.state in (select jsonb_array_elements_text({param(json.dumps(states))}::text::jsonb))")
        kind = contract.kind_from_proto(request.kind)
        if kind is not None:
            where.append(f"c.kind = {param(kind)}")
        if request.market:
            ref = await reference.load(tx, self.clock.now())
            ref.market(request.market)
            m = param(request.market)
            where.append(
                "exists (select from change_version v where v.change_id = c.id and v.version = c.current_version and "
                f"(v.content->>'market' = {m} or exists (select from jsonb_array_elements(coalesce(v.content->'prices', '[]'::jsonb)) p "
                f"where p->>'market' = {m})))")
        size = request.page.size if request.page.size > 0 else PAGE_DEFAULT
        size = min(size, PAGE_MAX)
        if request.page.after:
            updated_at, change_id = decode_cursor(request.page.after)
            where.append(f"(c.updated_at, c.id) < ({param(updated_at)}::text::timestamptz, {param(change_id)}::bigint)")
        sql = (f"select c.id, {utc_text('c.updated_at')} as updated_at from change c "
               f"{'where ' + ' and '.join(where) if where else ''} order by c.updated_at desc, c.id desc limit {size + 1}")
        rows = await tx.fetch(sql, *args)
        page, more = rows[:size], len(rows) > size
        changes = await records.load_changes(tx, [r["id"] for r in page])
        response = changes_pb2.ListChangesResponse(
            changes=[records.summary(changes[r["id"]], records.iso(r["updated_at"])) for r in page])
        if more:
            response.page.next = encode_cursor(page[-1]["updated_at"], page[-1]["id"])
        return response

    # -- review ---------------------------------------------------------------

    async def _context(self, tx: Connection, change: records.ChangeRow, content: Content, now: datetime) -> Context:
        ref = await reference.load(tx, now)
        codes = records.markets_of(content)
        plan_id = content.plan
        audience = content.audience if isinstance(content, Offer) else None
        facts: dict[str, MarketFacts] = {}
        for code in codes:
            market = ref.market(code)
            local_now = to_local(now, market.zone)
            starts = None
            if isinstance(content, (Offer, PrepaidPass)):
                period = content.period_in(code)
                starts = period.starts if period is not None else None
            else:
                starts = content.starts
            at = starts if starts is not None and starts > local_now else local_now
            list_price = None
            if plan_id is not None:
                amount = await tx.fetchval(
                    "select amount_minor from list_price where plan_id = $1 and market = $2 and valid @> $3::text::timestamp",
                    plan_id, code, format_local(at))
                list_price = None if amount is None else Money(amount, market.currency)
            today = market.today(now)
            if isinstance(content, Offer):
                people = await eligibility.count(tx, audience, code, today) if audience.segment is not None else 0
            elif isinstance(content, PrepaidPass):
                people = 0  # a pass is sold to anyone, and given: nobody is counted
            else:
                people = await eligibility.current_subscribers(
                    tx, code, plan_id, today, by_the_month=isinstance(content, PriceMigration)) if plan_id else 0
            facts[code] = MarketFacts(code, market.name, market.currency, market.zone, market.vat_bp, list_price, people)
        # A list price and a price migration both set the list price: each is the other's neighbour.
        kinds = (["offer"] if isinstance(content, Offer) else ["prepaid"] if isinstance(content, PrepaidPass)
                 else ["list_price", "price_migration"])
        rows = await tx.fetch(
            "select c.id, c.title, c.state, v.content::text as content from change c "
            "join change_version v on v.change_id = c.id and v.version = c.current_version "
            "where c.kind in (select jsonb_array_elements_text($1::text::jsonb)) and c.id <> $2 "
            "and c.state in (select jsonb_array_elements_text($3::text::jsonb))",
            json.dumps(kinds), change.id, json.dumps(list(PENDING_OR_LIVE)))
        neighbours = []
        days = clashes.market_days(ref, content, now) if isinstance(content, Offer) else {}
        for r in rows:
            other = from_json(json.loads(r["content"]))
            shared = (await clashes.shared_people(tx, content, other, days)
                      if isinstance(content, Offer) and isinstance(other, Offer) else {})
            neighbours.append(Neighbour(r["id"], r["title"], r["state"], other, shared))
        later: tuple = ()
        if isinstance(content, (ListPrice, PriceMigration)) and content.plan and content.market and content.starts:
            market = ref.markets[content.market]
            later = tuple(
                (datetime.fromisoformat(r["starts"]), Money(r["amount_minor"], market.currency))
                for r in await tx.fetch(
                    "select to_char(lower(valid), 'YYYY-MM-DD\"T\"HH24:MI:SS') as starts, amount_minor from list_price "
                    "where plan_id = $1 and market = $2 and lower(valid) >= $3::text::timestamp order by lower(valid)",
                    content.plan, content.market, format_local(content.starts)))
        artist_ids = {content.audience.listening.artist_id} if isinstance(content, Offer) and content.audience.listening else set()
        rules = (await reference.policies(tx)).get(content.market) if isinstance(content, PriceMigration) else None
        return Context(now=now, book=self.book, markets=facts, plans=ref.plans,
                       artists=await reference.artist_names(tx, artist_ids), neighbours=tuple(neighbours), later_prices=later,
                       policy=rules)

    async def validate(self, tx: Connection, call: Call, request: changes_pb2.ValidateChangeRequest) -> changes_pb2.ValidateChangeResponse:
        change = await records.lock_change(tx, request.change_id)
        require_role(call, policy.AUTHORS[change.kind], f"validate {policy.KIND_NAMES[change.kind]}")
        require_current(change, request.version)
        require_state(change, "draft", doing="validated")
        content, _, _ = await records.version_content(tx, change.id, change.current_version)
        # One validation at a time among the changes this one can clash with:
        # the other changes are read only once this lock is held.
        await clashes.lock_neighbourhood(tx, content)
        now = self.clock.now()
        report = validate(content, await self._context(tx, change, content, now))
        await tx.execute(
            "insert into change_validation (change_id, version, validated_at, validated_by, valid, eligible, sentence, report) "
            "values ($1, $2, $3::text::timestamptz, $4, $5, $6, $7, $8::text::jsonb)",
            change.id, change.current_version, format_instant(now), call.actor, report.valid, report.eligible,
            report.sentence, json.dumps(report_to_json(report)))
        if not report.valid:
            await tx.execute("update change set updated_at = $2::text::timestamptz where id = $1", change.id, format_instant(now))
            blocking = [f for f in report.findings if f.severity == BLOCKING]
            plural = "s" if len(blocking) != 1 else ""
            facts: dict[str, object] = {"blocking": len(blocking), "checks": ",".join(sorted({f.check for f in blocking})),
                                        "version": change.current_version}
            # The most people one clash found in both audiences; the report has each clash's own count.
            shared = [int(f.facts["shared"]) for f in blocking if f.check == "conflict" and "shared" in f.facts]
            if shared:
                facts["shared"] = max(shared)
            refused = Refused("INVALID", f"Validation found {len(blocking)} blocking problem{plural}: {blocking[0].message}",
                              facts)
            return changes_pb2.ValidateChangeResponse(refusal=contract.refusal(refused))
        await self._move(tx, change, "validated", now)
        await self._event(tx, call, now, "change.validated", change, {
            "version": change.current_version, "from": "draft", "to": "validated", "eligible": report.eligible,
            "signatures": [{"role": s.role, "conditions": list(s.conditions)} for s in report.signatures],
            "sentence": report.sentence})
        return changes_pb2.ValidateChangeResponse(change=await records.load_change(tx, change.id))

    async def submit(self, tx: Connection, call: Call, request: changes_pb2.SubmitChangeRequest) -> changes_pb2.SubmitChangeResponse:
        change = await records.lock_change(tx, request.change_id)
        require_role(call, policy.AUTHORS[change.kind], f"submit {policy.KIND_NAMES[change.kind]}")
        require_current(change, request.version)
        require_state(change, "validated", doing="submitted (validate it first)")
        report = await records.latest_validation(tx, change.id, change.current_version)
        if report is None or not report["valid"]:
            raise Refused("WRONG_STATE", f"Version {change.current_version} has no passing validation.")
        content, _, _ = await records.version_content(tx, change.id, change.current_version)
        now = self.clock.now()
        ref = await reference.load(tx, now)
        passed = [(market, moment) for market, moment in records.starts_of(content)
                  if to_instant(moment, ref.markets[market].zone) <= now]
        if passed:
            market, moment = passed[0]
            raise Refused("INVALID", f"{ref.markets[market].name}: the start, {format_local(moment)}, has passed since the "
                                     "validation. Save a version with new dates.", {"market": market, "starts": format_local(moment)})
        negative = any(c["number"] == 4 and c["met"] for c in report["conditions"])
        reason = request.author_reason.strip()
        if len(reason) > REASON_MAX:
            raise InvalidArgument(f"a reason is at most {REASON_MAX} characters")
        if negative and not reason:
            detail = next(c["detail"] for c in report["conditions"] if c["number"] == 4)
            raise Refused("REASON_REQUIRED", f"The simulated contribution is negative ({detail}): write why the campaign "
                                             "is still worth running (§7.3, condition 4).", {"condition": 4})
        await tx.execute(
            "insert into change_submission (change_id, version, submitted_at, submitted_by, author_reason) "
            "values ($1, $2, $3::text::timestamptz, $4, $5)",
            change.id, change.current_version, format_instant(now), call.actor, reason or None)
        await self._move(tx, change, "in_approval", now)
        await self._event(tx, call, now, "change.submitted", change, {
            "version": change.current_version, "from": "validated", "to": "in_approval",
            "signatures": [{"role": s["role"], "conditions": s["conditions"]} for s in report["signatures"]]},
            reason=reason or None)
        return changes_pb2.SubmitChangeResponse(change=await records.load_change(tx, change.id))

    async def approve(self, tx: Connection, call: Call, request: changes_pb2.ApproveChangeRequest) -> changes_pb2.ApproveChangeResponse:
        change = await records.lock_change(tx, request.change_id)
        require_role(call, policy.SIGNING_ROLES, "approve a change")
        require_state(change, "in_approval", doing="approved")
        require_current(change, request.version, code="FINGERPRINT_MISMATCH")
        _, _, current_hash = await records.version_content(tx, change.id, change.current_version)
        if bytes(request.content_hash).hex() != current_hash:
            raise Refused("FINGERPRINT_MISMATCH", f"The fingerprint you approve is not the one of version {change.current_version}: "
                                                  "reload it and look again.",
                          {"version": change.current_version, "fingerprint": current_hash})
        wrote = await records.authors(tx, change.id)
        if call.actor in wrote:
            raise Refused("OWN_VERSION", f"You wrote a version of change #{change.id}: someone else has to approve it (§7.4).",
                          {"version": change.current_version})
        report = await records.latest_validation(tx, change.id, change.current_version)
        if report is None:
            raise Refused("WRONG_STATE", f"Version {change.current_version} has no validation to approve against.")
        # With §7.3 as it stands every version needs one signature, so the first
        # signature it needs approves it, and a second signer finds the change
        # approved (WRONG_STATE above). REFUSAL_CODE_ALREADY_SIGNED stays for
        # rules that ask for two; the database's one-signature rules still hold
        # (migration V2) and _approval_refusal translates them.
        roles = {row["role"] for row in await tx.fetch(
            "select role from approval where change_id = $1 and version = $2", change.id, change.current_version)}
        needs = records.needs_from_report(report)
        open_needs = [n for n in needs if not n.met_by(roles)]
        if not any(n.met_by({call.role}) for n in open_needs):
            why = " ".join(n.why for n in open_needs) or "No signature is missing."
            raise Refused("ROLE_NOT_ALLOWED", f"Your signature as {policy.ROLE_NAMES[call.role]} is not one this version needs. {why}",
                          {"role": call.role, "needs": ",".join(n.role for n in open_needs)})
        now = self.clock.now()
        try:
            async with tx.savepoint():
                await tx.execute(
                    "insert into approval (change_id, version, author, content_hash, approver, role, decided_at) "
                    "select change_id, version, author, content_hash, $3, $4, $5::text::timestamptz "
                    "from change_version where change_id = $1 and version = $2",
                    change.id, change.current_version, call.actor, call.role, format_instant(now))
        except DatabaseError as refused:
            raise self._approval_refusal(refused, change) from refused
        roles.add(call.role)
        complete = all(n.met_by(roles) for n in needs)
        if complete:
            await self._move(tx, change, "approved", now)
        else:
            await tx.execute("update change set updated_at = $2::text::timestamptz where id = $1", change.id, format_instant(now))
        await self._event(tx, call, now, "change.approved" if complete else "change.signed", change, {
            "version": change.current_version, "fingerprint": current_hash, "role": call.role,
            "from": "in_approval", "to": "approved" if complete else "in_approval"})
        return changes_pb2.ApproveChangeResponse(change=await records.load_change(tx, change.id))

    @staticmethod
    def _approval_refusal(error: DatabaseError, change: records.ChangeRow) -> Exception:
        """The database's rules said no in a race the engine's checks could not see."""
        if error.sqlstate == UNIQUE_VIOLATION:
            return Refused("ALREADY_SIGNED", f"Version {change.current_version} already has this signature.")
        if error.sqlstate == CHECK_VIOLATION:
            return Refused("OWN_VERSION", "The author of a version cannot approve it (§7.4).")
        if error.sqlstate == FOREIGN_KEY_VIOLATION:
            return Refused("ROLE_NOT_ALLOWED", "The database refused the signature: the role is not held, or the version changed.")
        if error.sqlstate == "RL003":
            return Refused("WRONG_STATE", "The change is no longer in approval.")
        return error

    async def reject(self, tx: Connection, call: Call, request: changes_pb2.RejectChangeRequest) -> changes_pb2.RejectChangeResponse:
        change = await records.lock_change(tx, request.change_id)
        require_role(call, policy.SIGNING_ROLES, "send a change back")
        require_state(change, "in_approval", doing="sent back")
        require_current(change, request.version)
        if call.actor in await records.authors(tx, change.id):
            raise Refused("OWN_VERSION", f"You wrote a version of change #{change.id}: save a new version instead of reviewing it.")
        reason = reason_text(request.reason, "you send it back")
        now = self.clock.now()
        await self._move(tx, change, "draft", now, reason)
        await self._event(tx, call, now, "change.rejected", change,
                          {"version": change.current_version, "from": "in_approval", "to": "draft"}, reason=reason)
        return changes_pb2.RejectChangeResponse(change=await records.load_change(tx, change.id))

    async def schedule(self, tx: Connection, call: Call, request: changes_pb2.ScheduleChangeRequest) -> changes_pb2.ScheduleChangeResponse:
        change = await records.lock_change(tx, request.change_id)
        require_role(call, policy.SCHEDULERS[change.kind], f"schedule {policy.KIND_NAMES[change.kind]}")
        require_state(change, "approved", doing="scheduled")
        content, _, _ = await records.version_content(tx, change.id, change.current_version)
        now = self.clock.now()
        ref = await reference.load(tx, now)
        starts = []
        for market, moment in records.starts_of(content):
            zone = ref.markets[market].zone
            starts.append({"market": market, "local": format_local(moment), "utc": format_instant(to_instant(moment, zone))})
        await clashes.lock_neighbourhood(tx, content)
        if isinstance(content, (ListPrice, PriceMigration)):
            later = await tx.fetchval(
                "select to_char(lower(valid), 'YYYY-MM-DD\"T\"HH24:MI') from list_price where plan_id = $1 and market = $2 "
                "and lower(valid) >= $3::text::timestamp order by lower(valid) limit 1",
                content.plan, content.market, format_local(content.starts))
            if later is not None:
                raise Refused("OVERLAP", f"The price list already holds a {content.plan} price in {content.market} from {later}: "
                                         "the new price would overlap it (§4.1).", {"starts": later})
            pending = await clashes.pending_list_price(tx, content, change.id, ("approved", "scheduled"))
            if pending is not None:
                raise Refused("OVERLAP", f"{pending.title} (#{pending.change_id}, {pending.state}) already changes this price: "
                                         "only one of them can be scheduled.", {"change": pending.change_id})
        else:
            ended = [p.market for p in content.periods
                     if p.ends is not None and to_instant(p.ends, ref.markets[p.market].zone) <= now]
            if ended:
                period = "pass's period of sale" if isinstance(content, PrepaidPass) else "offer's period"
                raise Refused("INVALID", f"The {period} has already ended in {', '.join(ended)}: save a version with new dates.",
                              {"markets": ",".join(ended)})
            # A prepaid pass is a product of its own, beside every other change (§9): no offer clashes with it, and its
            # launch checks nothing more (launches.py).
            if isinstance(content, Offer):
                clash = await clashes.first_clash(tx, content, change.id, ("approved", "scheduled", "active"), ref, now)
                if clash is not None:
                    raise Refused("INVALID", clash.words(ref.markets[clash.market].name, content.group)
                                  + " Cancel one of them, or save a version with other dates.", clash.facts())
        await self._move(tx, change, "scheduled", now)
        await self._event(tx, call, now, "change.scheduled", change,
                          {"version": change.current_version, "from": "approved", "to": "scheduled", "starts": starts})
        return changes_pb2.ScheduleChangeResponse(change=await records.load_change(tx, change.id))

    async def cancel(self, tx: Connection, call: Call, request: changes_pb2.CancelChangeRequest) -> changes_pb2.CancelChangeResponse:
        # Its launch first, then the change: the order a launch's steps take them in.
        await tx.execute("select id from launch where change_id = $1 for update", request.change_id)
        change = await records.lock_change(tx, request.change_id)
        require_role(call, policy.CANCELLERS[change.kind], f"cancel {policy.KIND_NAMES[change.kind]}")
        require_state(change, "scheduled", doing="cancelled")
        reason = reason_text(request.reason, "you cancel it")
        now = self.clock.now()
        await self._move(tx, change, "cancelled", now, reason)
        event = await self._event(tx, call, now, "change.cancelled", change,
                                  {"version": change.current_version, "from": "scheduled", "to": "cancelled"}, reason=reason)
        # A launch under way that has not published stops with it (§7.5).
        await launches.withdraw(tx, change.id, actor=call.actor, role=call.role, reason=reason, now=now,
                                request_id=call.request_id, events=(event,))
        return changes_pb2.CancelChangeResponse(change=await records.load_change(tx, change.id))

    async def suspend(self, tx: Connection, call: Call, request: changes_pb2.SuspendChangeRequest) -> changes_pb2.SuspendChangeResponse:
        await self.publisher.lock(tx)  # publications first, then the change: the order every publisher takes
        change = await records.lock_change(tx, request.change_id)
        require_role(call, policy.SUSPENDERS, "suspend a change")
        require_state(change, "active", doing="suspended")
        if change.kind == "list_price":
            raise Refused("WRONG_STATE", "A list price in force is never edited (§4.2): to go back, the commercial lead creates "
                                         "a new list price and finance signs it.", {"kind": change.kind})
        if change.kind == "price_migration":
            raise Refused("WRONG_STATE", "A price migration in force is not suspended: its price is in the price list, which is "
                                         "never edited (§4.2), and the existing subscribers were asked or told already (§8). To "
                                         "go back for new subscribers, the commercial lead creates a new list price and finance "
                                         "signs it.", {"kind": change.kind})
        reason = reason_text(request.reason, "you suspend it")
        now = self.clock.now()
        await self._move(tx, change, "suspended", now, reason)
        await self._event(tx, call, now, "change.suspended", change,
                          {"version": change.current_version, "from": "active", "to": "suspended"}, reason=reason)
        await self.publisher.publish(tx, now=now, actor=call.actor, role=call.role, request_id=call.request_id,
                                     cause={"suspended": change.id})
        return changes_pb2.SuspendChangeResponse(change=await records.load_change(tx, change.id))


def encode_cursor(updated_at: str, change_id: int) -> str:
    return base64.urlsafe_b64encode(json.dumps([updated_at, change_id]).encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[str, int]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        updated_at, change_id = json.loads(base64.urlsafe_b64decode(padded.encode()))
        if not isinstance(updated_at, str) or not isinstance(change_id, int):
            raise ValueError
        format_instant(datetime.fromisoformat(updated_at.replace("Z", "+00:00")))
        return updated_at, change_id
    except (ValueError, TypeError, binascii.Error, json.JSONDecodeError) as error:
        raise InvalidArgument("page.after is not a cursor this engine gave") from error
