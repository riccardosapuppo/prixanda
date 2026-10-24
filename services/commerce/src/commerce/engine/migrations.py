"""Price migrations with the existing subscribers (business book §8, §14.3).

When a migration starts (its launch publishes it, launches.py), every
subscription of the plan in the market that is paid on that day gets a
request: for consent where the market's law asks for it (Germany), a notice
elsewhere. The outbox delivers each one to the listener's inbox.

A consent request waits for the listener's answer until the end of its
window. Yes: the new price from the listener's first charge after the answer,
and not before new subscribers pay it. No, or no answer by the end (silence is
never consent): the market's commercial choice, a setting and not law (§8.6).
Today in Germany the account moves to the free plan, keeping its playlists and
library, when the period already paid at the deadline runs out.

A notice tells the listener the new price and when it applies: from the
first charge after the notice ran out (30 days in the data), and not before
new subscribers pay it. No means leaving, on the day the new price would
first have been charged.

A month already paid is never cut short, and nothing is charged on the day a
subscription leaves (domain/migration.py has the dates). A subscription still
in its offer's months pays the offer price for them (§6.1): the new price
applies only after them, and until it does, what it pays after them is the
price before the migration, never the new one (charging.py).

A no ends the subscription at once, on its day; the end of each window is
acted on by the engine's jobs (settle_due), once each: a lapsed consent ends
the subscription, a notice that ran out sets the new price, and every request
that changed a subscription sends the listener its outcome.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from commerce.domain import billing
from commerce.domain.localtime import describe_local, format_instant, format_local, to_instant, to_local
from commerce.domain.migration import Charges, Policy, leaving_day, new_price_from
from commerce.domain.money import Money, format_money
from commerce.domain.offers import PriceMigration, from_json
from commerce.engine import charging, contract, outbox, records, reference
from commerce.engine.call import Call, Clock
from commerce.engine.database import Connection, Database, utc_text
from commerce.engine.errors import InvalidArgument, NotFound, Refused
from commerce.v1 import common_pb2, subscriptions_pb2

ACTOR, ROLE = "migrations", "system"
SUBSCRIBER_ROLE = "subscriber"
REQUEST, OUTCOME = "price_change.request", "price_change.outcome"


def _date(text: str) -> date:
    return date.fromisoformat(text)


def settlement(change_id: int) -> str:
    """The request id of what the end of a migration's windows writes: its audit events, its messages."""
    return f"migration-{change_id}-settlement"


def charges_of(row) -> Charges:
    """A subscription's charges, from a row with its started_on (as text), billing_day and offer_months."""
    started = _date(row["started_on"])
    months = row["offer_months"] or 0
    return Charges(started, row["billing_day"], billing.billing_date(started, row["billing_day"], months) if months else None)


@dataclass(frozen=True)
class Opened:
    asked: int
    window_ends: datetime  # local


async def open_requests(tx: Connection, *, change_id: int, content: PriceMigration, market: reference.Market,
                        policy: Policy, now: datetime, request_id: str) -> Opened:
    """A request for each subscription of the plan in the market paid on the day, and its message to the listener.
    Called before the new list price enters the price list, so that what a subscription pays without the change, after
    its offer's months too, is read as it stands."""
    assert content.plan and content.amount is not None
    today = market.today(now)
    window_ends_local = policy.window_ends(to_local(now, market.zone))
    window_ends_at = to_instant(window_ends_local, market.zone)
    rows = await tx.fetch(
        "select s.id, s.subscriber_id, s.started_on::text as started_on, s.billing_day, s.offer_months, "
        "(select max(p.from_on)::text from subscription_price p where p.subscription_id = s.id) as last_from "
        "from subscription s where s.market = $1 and s.plan_id = $2 and s.paid and s.started_on <= $3::text::date "
        "and (s.ended_on is null or s.ended_on > $3::text::date) order by s.id",
        market.code, content.plan, today.isoformat())
    asked = 0
    for row in rows:
        # What it pays without the change from its latest price on: after its offer, after a price already set.
        charges = charges_of(row)
        day = max(today, _date(row["last_from"]), charges.offer_ends or today)
        old = (await charging.standing(tx, market, subscription_id=row["id"], plan_id=content.plan,
                                       started_on=charges.started_on, billing_day=charges.billing_day,
                                       offer_months=row["offer_months"] or 0, day=day)).price.amount
        if old >= content.amount.amount:
            continue  # it already pays as much: nothing to ask
        request = await tx.fetchval(
            "insert into price_change_request (change_id, subscription_id, subscriber_id, market, plan_id, kind, old_price_minor, "
            "new_price_minor, sent_at, window_ends_local, window_ends_at, request_id) values ($1, $2, $3, $4, $5, $6, $7, $8, "
            "$9::text::timestamptz, $10::text::timestamp, $11::text::timestamptz, $12) returning id",
            change_id, row["id"], row["subscriber_id"], market.code, content.plan, policy.legal_requirement, old,
            content.amount.amount, format_instant(now), format_local(window_ends_local), format_instant(window_ends_at),
            request_id)
        await outbox.write(tx, topic=REQUEST, key=f"request:{request}", now=now, request_id=request_id,
                           payload={"price_change": request, "subscriber": row["subscriber_id"]})
        asked += 1
    return Opened(asked, window_ends_local)


