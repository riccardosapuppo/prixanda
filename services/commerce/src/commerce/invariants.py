"""The invariants of Encore's data that no single constraint can hold.

    python -m commerce.invariants --url <URL> [--anchor <seq>:<hash>]

The schema already refuses what one row or one table can get wrong
(overlapping prices, an author approving their own version, an edited audit
event). Repeating those here would add checks that cannot fail. These are the
rules that span tables or time, plus the audit chain, which can be broken by
someone who switches the guards off.

Each invariant is a query returning the rows that break it. The report says
how many invariants ran and shows up to five examples of each violation;
the exit code is 1 when there is one.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass

import asyncpg

from commerce.audit import Anchor, verify_chain


@dataclass(frozen=True)
class Invariant:
    name: str
    rule: str
    query: str


INVARIANTS = [
    Invariant(
        "prices_cover_every_paid_plan",
        "§4.1: every paid plan has a price in every market at every moment since the price list began",
        """
        with started as (select min(lower(valid)) as at from list_price),
             covered as (select plan_id, market, range_agg(valid) as periods from list_price group by 1, 2)
        select p.id as plan, m.code as market, c.periods::text as periods
        from plan p cross join market m cross join started s
        left join covered c on c.plan_id = p.id and c.market = m.code
        where p.paid and (c.periods is null or c.periods <> tsmultirange(tsrange(s.at, null)))
        """,
    ),
    Invariant(
        "entitlements_cover_every_plan",
        "§2.2: every plan, Free included, says what it includes in every market at every moment",
        """
        with started as (select min(lower(valid)) as at from plan_entitlement),
             covered as (select plan_id, market, range_agg(valid) as periods from plan_entitlement group by 1, 2)
        select p.id as plan, m.code as market, c.periods::text as periods
        from plan p cross join market m cross join started s
        left join covered c on c.plan_id = p.id and c.market = m.code
        where c.periods is null or c.periods <> tsmultirange(tsrange(s.at, null))
        """,
    ),
    Invariant(
        "vat_rates_cover_the_price_list",
        "§3.3: every market has a VAT rate in force on every day the price list covers",
        """
        with started as (select min(lower(valid))::date as day from list_price)
        select m.code as market
        from market m cross join started s
        where not coalesce((select range_agg(v.valid) @> daterange(s.day, null) from vat_rate v where v.market = m.code), false)
        """,
    ),
    Invariant(
        "every_subscriber_is_on_one_plan_every_day",
        "§13: from the day they join, a subscriber is always on exactly one plan, Free included: "
        "subscriptions follow each other with no gap, and the last one is open",
        """
        with ordered as (
          select s.subscriber_id, s.started_on, s.ended_on, b.joined_on,
                 lag(s.ended_on) over w as previous_end,
                 row_number() over w as n
          from subscription s join subscriber b on b.id = s.subscriber_id
          window w as (partition by s.subscriber_id order by s.started_on))
        select subscriber_id, started_on, previous_end, joined_on from ordered
        where (n = 1 and started_on <> joined_on) or (n > 1 and started_on is distinct from previous_end)
        union all
        select b.id, null, null, b.joined_on from subscriber b
        where not exists (select from subscription s where s.subscriber_id = b.id and s.ended_on is null)
        """,
    ),
    Invariant(
        "paid_subscriptions_start_at_the_list_price",
        "§4.3: a paid subscription pays the list price in force in its market on the day it started "
        "(until offers and price migrations arrive, in stages 2 and 7)",
        """
        select s.id as subscription, s.plan_id as plan, s.market, s.price_minor as pays, p.amount_minor as list_price
        from subscription s
        left join list_price p on p.plan_id = s.plan_id and p.market = s.market and p.valid @> s.started_on::timestamp
        where s.paid and (p.amount_minor is null or p.amount_minor <> s.price_minor)
        """,
    ),
    Invariant(
        "student_subscriptions_start_verified",
        "§10: a Student subscription starts while a student verification of that person is valid",
        """
        select s.id as subscription, s.subscriber_id, s.started_on from subscription s
        where s.plan_id = 'student' and not exists (
          select from student_verification v
          where v.subscriber_id = s.subscriber_id and v.verified_on <= s.started_on and s.started_on < v.valid_until)
        """,
    ),
    Invariant(
        "nobody_listens_before_joining",
        "§13: listening data starts on the day a subscriber joined",
        """
        select l.subscriber_id, l.day, b.joined_on from listening_day l join subscriber b on b.id = l.subscriber_id
        where l.day < b.joined_on
        """,
    ),
    Invariant(
        "approved_changes_carry_a_signature",
        "§7.3: a change at or past approval has, on its current version, a signature from someone other than its author",
        """
        select c.id as change, c.state, c.current_version from change c
        where c.state in ('approved', 'scheduled', 'active', 'ended', 'suspended')
          and not exists (select from approval a where a.change_id = c.id and a.version = c.current_version
                          and a.approver <> a.author)
        """,
    ),
]

CHAIN = Invariant("audit_chain_verifies", "§11.3: every event of the audit log follows the one before it", "")


async def check(conn: asyncpg.Connection, anchor: Anchor | None = None) -> dict:
    results = []
    for invariant in INVARIANTS:
        rows = await conn.fetch(invariant.query)
        results.append({"name": invariant.name, "rule": invariant.rule, "violations": len(rows),
                        "examples": [{k: str(v) for k, v in dict(r).items()} for r in rows[:5]]})
    chain = await verify_chain(conn, anchor)
    results.append({"name": CHAIN.name, "rule": CHAIN.rule, "violations": 0 if chain.ok else 1,
                    "examples": [] if chain.ok else [chain.as_dict()]})
    broken = [r for r in results if r["violations"]]
    return {"checked": len(results), "broken": len(broken), "invariants": results}


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", required=True)
    parser.add_argument("--anchor", help="an exported head of the audit log, as <seq>:<hash in hex>")
    args = parser.parse_args()
    anchor = None
    if args.anchor:
        seq, _, digest = args.anchor.partition(":")
        anchor = Anchor(int(seq), bytes.fromhex(digest))
    conn = await asyncpg.connect(args.url)
    try:
        report = await check(conn, anchor)
    finally:
        await conn.close()
    print(json.dumps(report, indent=2))
    return 1 if report["broken"] else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
