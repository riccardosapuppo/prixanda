"""The invariants of the generated data that no single constraint can hold.

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
        "every_subscription_has_its_first_price",
        "§4.3: every subscription has its price from its first day, the first row of its history (migration V14 checks "
        "it when the row is written; a start moved later would leave it without one)",
        """
        select s.id as subscription, s.started_on from subscription s
        where not exists (select from subscription_price h where h.subscription_id = s.id and h.from_on = s.started_on)
        """,
    ),
    Invariant(
        "prices_are_charged_while_their_subscription_runs",
        "§8: no price of a history takes over after its subscription ended (an end moved earlier would leave one)",
        """
        select h.subscription_id as subscription, h.from_on, s.ended_on from subscription_price h
        join subscription s on s.id = h.subscription_id
        where s.ended_on is not null and h.from_on >= s.ended_on
        """,
    ),
    Invariant(
        "later_prices_follow_a_price_migration",
        "§8: a price that takes over later is set by a price migration that asked or told that subscription, from the "
        "day and at the price its request says",
        """
        select h.subscription_id as subscription, h.from_on, h.change_id from subscription_price h
        left join price_change_request r on r.change_id = h.change_id and r.subscription_id = h.subscription_id
        where h.change_id is not null
          and (r.id is null or r.state not in ('accepted', 'new_price') or r.new_price_from <> h.from_on
               or r.new_price_minor <> h.price_minor)
        """,
    ),
    Invariant(
        "paid_subscriptions_start_at_the_list_price",
        "§4.3: a paid subscription loaded with the data pays the list price in force in its market on the day it "
        "started (one confirmed from a quote pays the quote, and one from a pass pays nothing, both below; a price "
        "migration adds a later price)",
        """
        select s.id as subscription, s.plan_id as plan, s.market, h.price_minor as pays, p.amount_minor as list_price
        from subscription s
        join subscription_price h on h.subscription_id = s.id and h.from_on = s.started_on
        left join list_price p on p.plan_id = s.plan_id and p.market = s.market and p.valid @> s.started_on::timestamp
        where s.paid and s.quote_id is null and s.prepaid_code is null
          and (p.amount_minor is null or p.amount_minor <> h.price_minor)
        """,
    ),
    Invariant(
        "confirmed_subscriptions_pay_their_quote",
        "§4.5: a subscription confirmed from a quote is the quoted plan, market and offer, pays the quoted price for "
        "the quoted months, and has its demonstration receipt for that amount",
        """
        select s.id as subscription, h.price_minor as pays, q.price_minor as quoted, r.amount_minor as receipt
        from subscription s join quote q on q.id = s.quote_id
        join subscription_price h on h.subscription_id = s.id and h.from_on = s.started_on
        left join receipt r on r.subscription_id = s.id
        where h.price_minor <> q.price_minor or s.plan_id <> q.plan_id or s.market <> q.market
           or s.offer_change_id is distinct from q.offer_change_id or coalesce(s.offer_months, 0) <> q.months_at_price
           or r.amount_minor is distinct from q.price_minor
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
        "listening_weeks_sum_their_days",
        "§14.2: each listener's weekly sum of an artist is the sum of its days (migration V16 keeps them on insert; "
        "a trigger switched off, or a row changed by hand, would part them)",
        """
        select coalesce(d.artist_id, w.artist_id) as artist, coalesce(d.week, w.week) as week,
               coalesce(d.subscriber_id, w.subscriber_id) as subscriber, d.seconds as days, w.seconds as weeks
        from (select artist_id, date_trunc('week', day)::date as week, subscriber_id, sum(seconds) as seconds
              from listening_day group by 1, 2, 3) d
        full join listening_week w using (artist_id, week, subscriber_id)
        where d.seconds is distinct from w.seconds
        """,
    ),
    Invariant(
        "listening_has_its_month",
        "§14.2: every day of listening is in its month's partition: one in the default partition means a month was "
        "not added before it began (docs/runbook.md)",
        """
        select subscriber_id, artist_id, day from listening_day_other
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
    Invariant(
        "prepaid_codes_follow_their_payment",
        "§9: a code is ready, activated or expired only once its payment succeeded, with its receipt; failed only "
        "once it was declined; pending while it is",
        """
        select c.id as prepaid, c.state, p.state as payment, r.id as receipt from prepaid_code c
        left join payment p on p.prepaid_code = c.code
        left join receipt r on r.prepaid_code = c.code
        where p.id is null
           or (c.state in ('ready', 'activated', 'expired') and (p.state <> 'succeeded' or r.id is null))
           or (c.state = 'failed' and p.state <> 'failed')
           or (c.state = 'pending' and p.state <> 'pending')
        """,
    ),
    Invariant(
        "activated_codes_run_their_pass",
        "§9.1: an activated code is the subscription it was activated into: the pass's plan, in its market, from the "
        "day of activation, for its holder, with an end",
        """
        select c.id as prepaid, s.id as subscription from prepaid_code c
        left join subscription s on s.id = c.subscription_id
        where c.state = 'activated'
          and (s.id is null or s.prepaid_code is distinct from c.code or s.plan_id <> c.plan_id or s.market <> c.market
               or s.started_on <> c.activated_on or s.subscriber_id <> c.activated_by or s.ended_on is null)
        """,
    ),
    Invariant(
        "pass_subscriptions_run_their_months_never_charged",
        "§9.3: a subscription from a pass is the one its code was activated into: it pays nothing in any month, and "
        "it ends when the pass's months are over, on its billing day that many months after it started",
        """
        select s.id as subscription, c.id as prepaid, c.state, c.months, s.started_on, s.ended_on,
               (select max(h.price_minor) from subscription_price h where h.subscription_id = s.id) as pays
        from subscription s join prepaid_code c on c.code = s.prepaid_code
        where c.state <> 'activated' or c.subscription_id is distinct from s.id
           or s.ended_on is distinct from
              (date_trunc('month', s.started_on::timestamp) + make_interval(months => c.months))::date + (s.billing_day - 1)
           or exists (select from subscription_price h where h.subscription_id = s.id and h.price_minor <> 0)
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