# -- what the listener sees and answers ---------------------------------------

_REQUEST = (f"select r.id, r.change_id, r.subscription_id, r.subscriber_id, r.market, r.plan_id, r.kind, r.old_price_minor, "
            f"r.new_price_minor, {utc_text('r.sent_at')} as sent_at, to_char(r.window_ends_local, 'YYYY-MM-DD\"T\"HH24:MI') "
            f"as window_ends_local, {utc_text('r.window_ends_at')} as window_ends_at, r.state, r.answer, "
            f"r.new_price_from::text as new_price_from, r.leaves_on::text as leaves_on, r.settled_at, "
            f"s.started_on::text as started_on, s.billing_day, s.offer_months, v.content::text as content "
            f"from price_change_request r join subscription s on s.id = r.subscription_id "
            f"join change c on c.id = r.change_id join change_version v on v.change_id = c.id and v.version = c.current_version ")


@dataclass(frozen=True)
class Request:
    """A request read with what its dates depend on."""

    row: Any  # a record of _REQUEST
    policy: Policy
    migration: PriceMigration
    charges: Charges

    @property
    def starts(self) -> date:
        assert self.migration.starts is not None
        return self.migration.starts.date()

    @property
    def window_ends(self) -> date:
        """The deadline's day, in the market's calendar."""
        return _date(self.row["window_ends_local"][:10])

    def open(self, now: datetime) -> bool:
        """Whether the listener may still answer: no answer yet, and the window has not ended."""
        return self.row["answer"] is None and now < datetime.fromisoformat(self.row["window_ends_at"].replace("Z", "+00:00"))

    def new_price_from(self, yes_on: date | None = None) -> date:
        return new_price_from(self.policy, self.charges, starts=self.starts, window_ends=self.window_ends, yes_on=yes_on)

    def leaving_day(self) -> date | None:
        return leaving_day(self.policy, self.charges, starts=self.starts, window_ends=self.window_ends)


async def _read(tx: Connection, where: str, *args) -> list[Request]:
    rows = await tx.fetch(_REQUEST + where, *args)
    if not rows:
        return []
    rules = await reference.policies(tx)
    out = []
    for row in rows:
        migration = from_json(json.loads(row["content"]))
        assert isinstance(migration, PriceMigration)
        out.append(Request(row, rules[row["market"].strip()], migration, charges_of(row)))
    return out


def if_no_answer(policy: Policy) -> str:
    return f"{policy.commercial_choice} This is the music service's choice for the market, not a legal requirement."


def legal_words(policy: Policy) -> str:
    return f"{policy.legal_basis} Sources: {'; '.join(policy.legal_sources)}."


