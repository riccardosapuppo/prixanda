"""The console's home and the demo's people.

Five things, each leading to an action: what waits for approval, what
launches in the next seven days, today's incidents, paying subscribers by
plan and market, and this month's revenue without VAT. Revenue and the
artists' top-ups go only to finance and the commercial lead (§12); for the
other roles those fields stay empty.

"This month's revenue" is the monthly revenue of the subscriptions current at
the instant: what each subscription costs on its market's day, by the rules
of its charges that the account shows too (charging.py: after an offer's
months, the list price), net of VAT (§5.1), summed per market, and in euros
at the declared rate (§3.6). It is not accounting (§15).

Today's incidents are those of the launches (launches.py): the ones open at
the instant, and those opened or closed on its day in UTC, each in the state
it was in at the instant.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, time, timedelta

from commerce.domain import policy
from commerce.domain.economics import Book
from commerce.domain.localtime import format_instant, format_local, to_instant
from commerce.domain.money import Money
from commerce.domain.offers import from_json
from commerce.engine import charging, contract, records, reference
from commerce.engine.call import Call, Clock
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
            for market, moment in records.starts_of(content):
                instant = to_instant(moment, ref.markets[market].zone)
                if at <= instant < at + LAUNCH_WINDOW:
                    launches.append((instant, overview_pb2.Launch(
                        change_id=row["id"], title=row["title"],
                        starts=common_pb2.LocalTime(market=market, local=format_local(moment), utc=format_instant(instant)),
                        state=contract.state_to_proto(row["state"]), at_risk=row["state"] != "scheduled",
                        risk=RISKS.get(row["state"], ""))))
        response.launches_next_7_days.extend(launch for _, launch in sorted(launches, key=lambda pair: (pair[0], pair[1].change_id)))

        day = datetime.combine(at.astimezone(UTC).date(), time.min, tzinfo=UTC)
        for row in await tx.fetch(
                f"select i.id, i.launch_id, i.kind, i.state, i.summary, {utc_text('i.opened_at')} as opened_at, "
                f"{utc_text('i.closed_at')} as closed_at, i.resolution, l.change_id, c.title from incident i "
                "join launch l on l.id = i.launch_id join change c on c.id = l.change_id "
                "where i.opened_at <= $1::text::timestamptz and (i.closed_at is null or i.closed_at > $1::text::timestamptz "
                "or i.opened_at >= $2::text::timestamptz or i.closed_at >= $2::text::timestamptz) "
                "order by i.opened_at desc, i.id desc", format_instant(at), format_instant(day)):
            closed = row["closed_at"] is not None and records.iso(row["closed_at"]) <= format_instant(at)
            response.incidents_today.append(overview_pb2.Incident(
                change_id=row["change_id"], title=row["title"], run=f"launch-{row['launch_id']}",
                state=row["state"] if closed else "open", summary=row["summary"], launch_id=row["launch_id"],
                kind=row["kind"], opened_at=records.iso(row["opened_at"]),
                closed_at=records.iso(row["closed_at"]) if closed else "",
                resolution=(row["resolution"] or "") if closed else ""))

        # Subscriptions current on each market's own calendar day. Those taken with an offer are grouped by what
        # decides their price on the day (their start, billing day and months); the others by their price alone.
        days = {code: m.today(at) for code, m in ref.markets.items()}
        rows = await tx.fetch(
            "select s.market, s.plan_id, s.paid, s.price_minor, coalesce(s.offer_months, 0) as offer_months, "
            "case when s.offer_months is null then null else s.started_on::text end as started_on, "
            "case when s.offer_months is null then null else s.billing_day end as billing_day, count(*)::bigint as n "
            "from subscription s "
            "join (select key as market, value::date as day from jsonb_each_text($1::text::jsonb)) d on d.market = s.market "
            "where s.started_on <= d.day and (s.ended_on is null or s.ended_on > d.day) "
            "group by 1, 2, 3, 4, 5, 6, 7 order by 1, 2",
            json.dumps({code: day.isoformat() for code, day in days.items()}))
        counts: dict[tuple[str, str, bool], int] = {}
        revenue: dict[str, int] = {}
        top_ups: dict[str, int] = {}
        for row in rows:
            code = row["market"].strip()
            key = (code, row["plan_id"], row["paid"])
            counts[key] = counts.get(key, 0) + row["n"]
            if row["paid"]:
                market = ref.markets[code]
                price = row["price_minor"]
                if row["offer_months"]:
                    price = (await charging.standing(
                        tx, market, plan_id=row["plan_id"], price_minor=price, started_on=date.fromisoformat(row["started_on"]),
                        billing_day=row["billing_day"], offer_months=row["offer_months"], day=days[code])).price.amount
                terms = market.terms(self.book)
                net = terms.net(price)
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
