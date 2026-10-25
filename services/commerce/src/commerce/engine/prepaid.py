"""Prepaid passes on sale, their codes, and the value finance reads (business
book §9, §14.4).

A pass is on sale in a market while its change is active and the market's
period holds the instant (on_sale). A purchase writes the code, pending,
with its payment and the outbox message that asks the provider for it, in
one transaction, as a confirmation does (subscribers.py, payments.py); the
provider's events settle it: succeeded, the code is ready; declined, it
failed and never works. An activation turns a ready code into a
subscription of the pass's plan for its months, never charged and never
renewed, and the free plan after them. A ready code not activated by its
last day expires, once, by the engine's jobs (expire_due).

A code is a bearer secret: it is shown to its buyer, and to whoever
activated it; the audit log, the outbox and the engine's log name it by its
number (prepaid:<id>).
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from datetime import date, datetime

from commerce.domain import prepaid as rules
from commerce.domain.localtime import format_instant, to_instant
from commerce.domain.money import Money
from commerce.domain.offers import OfferPage, PrepaidPass, from_json
from commerce.engine import contract, payments, records, reference
from commerce.engine.call import Call, Clock
from commerce.engine.catalog import market_code
from commerce.engine.database import Connection, Database, utc_text
from commerce.v1 import catalog_pb2, subscriptions_pb2

ACTOR, ROLE = "prepaid", "system"


def subject(code_id: int) -> str:
    return f"prepaid:{code_id}"


def new_code() -> str:
    letters = "".join(secrets.choice(rules.ALPHABET) for _ in range(12))
    return f"{letters[:4]}-{letters[4:8]}-{letters[8:]}"


@dataclass(frozen=True)
class OnSale:
    change_id: int
    version: int
    market: str
    title: str
    plan: str
    months: int
    price: Money
    code_valid_months: int
    page: OfferPage | None


async def on_sale(tx: Connection, at: datetime) -> list[OnSale]:
    """The passes on sale at an instant: active, priced in the market, and within the market's period there."""
    rows = await tx.fetch(
        "select c.id, c.current_version as version, v.content::text as content from change c "
        "join change_version v on v.change_id = c.id and v.version = c.current_version "
        "where c.kind = 'prepaid' and c.state = 'active' order by c.id")
    if not rows:
        return []
    ref = await reference.load(tx, at)
    found = []
    for row in rows:
        content = from_json(json.loads(row["content"]))
        assert isinstance(content, PrepaidPass)
        for price in content.prices:
            period = content.period_in(price.market)
            market = ref.markets.get(price.market)
            if market is None or price.fixed is None or period is None or period.starts is None:
                continue
            if to_instant(period.starts, market.zone) > at:
                continue
            if period.ends is not None and to_instant(period.ends, market.zone) <= at:
                continue
            found.append(OnSale(row["id"], row["version"], price.market, content.title, content.plan or "", content.months,
                                price.fixed, content.code_valid_months, content.page_in(price.market)))
    return found


class Catalog:
    """The site's list of passes on sale."""

    def __init__(self, clock: Clock) -> None:
        self.clock = clock

    async def list_passes(self, tx: Connection, call: Call,
                          request: catalog_pb2.ListPrepaidPassesRequest) -> catalog_pb2.ListPrepaidPassesResponse:
        code = market_code(request.market)
        passes = [p for p in await on_sale(tx, self.clock.now()) if p.market == code]
        return catalog_pb2.ListPrepaidPassesResponse(passes=[catalog_pb2.PrepaidPassOnSale(
            pass_id=p.change_id, market=p.market, title=p.title, plan=p.plan, months=p.months, price=contract.money(p.price),
            code_valid_months=p.code_valid_months, text=p.page.text if p.page else "", terms=p.page.terms if p.page else "")
            for p in passes])


# -- the codes, as the account shows them ----------------------------------------

_CODE = (f"select p.id, p.code, p.change_id, c.title, p.plan_id, p.market, p.currency, p.months, p.price_minor, "
         f"{utc_text('p.sold_at')} as sold_at, p.valid_until::text as valid_until, p.state, p.activated_by, "
         f"p.activated_on::text as activated_on from prepaid_code p join change c on c.id = p.change_id ")