def price_change_message(request: Request, market: reference.Market, now: datetime) -> subscriptions_pb2.PriceChange:
    row, policy = request.row, request.policy
    starts = request.migration.starts
    assert starts is not None
    message = subscriptions_pb2.PriceChange(
        price_change_id=row["id"], change_id=row["change_id"], plan=row["plan_id"],
        old_price=contract.money(Money(row["old_price_minor"], market.currency)),
        new_price=contract.money(Money(row["new_price_minor"], market.currency)), kind=row["kind"],
        sent_at=records.iso(row["sent_at"]),
        window_ends=common_pb2.LocalTime(market=market.code, local=row["window_ends_local"],
                                         utc=records.iso(row["window_ends_at"])),
        state=row["state"], new_price_from=row["new_price_from"] or "", if_no_answer=if_no_answer(policy),
        legal_basis=legal_words(policy),
        new_subscribers_from=common_pb2.LocalTime(market=market.code, local=format_local(starts)[:16],
                                                  utc=format_instant(to_instant(starts, market.zone))),
        leaves_on=row["leaves_on"] or "")
    if row["state"] == "waiting":
        can_answer = request.open(now)
        if policy.consent:
            if can_answer:
                message.applies_from = request.new_price_from(yes_on=market.today(now)).isoformat()
            leaves = request.leaving_day()
        else:
            message.applies_from = request.new_price_from().isoformat()
            leaves = request.leaving_day() if can_answer else None
        message.if_no_leaves_on = leaves.isoformat() if leaves is not None else ""
    return message


async def of_subscription(tx: Connection, subscription_id: int, market: reference.Market,
                          now: datetime) -> list[subscriptions_pb2.PriceChange]:
    return [price_change_message(r, market, now)
            for r in await _read(tx, "where r.subscription_id = $1 order by r.sent_at desc, r.id desc", subscription_id)]


async def ends_on(tx: Connection, subscription_id: int, ended_on: date | None) -> date | None:
    """The day a paid subscription ends if the listener does nothing more: the end it has, or, while a consent request
    waits, the one that comes without a yes."""
    if ended_on is not None:
        return ended_on
    waiting = await _read(tx, "where r.subscription_id = $1 and r.state = 'waiting' and r.kind = 'consent' "
                              "order by r.id desc limit 1", subscription_id)
    return waiting[0].leaving_day() if waiting else None


async def _new_price(tx: Connection, request: Request, from_on: date) -> bool:
    """The new price in the subscription's history from a day, while it runs then. False when it no longer runs."""
    row = request.row
    running = await tx.fetchval(
        "select ended_on is null or ended_on > $2::text::date from subscription where id = $1", row["subscription_id"],
        from_on.isoformat())
    if not running:
        return False
    await tx.execute("insert into subscription_price (subscription_id, from_on, price_minor, change_id) "
                     "values ($1, $2::text::date, $3, $4)",
                     row["subscription_id"], from_on.isoformat(), row["new_price_minor"], row["change_id"])
    return True


async def _leave(tx: Connection, request: Request, market: reference.Market, leaves_on: date) -> bool:
    """The paid subscription ends on a day, and the free plan starts that day (§8.2: playlists and library are kept).
    False when it ends by then anyway."""
    sub = await tx.fetchrow("select id, subscriber_id, ended_on::text as ended_on from subscription where id = $1 for update",
                            request.row["subscription_id"])
    if sub["ended_on"] is not None and _date(sub["ended_on"]) <= leaves_on:
        return False
    await tx.execute("update subscription set ended_on = $2::text::date where id = $1", sub["id"], leaves_on.isoformat())
    await charging.write_subscription(tx, market, subscriber_id=sub["subscriber_id"], plan_id="free", paid=False,
                                      price=Money.zero(market.currency), started_on=leaves_on,
                                      billing_day=billing.billing_day_for(leaves_on))
    return True


@dataclass(frozen=True)
class Settled:
    """What the end of one window did: the request's state, and its effect on the subscription."""

    price_change: int
    change: int
    subscription: int
    state: str
    effect: str  # left, new_price or none
    dates: dict[str, str]


