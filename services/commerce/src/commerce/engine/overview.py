"""The console's home and the demo's people.

Five things, each leading to an action: what waits for approval, what
launches in the next seven days, today's incidents, paying subscribers by
plan and market, and this month's revenue without VAT. Revenue and the
artists' top-ups go only to finance and the commercial lead (§12); for the
other roles those fields stay empty.

"This month's revenue" is the monthly revenue of the subscriptions current at
the instant: each subscription's price net of VAT (§5.1), summed per market,
and in euros at the declared rate (§3.6). It is not accounting (§15).
Incidents arrive with the activation jobs of stage 6; until then the list is
empty.
"""

from __future__ import annotations

import json
from datetime import timedelta

from commerce.domain import policy
from commerce.domain.economics import Book
from commerce.domain.localtime import format_instant, format_local, to_instant
from commerce.domain.money import Money
from commerce.domain.offers import from_json
from commerce.engine import contract, records, reference
from commerce.engine.call import Call, Clock
from commerce.engine.changes import starts_of
from commerce.engine.database import Connection, utc_text
from commerce.v1 import common_pb2, overview_pb2

LAUNCH_WINDOW = timedelta(days=7)
UPCOMING = ("validated", "in_approval", "approved", "scheduled")
RISKS = {
    "validated": "Not submitted yet: it will not start until it is approved.",
    "in_approval": "Not approved yet: it will not start until the missing signatures arrive.",
    "approved": "Approved but not scheduled: it will not start until someone schedules it.",
}


class Overview:
    def __init__(self, clock: Clock, book: Book) -> None:
        self.clock = clock
        self.book = book

    async def get_overview(self, tx: Connection, call: Call, request: overview_pb2.GetOverviewRequest) -> overview_pb2.GetOverviewResponse:
        at = contract.instant_from_proto(request.at, "at") or self.clock.now()
        ref = await reference.load(tx, at)
        response = overview_pb2.GetOverviewResponse(exchange_rate_note=self.book.exchange_rate.note())

        waiting = await tx.fetch(f"select id, {utc_text('updated_at')} as updated_at from change where state = 'in_approval' "
                                 "order by updated_at, id")
        loaded = await records.load_changes(tx, [r["id"] for r in waiting])
        response.waiting_for_approval.extend(records.summary(loaded[r["id"]], records.iso(r["updated_at"])) for r in waiting)

        upcoming = await tx.fetch(
            "select c.id, c.title, c.state, v.content::text as content from change c join change_version v "
            "on v.change_id = c.id and v.version = c.current_version "
            "where c.state in (select jsonb_array_elements_text($1::text::jsonb)) order by c.id", json.dumps(list(UPCOMING)))
        launches = []
        for row in upcoming:
            content = from_json(json.loads(row["content"]))
            for market, moment in starts_of(content):
                instant = to_instant(moment, ref.markets[market].zone)
                if at <= instant < at + LAUNCH_WINDOW:
                    launches.append((instant, overview_pb2.Launch(
                        change_id=row["id"], title=row["title"],
                        starts=common_pb2.LocalTime(market=market, local=format_local(moment), utc=format_instant(instant)),
                        state=contract.state_to_proto(row["state"]), at_risk=row["state"] != "scheduled",
                        risk=RISKS.get(row["state"], ""))))
        response.launches_next_7_days.extend(launch for _, launch in sorted(launches, key=lambda pair: (pair[0], pair[1].change_id)))

        # Subscriptions current on each market's own calendar day.
        days = {code: m.today(at).isoformat() for code, m in ref.markets.items()}
        rows = await tx.fetch(
            "select s.market, s.plan_id, s.paid, s.price_minor, count(*)::bigint as n from subscription s "
            "join (select key as market, value::date as day from jsonb_each_text($1::text::jsonb)) d on d.market = s.market "
            "where s.started_on <= d.day and (s.ended_on is null or s.ended_on > d.day) "
            "group by 1, 2, 3, 4 order by 1, 2", json.dumps(days))
        counts: dict[tuple[str, str, bool], int] = {}
        revenue: dict[str, int] = {}
        top_ups: dict[str, int] = {}
        for row in rows:
            code = row["market"].strip()
            key = (code, row["plan_id"], row["paid"])
            counts[key] = counts.get(key, 0) + row["n"]
            if row["paid"]:
                terms = ref.markets[code].terms(self.book)
                net = terms.net(row["price_minor"])
                revenue[code] = revenue.get(code, 0) + row["n"] * net
                top_ups[code] = top_ups.get(code, 0) + row["n"] * terms.top_up(net)
        for (code, plan, paid), n in sorted(counts.items()):
            target = response.paying_subscribers if paid else response.free_listeners
            target.append(overview_pb2.SubscriberCount(market=code, plan=plan, count=n))

        if call.role in policy.REVENUE_READERS:
            rate = self.book.exchange_rate
            total = Money.zero(rate.base)
            top_up_total = Money.zero(rate.base)
            for code, market in ref.markets.items():
                amount = Money(revenue.get(code, 0), market.currency)
                in_euros = rate.to_base(amount)
                total += in_euros
                top_up_total += rate.to_base(Money(top_ups.get(code, 0), market.currency))
                response.monthly_revenue.append(overview_pb2.MarketRevenue(
                    market=code, revenue=contract.money(amount), revenue_eur=contract.money(in_euros)))
            response.monthly_revenue_eur.CopyFrom(contract.money(total))
            response.monthly_top_ups.CopyFrom(contract.money(top_up_total))
        return response

    async def list_people(self, tx: Connection, call: Call, request: overview_pb2.ListPeopleRequest) -> overview_pb2.ListPeopleResponse:
        rows = await tx.fetch(
            "select p.id, p.label, coalesce(jsonb_agg(r.role order by r.role) filter (where r.role is not null), '[]')::text as roles "
            "from person p left join person_role r on r.person_id = p.id group by p.id, p.label order by p.id")
        order = {role: n for n, role in enumerate(policy.ROLES)}
        return overview_pb2.ListPeopleResponse(people=[
            overview_pb2.Person(id=r["id"], label=r["label"],
                                roles=[contract.role_to_proto(x) for x in sorted(json.loads(r["roles"]), key=order.__getitem__)])
            for r in rows])