async def code_message(tx: Connection, row) -> subscriptions_pb2.PrepaidCode:
    currency = row["currency"].strip()
    message = subscriptions_pb2.PrepaidCode(
        code=row["code"], pass_id=row["change_id"], title=row["title"], plan=row["plan_id"], market=row["market"].strip(),
        months=row["months"], price=contract.money(Money(row["price_minor"], currency)), sold_at=records.iso(row["sold_at"]),
        valid_until=row["valid_until"], state=row["state"], activated_by=row["activated_by"] or 0,
        activated_on=row["activated_on"] or "")
    payment = await payments.of_prepaid(tx, row["code"])
    if payment is not None:
        message.payment.CopyFrom(payment)
    return message


async def bought_by(tx: Connection, subscriber_id: int) -> list[subscriptions_pb2.PrepaidCode]:
    rows = await tx.fetch(_CODE + "where p.buyer_id = $1 order by p.sold_at desc, p.id desc", subscriber_id)
    return [await code_message(tx, row) for row in rows]


async def code_row(tx: Connection, code: str, *, lock: bool = False):
    if lock:
        await tx.execute("select 1 from prepaid_code where code = $1 for update", code)
    return await tx.fetchrow(_CODE + "where p.code = $1", code)


# -- finance's figures ------------------------------------------------------------

async def value_by_market(tx: Connection, days: dict[str, date]) -> dict[str, rules.Value]:
    """Each market's codes paid for, activated and expired, and their value not yet earned on the market's day."""
    rows = await tx.fetch(
        "select market, net_minor, months, state, activated_on::text as activated_on from prepaid_code "
        "where state in ('ready', 'activated', 'expired') order by market, id")
    sold: dict[str, list[rules.Sold]] = {}
    for row in rows:
        code = row["market"].strip()
        activated = date.fromisoformat(row["activated_on"]) if row["activated_on"] else None
        sold.setdefault(code, []).append(rules.Sold(row["net_minor"], row["months"], row["state"], activated))
    return {code: rules.value(codes, days[code]) for code, codes in sold.items()}


async def untouched(tx: Connection, market: str, plan: str, day: date) -> int:
    """The passes of a plan in a market that a price change does not touch on a day (§8.7): those running, and
    those sold and not yet activated."""
    return await tx.fetchval(
        "select (select count(*) from subscription s where s.market = $1 and s.plan_id = $2 and s.prepaid_code is not null "
        "        and s.started_on <= $3::text::date and (s.ended_on is null or s.ended_on > $3::text::date)) "
        "     + (select count(*) from prepaid_code p where p.market = $1 and p.plan_id = $2 and p.state = 'ready')",
        market, plan, day.isoformat())


# -- the end of codes not used ------------------------------------------------------

@dataclass(frozen=True)
class Expired:
    code_id: int
    market: str
    valid_until: str


class Expiry:
    def __init__(self, db: Database, clock: Clock) -> None:
        self.db = db
        self.clock = clock

    async def expire_due(self) -> list[Expired]:
        """Every ready code past its last day, in its market's calendar, expires: once, each in its own transaction."""
        now = self.clock.now()
        async with self.db.transaction(readonly=True) as tx:
            ref = await reference.load(tx, now)
            due = []
            for code, market in ref.markets.items():
                due += [r["id"] for r in await tx.fetch(
                    "select id from prepaid_code where state = 'ready' and market = $1 and valid_until < $2::text::date "
                    "order by id", code, market.today(now).isoformat())]
        done = []
        # Each code in a transaction of its own, but not set apart as the price migrations' windows are
        # (migrations.settle_due): a code that could not expire would hold up the codes after it in the pass, though
        # not the other jobs (jobs.py). Nothing known makes one fail.
        for code_id in due:
            async with self.db.transaction() as tx:
                row = await tx.fetchrow("select id, market, valid_until::text as valid_until, state "
                                        "from prepaid_code where id = $1 for update", code_id)
                if row["state"] != "ready":
                    continue
                await tx.execute("update prepaid_code set state = 'expired', expired_at = $2::text::timestamptz where id = $1",
                                 code_id, format_instant(now))
                await records.record(tx, at=now, actor=ACTOR, role=ROLE, action="prepaid.expired", subject=subject(code_id),
                                     request_id=f"prepaid-{code_id}-expiry", body={
                                         "prepaid": code_id, "market": row["market"].strip(), "from": "ready", "to": "expired",
                                         "valid_until": row["valid_until"]})
                done.append(Expired(code_id, row["market"].strip(), row["valid_until"]))
        return done


__all__ = ["Catalog", "Expiry", "OnSale", "bought_by", "code_row", "new_code", "on_sale", "untouched", "value_by_market"]