class Migrations:
    def __init__(self, db: Database, clock: Clock) -> None:
        self.db = db
        self.clock = clock

    async def answer(self, tx: Connection, call: Call,
                     request: subscriptions_pb2.AnswerPriceChangeRequest) -> subscriptions_pb2.AnswerPriceChangeResponse:
        if request.subscriber_id <= 0 or request.price_change_id <= 0:
            raise InvalidArgument("subscriber_id names the listener of the site's session, and price_change_id the change")
        exists = await tx.fetchval("select id from price_change_request where id = $1 and subscriber_id = $2 for update",
                                   request.price_change_id, request.subscriber_id)
        if exists is None:
            raise NotFound(f"no price change {request.price_change_id} for this listener")
        [asked] = await _read(tx, "where r.id = $1", request.price_change_id)
        row = asked.row
        now = self.clock.now()
        market = (await reference.load(tx, now)).market(row["market"].strip())
        said = "yes" if request.accept else "no"
        if row["answer"] is not None:
            if row["answer"] == said:
                return subscriptions_pb2.AnswerPriceChangeResponse(price_change=price_change_message(asked, market, now))
            raise Refused("WRONG_STATE", "This price change was answered already, and the answer stays.",
                          {"state": row["state"], "answer": row["answer"]})
        if not asked.open(now):
            ends = describe_local(datetime.fromisoformat(row["window_ends_local"]), market.zone)
            raise Refused("WRONG_STATE", f"The time to answer ended on {ends}.", {"state": row["state"]})
        dates: dict[str, str] = {}
        state = "waiting"  # a yes to a notice: it runs out on its own, and the yes only says the listener read it
        if request.accept and asked.policy.consent:
            from_on = asked.new_price_from(yes_on=market.today(now))
            await _new_price(tx, asked, from_on)
            state, dates["new_price_from"] = "accepted", from_on.isoformat()
        elif not request.accept:
            state = "declined"
            leaves = asked.leaving_day()
            if leaves is not None and await _leave(tx, asked, market, leaves):
                dates["leaves_on"] = leaves.isoformat()
        await tx.execute(
            "update price_change_request set state = $2, answer = $3, answered_at = $4::text::timestamptz, "
            "new_price_from = $5::text::date, leaves_on = $6::text::date where id = $1",
            row["id"], state, said, format_instant(now), dates.get("new_price_from"), dates.get("leaves_on"))
        await records.record(tx, at=now, actor=f"subscriber-{row['subscriber_id']}", role=SUBSCRIBER_ROLE,
                             action="price_change.answered", subject=f"subscription:{row['subscription_id']}",
                             request_id=call.request_id, body={
                                 "subscriber": row["subscriber_id"], "price_change": row["id"], "change": row["change_id"],
                                 "kind": row["kind"], "answer": said, "from": row["state"], "to": state, **dates})
        [answered] = await _read(tx, "where r.id = $1", row["id"])
        return subscriptions_pb2.AnswerPriceChangeResponse(price_change=price_change_message(answered, market, now))

    # -- the end of the windows ---------------------------------------------------

    async def settle_due(self) -> list[Settled]:
        """Acts on every window that ended: once each, in its own transaction. Returns what it did, for the log."""
        now = self.clock.now()
        async with self.db.transaction(readonly=True) as tx:
            due = [r["id"] for r in await tx.fetch(
                "select id from price_change_request where settled_at is null and window_ends_at <= $1::text::timestamptz "
                "order by window_ends_at, id", format_instant(now))]
        done = []
        for request_id in due:
            async with self.db.transaction() as tx:
                outcome = await self._settle(tx, request_id)
                if outcome is not None:
                    done.append(outcome)
        return done

    async def _settle(self, tx: Connection, request_id: int) -> Settled | None:
        await tx.execute("select id from price_change_request where id = $1 for update", request_id)
        [asked] = await _read(tx, "where r.id = $1", request_id)
        row = asked.row
        if row["settled_at"] is not None:
            return None
        now = self.clock.now()
        state, effect, dates = row["state"], "none", {}
        if row["leaves_on"] is not None:  # a no that ended the subscription
            effect, dates = "left", {"leaves_on": row["leaves_on"]}
        elif state == "waiting" and asked.policy.consent:
            state = "lapsed"  # silence is never consent (§8.2)
            leaves = asked.leaving_day()
            market = (await reference.load(tx, now)).market(row["market"].strip())
            if leaves is not None and await _leave(tx, asked, market, leaves):
                effect, dates = "left", {"leaves_on": leaves.isoformat()}
        elif state == "waiting":
            from_on = asked.new_price_from()
            state, dates = "new_price", {"new_price_from": from_on.isoformat()}
            if await _new_price(tx, asked, from_on):
                effect = "new_price"
        await tx.execute(
            "update price_change_request set state = $2, settled_at = $3::text::timestamptz, "
            "new_price_from = coalesce(new_price_from, $4::text::date), leaves_on = coalesce(leaves_on, $5::text::date) "
            "where id = $1", row["id"], state, format_instant(now), dates.get("new_price_from"), dates.get("leaves_on"))
        if effect != "none":
            action = "subscription.left_after_price_change" if effect == "left" else "subscription.price_changed"
            await records.record(tx, at=now, actor=ACTOR, role=ROLE, action=action, subject=f"subscription:{row['subscription_id']}",
                                 request_id=settlement(row["change_id"]), body={
                                     "subscriber": row["subscriber_id"], "price_change": row["id"], "change": row["change_id"],
                                     "kind": row["kind"], "state": state, **dates})
            await outbox.write(tx, topic=OUTCOME, key=f"outcome:{row['id']}", now=now, request_id=settlement(row["change_id"]),
                               payload={"price_change": row["id"], "subscriber": row["subscriber_id"], "effect": effect, **dates})
        return Settled(row["id"], row["change_id"], row["subscription_id"], state, effect, dates)


