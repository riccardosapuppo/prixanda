"""Markets, plans, VAT rates and artists as the engine reads them for one
call: small tables, read in the call's own transaction, so that a call never
mixes reference data from two moments."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime

from commerce.domain.economics import Book, MarketTerms
from commerce.domain.localtime import format_instant, to_local
from commerce.domain.offers import Known
from commerce.domain.validation import PlanFacts
from commerce.engine.database import Connection
from commerce.engine.errors import FailedPrecondition, NotFound


@dataclass(frozen=True)
class Market:
    code: str
    name: str
    currency: str
    minor_units: int
    zone: str
    vat_bp: int  # the standard rate in force on the day the reference was read for

    def today(self, now: datetime) -> date:
        """The calendar day in the market at an instant."""
        return to_local(now, self.zone).date()

    def terms(self, book: Book) -> MarketTerms:
        return book.terms(self.currency, self.vat_bp)


@dataclass(frozen=True)
class Reference:
    markets: dict[str, Market]
    plans: dict[str, PlanFacts]

    def market(self, code: str) -> Market:
        if code not in self.markets:
            raise NotFound(f"no market {code!r}")
        return self.markets[code]

    def plan(self, plan_id: str) -> PlanFacts:
        if plan_id not in self.plans:
            raise NotFound(f"no plan {plan_id!r}")
        return self.plans[plan_id]

    def known(self, artists: frozenset[int]) -> Known:
        return Known(markets={c: m.currency for c, m in self.markets.items()},
                     plans={p.id: (p.paid, p.needs_student_check) for p in self.plans.values()}, artists=artists)


# The order the site and the console list plans in: Free first, then by seats,
# with the plan that needs a student check after the others of its size.
PLAN_ORDER = "p.paid, p.needs_student_check, p.seats, p.id"


async def load(tx: Connection, at: datetime) -> Reference:
    """Reference data with the VAT rate in force at an instant, in each market's own calendar."""
    rows = await tx.fetch(
        "select m.code, m.name, m.currency, m.minor_units::int as minor_units, m.time_zone, "
        "  (select v.rate_bp from vat_rate v where v.market = m.code "
        "     and v.valid @> ($1::text::timestamptz at time zone m.time_zone)::date) as vat_bp "
        "from market m order by m.code", format_instant(at))
    markets = {}
    for row in rows:
        if row["vat_bp"] is None:
            raise FailedPrecondition(f"no VAT rate is in force in {row['code']} at {format_instant(at)}")
        markets[row["code"].strip()] = Market(row["code"].strip(), row["name"], row["currency"].strip(),
                                              row["minor_units"], row["time_zone"], row["vat_bp"])
    plans = {row["id"]: PlanFacts(row["id"], row["name"], row["paid"], row["needs_student_check"])
             for row in await tx.fetch(f"select p.id, p.name, p.paid, p.needs_student_check from plan p order by {PLAN_ORDER}")}
    return Reference(markets, plans)


async def vat_on(tx: Connection, market: str, day: date) -> int:
    rate = await tx.fetchval("select rate_bp from vat_rate where market = $1 and valid @> $2::text::date", market, day.isoformat())
    if rate is None:
        raise FailedPrecondition(f"no VAT rate is in force in {market} on {day.isoformat()}")
    return rate


async def artist_names(tx: Connection, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = await tx.fetch("select id, name from artist where id in (select jsonb_array_elements_text($1::text::jsonb)::int)",
                          json.dumps(sorted(ids)))
    return {row["id"]: row["name"] for row in rows}
