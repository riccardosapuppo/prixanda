"""The subscriber's side (business book §4.3, §4.5, §6.1, §10, §14.1, §14.5).

The gateway names the subscriber from the site's session; these calls carry
no person of the team, and in the audit log their author is the subscriber,
with the role "subscriber". Every change of state writes its event in the
same transaction, with the request id it arrived with.

ConfirmQuote decides again at the moment of confirming, under locks: the
listener first, so that two confirmations of one listener go one at a time
and the second reads what the first wrote; then the offer's change row, so
that redemptions counted against a cap cannot both take the last place, and
a suspension cannot slip in between; then the listener's current
subscription. Only then does it read the clock it decides at: a confirmation
that waited for a lock checks the quote's expiry, the offer's state and its
period at the moment it holds them all, never at the moment it arrived.

The first month is charged after the confirmation commits: the confirmation
writes the payment, pending, and an outbox message in its transaction, and
the outbox asks the payment provider afterwards (payments.py). The account
shows the payment settled, and its receipt, once the provider's events say so.

Limits, written down: a listener moves from the free plan to a paid one; a
change between paid plans, a cancellation and the monthly roll-over to the
list price after an offer's months are not modelled yet (the account works
out the price after the offer instead). A free subscription that started on
the same day cannot end that day, so a listener who left a paid plan today
subscribes again tomorrow.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime

from commerce.domain import billing
from commerce.domain.economics import Book
from commerce.domain.localtime import format_instant, to_local
from commerce.domain.money import Money
from commerce.domain.validation import on_sale, resolve_price
from commerce.engine import charging, contract, eligibility, payments, records, reference
from commerce.engine.call import Call, Clock
from commerce.engine.catalog import LIVE_OFFER, Catalog, list_price_at, live_offer
from commerce.engine.database import Connection, utc_text
from commerce.engine.errors import FailedPrecondition, InvalidArgument, NotFound, Refused
from commerce.engine.providers import PaymentProvider, StudentClaim, StudentVerifier
from commerce.engine.quotes import audience_of
from commerce.v1 import subscriptions_pb2

SUBSCRIBER_ROLE = "subscriber"
QUOTE_ID = re.compile(r"^q_[0-9a-f]{32}$")
# The advisory locks: 4600011 the audit chain (V4), 4600021 publications, 4600031 clashes, this one a listener.
LISTENER_LOCK = 4_600_041


def author(subscriber_id: int) -> str:
    return f"subscriber-{subscriber_id}"


def _date(text: str) -> date:
    return date.fromisoformat(text)


CURRENT = (
    "select id, plan_id, paid, price_minor, currency, started_on::text as started_on, billing_day, quote_id, "
    "offer_change_id, offer_months from subscription where subscriber_id = $1 and started_on <= $2::text::date "
    "and (ended_on is null or ended_on > $2::text::date)")


class Subscribers:
    def __init__(self, clock: Clock, book: Book, catalog: Catalog, payments: PaymentProvider,
                 verifier: StudentVerifier) -> None:
        self.clock = clock
        self.book = book
        self.catalog = catalog
        self.payments = payments
        self.verifier = verifier

    async def _market_of(self, tx: Connection, subscriber_id: int) -> str:
        if subscriber_id <= 0:
            raise InvalidArgument("subscriber_id names the listener of the site's session")
        market = await tx.fetchval("select market from subscriber where id = $1", subscriber_id)
        if market is None:
            raise NotFound(f"no subscriber #{subscriber_id}")
        return market.strip()

    async def _verification(self, tx: Connection, subscriber_id: int, today: date) -> subscriptions_pb2.StudentVerification | None:
        row = await tx.fetchrow(
            "select verified_on::text as verified_on, valid_until::text as valid_until, provider, reference "
            "from student_verification where subscriber_id = $1 order by verified_on desc limit 1", subscriber_id)
        if row is None:
            return None
        valid = _date(row["verified_on"]) <= today < _date(row["valid_until"])
        return subscriptions_pb2.StudentVerification(verified_on=row["verified_on"], valid_until=row["valid_until"],
                                                     provider=row["provider"], reference=row["reference"] or "", valid=valid)

    async def _subscription(self, tx: Connection, market: reference.Market, row, today: date) -> subscriptions_pb2.Subscription:
        message = subscriptions_pb2.Subscription(
            subscription_id=row["id"], plan=row["plan_id"], market=market.code, paid=row["paid"],
            price=contract.money(Money(row["price_minor"], market.currency)), started_on=row["started_on"],
            offer_id=row["offer_change_id"] or 0)
        if not row["paid"]:
            return message
        months = row["offer_months"] or 0
        now = await charging.standing(tx, market, plan_id=row["plan_id"], price_minor=row["price_minor"],
                                      started_on=_date(row["started_on"]), billing_day=row["billing_day"], offer_months=months,
                                      day=today)
        schedule = now.schedule
        message.price.CopyFrom(contract.money(now.price))  # after the offer's months, the list price of that day
        message.billing_day = row["billing_day"]
        message.next_billing_on = schedule.next_billing_on.isoformat()
        next_charge = Money(row["price_minor"], market.currency)
        if months:
            message.offer_title = await tx.fetchval("select title from change where id = $1", row["offer_change_id"])
            message.offer_months = months
            message.offer_months_left = schedule.offer_months_left
            message.full_price_from = schedule.full_price_from.isoformat()
            message.full_price.CopyFrom(contract.money(now.full_price))
            if not schedule.next_at_offer_price:
                next_charge = now.full_price
        message.next_charge.CopyFrom(contract.money(next_charge))
        return message

    async def _event(self, tx: Connection, call: Call, subscriber_id: int, action: str, subject: str, body: dict,
                     now: datetime) -> None:
        await records.record(tx, at=now, actor=author(subscriber_id), role=SUBSCRIBER_ROLE, action=action, subject=subject,
                             request_id=call.request_id, body={"subscriber": subscriber_id, **body})

    # -- calls --------------------------------------------------------------------

    async def list_demo_listeners(self, tx: Connection, call: Call,
                                  request: subscriptions_pb2.ListDemoListenersRequest) -> subscriptions_pb2.ListDemoListenersResponse:
        now = self.clock.now()
        ref = await reference.load(tx, now)
        days = {code: market.today(now).isoformat() for code, market in ref.markets.items()}
        rows = await tx.fetch(
            "select d.subscriber_id, d.title, d.label, b.market, s.plan_id, "
            "  exists (select from student_verification v where v.subscriber_id = b.id "
            "          and v.verified_on <= t.day and t.day < v.valid_until) as verified "
            "from demo_listener d join subscriber b on b.id = d.subscriber_id "
            "join (select key as market, value::date as day from jsonb_each_text($1::text::jsonb)) t on t.market = b.market "
            "left join subscription s on s.subscriber_id = b.id and s.started_on <= t.day "
            "  and (s.ended_on is null or s.ended_on > t.day) "
            "order by d.position", json.dumps(days))
        return subscriptions_pb2.ListDemoListenersResponse(listeners=[subscriptions_pb2.DemoListener(
            subscriber_id=r["subscriber_id"], market=r["market"].strip(), title=r["title"], label=r["label"],
            plan=r["plan_id"] or "", student_verified=r["verified"]) for r in rows])

    async def verify_student(self, tx: Connection, call: Call,
                             request: subscriptions_pb2.VerifyStudentRequest) -> subscriptions_pb2.VerifyStudentResponse:
        code = await self._market_of(tx, request.subscriber_id)
        now = self.clock.now()
        market = (await reference.load(tx, now)).market(code)
        today = market.today(now)
        current = await self._verification(tx, request.subscriber_id, today)
        if current is not None and current.valid:
            return subscriptions_pb2.VerifyStudentResponse(verification=current)
        demo = await tx.fetchval("select student from demo_listener where subscriber_id = $1", request.subscriber_id)
        answer = await self.verifier.verify(StudentClaim(request.subscriber_id, code, today, demo))
        if not answer.confirmed:
            raise Refused("NOT_ELIGIBLE", answer.reason, {"provider": answer.provider})
        row = await tx.fetchrow(
            "insert into student_verification (subscriber_id, verified_on, valid_until, provider, reference) "
            "values ($1, $2::text::date, ($2::text::date + interval '12 months')::date, $3, $4) "
            "returning verified_on::text as verified_on, valid_until::text as valid_until",
            request.subscriber_id, today.isoformat(), answer.provider, answer.reference)
        await self._event(tx, call, request.subscriber_id, "student.verified", f"subscriber:{request.subscriber_id}", {
            "verified_on": row["verified_on"], "valid_until": row["valid_until"], "provider": answer.provider,
            "reference": answer.reference}, now)
        return subscriptions_pb2.VerifyStudentResponse(verification=subscriptions_pb2.StudentVerification(
            verified_on=row["verified_on"], valid_until=row["valid_until"], provider=answer.provider,
            reference=answer.reference, valid=True))

    async def confirm_quote(self, tx: Connection, call: Call,
                            request: subscriptions_pb2.ConfirmQuoteRequest) -> subscriptions_pb2.ConfirmQuoteResponse:
        subscriber = request.subscriber_id
        home = await self._market_of(tx, subscriber)
        # One confirmation of this listener at a time: every read below sees what an earlier one committed.
        await tx.execute("select pg_advisory_xact_lock($1, hashtext($2))", LISTENER_LOCK, str(subscriber))
        if not QUOTE_ID.match(request.quote_id):
            raise InvalidArgument("quote_id is the identifier GetQuote returned")
        quote = await tx.fetchrow(
            f"select id, market, currency, plan_id, price_minor, list_price_minor, months_at_price, then_price_minor, "
            f"offer_change_id, offer_version, subscriber_id, {utc_text('expires_at')} as expires_at from quote where id = $1",
            request.quote_id)
        if quote is None or (quote["subscriber_id"] is not None and quote["subscriber_id"] != subscriber):
            raise NotFound(f"no quote {request.quote_id} for this listener")
        offer_id = quote["offer_change_id"]
        if offer_id is not None:
            await tx.execute("select id from change where id = $1 for update", offer_id)
        arrived = self.clock.now()  # only to find the subscription to lock: the market's day when the call arrived
        arrived_in = (await reference.load(tx, arrived)).market(quote["market"].strip())
        current = await tx.fetchrow(CURRENT + " for update", subscriber, arrived_in.today(arrived).isoformat())
        # Every lock is held: the moment this confirmation is decided at.
        now = self.clock.now()
        ref = await reference.load(tx, now)
        market = ref.market(quote["market"].strip())
        today = market.today(now)
        if now >= datetime.fromisoformat(quote["expires_at"].replace("Z", "+00:00")):
            raise Refused("QUOTE_EXPIRED", f"The quote expired at {records.iso(quote['expires_at'])}: ask for a new one.",
                          {"expired_at": records.iso(quote["expires_at"])})
        if current is None:
            raise FailedPrecondition(f"subscriber #{subscriber} is on no plan on {today.isoformat()}")
        if current["paid"]:
            raise Refused("ALREADY_SUBSCRIBED", f"A {ref.plans[current['plan_id']].name} subscription is already running "
                                                "for this listener.", {"plan": current["plan_id"]})
        offer = None
        if offer_id is not None:
            # The state of the change, read under its lock, says whether it is on sale: a suspension published with a
            # clock a little ahead of this one is not in the snapshot live at this instant, and still counts.
            state = await tx.fetchval("select state from change where id = $1", offer_id)
            snapshot = await self.catalog.publisher.live_snapshot(tx, now)
            row = None if snapshot is None or state != "active" else await tx.fetchrow(
                LIVE_OFFER + " and o.change_id = $4", snapshot, market.code, format_instant(now), offer_id)
            if row is None:
                raise Refused("QUOTE_EXPIRED", f"Offer #{offer_id} is no longer on sale in {market.name}.",
                              {"offer_id": offer_id, "state": state})
            offer = live_offer(row)
            # The list price in force at this instant of the market's day, as GetQuote and the catalog read it.
            list_price = await list_price_at(tx, offer.plan, market, to_local(now, market.zone))
            if list_price is None or not on_sale(resolve_price(offer.price_rule, list_price), list_price):
                raise Refused("QUOTE_EXPIRED", f"Offer #{offer_id} no longer costs less than the list price, or comes to "
                                               "nothing: it is not on sale.", {"offer_id": offer_id})
        if home != market.code:
            raise Refused("NOT_ELIGIBLE", f"This listener is in {ref.markets[home].name}, and the quote is for {market.name}.",
                          {"market": home})
        plan = ref.plans[quote["plan_id"]]
        if plan.needs_student_check and not await eligibility.has_valid_student_check(tx, subscriber, today):
            raise Refused("NOT_ELIGIBLE", f"{plan.name} needs a valid student verification (§10).", {"check": "student"})
        if offer is not None:
            if not await eligibility.includes(tx, audience_of(offer.audience), market.code, today, subscriber):
                raise Refused("NOT_ELIGIBLE", f"The offer is for {offer.audience_words.lower()}.",
                              {"offer_id": offer.change_id, "audience": offer.audience_words})
            group = await tx.fetchval("select group_name from catalog_offer where snapshot_id = $1 and change_id = $2 limit 1",
                                      offer.snapshot_id, offer.change_id)
            taken = await tx.fetchval(
                "select c.title from subscription s join change c on c.id = s.offer_change_id "
                "join change_version v on v.change_id = c.id and v.version = c.current_version "
                "where s.subscriber_id = $1 and v.content->>'group' = $2 order by s.started_on limit 1", subscriber, group)
            if taken is not None:
                raise Refused("NOT_COMBINABLE", f"This listener already took {taken}, of the same group {group}: offers of a "
                                                "group never stack (§10.3).", {"group": group, "taken": taken})
            cap = await tx.fetchval("select redemption_cap from catalog_offer where snapshot_id = $1 and change_id = $2 limit 1",
                                    offer.snapshot_id, offer.change_id)
            if cap:
                taken_count = await tx.fetchval("select count(*) from subscription where offer_change_id = $1", offer.change_id)
                if taken_count >= cap:
                    raise Refused("CAP_REACHED", f"Offer #{offer.change_id} has had its {cap} redemptions.",
                                  {"offer_id": offer.change_id, "cap": cap})
        if _date(current["started_on"]) >= today:
            raise FailedPrecondition("the free plan started today and cannot end today: subscribe again tomorrow")
        price = Money(quote["price_minor"], market.currency)
        await tx.execute("update subscription set ended_on = $2::text::date where id = $1", current["id"], today.isoformat())
        subscription_id = await tx.fetchval(
            "insert into subscription (id, subscriber_id, market, currency, plan_id, paid, price_minor, started_on, "
            "billing_day, quote_id, offer_change_id, offer_months) values (nextval('subscription_id_seq'), $1, $2, $3, $4, "
            "true, $5, $6::text::date, $7, $8, $9, $10) returning id",
            subscriber, market.code, market.currency, plan.id, price.amount, today.isoformat(), billing.billing_day_for(today),
            quote["id"], offer_id, quote["months_at_price"] or None)
        payment_id = payments.new_payment_id()
        await payments.request(
            tx, payment_id=payment_id, quote_id=quote["id"], subscription_id=subscription_id, subscriber_id=subscriber,
            price=price, description=f"{plan.name}, {market.name}: first month{' at the offer price' if offer else ''}",
            provider=self.payments.name, now=now, request_id=call.request_id)
        row = await tx.fetchrow(CURRENT, subscriber, today.isoformat())
        subscription = await self._subscription(tx, market, row, today)
        await self._event(tx, call, subscriber, "subscription.confirmed", f"subscription:{subscription_id}", {
            "quote": quote["id"], "offer": offer_id, "plan": plan.id, "market": market.code, "price": price.amount,
            "offer_months": quote["months_at_price"], "full_price_from": subscription.full_price_from or None,
            "from": current["plan_id"], "payment": payment_id, "payment_state": "pending", "provider": self.payments.name}, now)
        return subscriptions_pb2.ConfirmQuoteResponse(confirmation=subscriptions_pb2.Confirmation(
            subscription=subscription, payment=await payments.of_subscription(tx, subscription_id)))

    async def get_account(self, tx: Connection, call: Call,
                          request: subscriptions_pb2.GetAccountRequest) -> subscriptions_pb2.GetAccountResponse:
        code = await self._market_of(tx, request.subscriber_id)
        now = self.clock.now()
        market = (await reference.load(tx, now)).market(code)
        today = market.today(now)
        row = await tx.fetchrow(CURRENT, request.subscriber_id, today.isoformat())
        if row is None:
            raise FailedPrecondition(f"subscriber #{request.subscriber_id} is on no plan on {today.isoformat()}")
        account = subscriptions_pb2.Account(subscriber_id=request.subscriber_id, market=code,
                                            subscription=await self._subscription(tx, market, row, today))
        verification = await self._verification(tx, request.subscriber_id, today)
        if verification is not None:
            account.student_verification.CopyFrom(verification)
        payment = await payments.of_subscription(tx, row["id"])
        if payment is not None:
            account.payment.CopyFrom(payment)
        return subscriptions_pb2.GetAccountResponse(account=account)