class SubscriberInbox:
    """The listeners' consumer of the price changes' messages: a request for consent, a notice, an outcome. A listener
    with a mailbox would get an email; here the inbox is a table (subscriber_notice), written in a transaction of its
    own as an outside consumer would write it, one row per message however often it arrives."""

    name = "listeners"

    def __init__(self, db: Database, clock: Clock, topic: str) -> None:
        self.db = db
        self.clock = clock
        self.topic = topic

    async def deliver(self, message: outbox.Message) -> dict[str, object]:
        async with self.db.transaction() as tx:
            [asked] = await _read(tx, "where r.id = $1", message.payload["price_change"])
            now = self.clock.now()
            market = (await reference.load(tx, now)).market(asked.row["market"].strip())
            subject, body = _words(message.topic, asked, market, message.payload)
            arrivals = await tx.fetchval(
                "insert into subscriber_notice (message_id, subscriber_id, kind, subject, body, received_at) "
                "values ($1, $2, $3, $4, $5, $6::text::timestamptz) "
                "on conflict (message_id) do update set arrivals = subscriber_notice.arrivals + 1 returning arrivals",
                message.id, asked.row["subscriber_id"], message.topic, subject, body, format_instant(now))
        return {"notice": message.id, "arrivals": arrivals}


def _words(topic: str, asked: Request, market: reference.Market, payload: dict) -> tuple[str, str]:
    row, policy = asked.row, asked.policy
    old = format_money(Money(row["old_price_minor"], market.currency))
    new = format_money(Money(row["new_price_minor"], market.currency))
    ends = describe_local(datetime.fromisoformat(row["window_ends_local"]), market.zone)
    if topic == REQUEST:
        if row["kind"] == "consent":
            return ("Your price: we ask for your consent",
                    f"Your subscription costs {old} a month. We ask you to accept {new}: nothing changes without your yes. "
                    f"Answer by {ends}. Without a yes: {if_no_answer(policy)} {legal_words(policy)}")
        return ("Your price is changing",
                f"Your subscription costs {old} a month. From your first charge after {ends} it costs {new}. You may leave "
                f"before then. {legal_words(policy)}")
    if payload.get("effect") == "left":
        return ("Your subscription after the price change",
                f"Your paid subscription ends on {payload.get('leaves_on')}, when the period you paid for runs out; from "
                "then you are on the free plan, with your playlists and library.")
    return ("Your new price", f"From {payload.get('new_price_from')} your subscription costs {new} a month.")


__all__ = ["Migrations", "Settled", "SubscriberInbox", "ends_on", "of_subscription", "open_requests"]
