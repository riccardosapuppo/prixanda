"""The engine: every method of the contract, behind one entrance.

handle() checks who calls before anything else: a method that acts for a
person needs a person who exists and holds the role they claim. A method that
changes something needs an idempotency key, and runs in one transaction with
its key's claim, its audit events and its recorded outcome. Reads run in a
read-only transaction with one snapshot of the data, so a response never
mixes two moments.

A business refusal comes back inside the response; any write the refused call
had begun is rolled back to a savepoint first, while the refusal itself, and
a failed validation's report, are kept.

The engine's own jobs run outside any call, on the server's timer: the
launches (launches.py), the end of offers and passes whose periods are over,
the end of price migrations' windows (migrations.py), the expiry of prepaid
codes not used (prepaid.py), the outbox's deliveries, and the pruning of
idempotency keys. A write that
leaves work for them (a confirmed quote's charge, a launch retried) wakes the
timer, so that the work starts at once rather than at the next tick.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from commerce.domain.economics import Book
from commerce.engine import contract, idempotency, prepaid
from commerce.engine.audit_log import AuditLog
from commerce.engine.call import Call, Clock
from commerce.engine.catalog import Catalog
from commerce.engine.changes import Changes
from commerce.engine.database import RETRYABLE, Connection, Database, DatabaseError, DatabaseUnavailable
from commerce.engine.errors import EngineError, InvalidArgument, PermissionDenied, Refused, Unavailable
from commerce.engine.launches import Happened, Launches, Probe
from commerce.engine.migrations import OUTCOME, REQUEST, Migrations, Settled, SubscriberInbox
from commerce.engine.outbox import Delivery, Relay, SiteInbox
from commerce.engine.overview import Overview
from commerce.engine.payments import Charges, ProviderEvents
from commerce.engine.providers import PaymentProvider, SimulatedPayments, SimulatedStudentVerifier, StudentVerifier
from commerce.engine.publication import Outcome, Publisher, end_due
from commerce.engine.quotes import Quotes
from commerce.engine.simulation import Simulation
from commerce.engine.subscribers import Subscribers
from commerce.v1 import (
    audit_pb2, catalog_pb2, changes_pb2, launches_pb2, overview_pb2, quotes_pb2, simulation_pb2, subscriptions_pb2,
)

PACKAGE = "commerce.v1"


@dataclass(frozen=True)
class Method:
    service: str
    name: str
    request: type
    response: type
    public: bool  # served without a person: the site's catalog, quotes and subscriber calls, and the list of people
    writes: bool  # needs an idempotency key; its outcome is recorded

    @property
    def full_name(self) -> str:
        return f"{PACKAGE}.{self.service}/{self.name}"


def _m(service: str, name: str, module, *, public: bool = False, writes: bool = False) -> Method:
    return Method(service, name, getattr(module, f"{name}Request"), getattr(module, f"{name}Response"), public, writes)


METHODS: dict[str, Method] = {m.full_name: m for m in [
    _m("CatalogService", "ListMarkets", catalog_pb2, public=True),
    _m("CatalogService", "ListPlans", catalog_pb2, public=True),
    _m("CatalogService", "GetPriceList", catalog_pb2, public=True),
    _m("CatalogService", "ListOffers", catalog_pb2, public=True),
    _m("CatalogService", "ListPrepaidPasses", catalog_pb2, public=True),
    _m("CatalogService", "ListArtists", catalog_pb2),
    _m("QuoteService", "GetQuote", quotes_pb2, public=True, writes=True),
    _m("ChangeService", "CreateChange", changes_pb2, writes=True),
    _m("ChangeService", "SaveVersion", changes_pb2, writes=True),
    _m("ChangeService", "GetChange", changes_pb2),
    _m("ChangeService", "BatchGetChanges", changes_pb2),
    _m("ChangeService", "ListChanges", changes_pb2),
    _m("ChangeService", "ValidateChange", changes_pb2, writes=True),
    _m("ChangeService", "SubmitChange", changes_pb2, writes=True),
    _m("ChangeService", "ApproveChange", changes_pb2, writes=True),
    _m("ChangeService", "RejectChange", changes_pb2, writes=True),
    _m("ChangeService", "ScheduleChange", changes_pb2, writes=True),
    _m("ChangeService", "CancelChange", changes_pb2, writes=True),
    _m("ChangeService", "SuspendChange", changes_pb2, writes=True),
    _m("SimulationService", "SimulateOffer", simulation_pb2),
    _m("SimulationService", "SimulateMigration", simulation_pb2),
    _m("AuditService", "ListEvents", audit_pb2),
    _m("AuditService", "VerifyChain", audit_pb2),
    _m("AuditService", "ExportHead", audit_pb2, writes=True),
    _m("OverviewService", "GetOverview", overview_pb2),
    _m("PeopleService", "ListPeople", overview_pb2, public=True),
    _m("SubscriberService", "ListDemoListeners", subscriptions_pb2, public=True),
    _m("SubscriberService", "VerifyStudent", subscriptions_pb2, public=True, writes=True),
    _m("SubscriberService", "ConfirmQuote", subscriptions_pb2, public=True, writes=True),
    _m("SubscriberService", "GetAccount", subscriptions_pb2, public=True),
    _m("SubscriberService", "AnswerPriceChange", subscriptions_pb2, public=True, writes=True),
    _m("SubscriberService", "BuyPrepaidPass", subscriptions_pb2, public=True, writes=True),
    _m("SubscriberService", "ActivatePrepaidPass", subscriptions_pb2, public=True, writes=True),
    _m("LaunchService", "ListLaunches", launches_pb2),
    _m("LaunchService", "GetLaunch", launches_pb2),
    _m("LaunchService", "RetryLaunch", launches_pb2, writes=True),
    _m("LaunchService", "CancelLaunch", launches_pb2, writes=True),
]}

Handler = Callable[[Connection, Call, Any], Awaitable[Any]]


class Engine:
    def __init__(self, db: Database, clock: Clock, book: Book | None = None, *,
                 payments: PaymentProvider | None = None, verifier: StudentVerifier | None = None,
                 probe: Probe | None = None) -> None:
        self.db = db
        self.clock = clock
        self.book = book or Book()
        self.publisher = Publisher()
        # Simulated unless a real provider is given: no money moves, no student record is checked.
        self.payments = payments or SimulatedPayments(clock)
        self.provider_events = ProviderEvents(db, clock)
        self.relay = Relay(db, clock, [SiteInbox(db, clock), Charges(db, self.payments, self.provider_events),
                                       SubscriberInbox(db, clock, REQUEST), SubscriberInbox(db, clock, OUTCOME)])
        self.migrations = Migrations(db, clock)
        self.prepaid_catalog = prepaid.Catalog(clock)
        self.prepaid_expiry = prepaid.Expiry(db, clock)
        # The probe is the fault-injection tests' only: see launches.py.
        self.launches = Launches(db, clock, self.publisher, self.relay, probe=probe)
        self.catalog = Catalog(clock, self.book, self.publisher)
        self.changes = Changes(clock, self.book, self.publisher)
        self.quotes = Quotes(clock, self.book, self.catalog)
        self.simulation = Simulation(clock, self.book)
        self.audit = AuditLog(clock)
        self.overview = Overview(clock, self.book)
        self.subscribers = Subscribers(clock, self.book, self.catalog, self.payments, verifier or SimulatedStudentVerifier())
        # Set by a write that leaves work for the jobs; the server's timer waits on it.
        self.wake = asyncio.Event()
        self.handlers: dict[str, Handler] = {
            "ListMarkets": self.catalog.list_markets, "ListPlans": self.catalog.list_plans,
            "GetPriceList": self.catalog.get_price_list, "ListOffers": self.catalog.list_offers,
            "ListPrepaidPasses": self.prepaid_catalog.list_passes, "ListArtists": self.catalog.list_artists,
            "GetQuote": self.quotes.get_quote,
            "CreateChange": self.changes.create, "SaveVersion": self.changes.save_version, "GetChange": self.changes.get,
            "BatchGetChanges": self.changes.batch_get, "ListChanges": self.changes.list,
            "ValidateChange": self.changes.validate, "SubmitChange": self.changes.submit,
            "ApproveChange": self.changes.approve, "RejectChange": self.changes.reject,
            "ScheduleChange": self.changes.schedule, "CancelChange": self.changes.cancel,
            "SuspendChange": self.changes.suspend,
            "SimulateOffer": self.simulation.simulate_offer, "SimulateMigration": self.simulation.simulate_migration,
            "ListEvents": self.audit.list_events, "VerifyChain": self.audit.verify_chain, "ExportHead": self.audit.export_head,
            "GetOverview": self.overview.get_overview, "ListPeople": self.overview.list_people,
            "ListDemoListeners": self.subscribers.list_demo_listeners,
            "VerifyStudent": self.subscribers.verify_student, "ConfirmQuote": self.subscribers.confirm_quote,
            "GetAccount": self.subscribers.get_account, "AnswerPriceChange": self.migrations.answer,
            "BuyPrepaidPass": self.subscribers.buy_prepaid_pass, "ActivatePrepaidPass": self.subscribers.activate_prepaid_pass,
            "ListLaunches": self.launches.list_launches, "GetLaunch": self.launches.get_launch,
            "RetryLaunch": self.launches.retry_launch, "CancelLaunch": self.launches.cancel_launch,
        }

    async def handle(self, full_name: str, call: Call, request: Any) -> Any:
        method = METHODS.get(full_name)
        if method is None:
            raise InvalidArgument(f"no method {full_name}")
        if not isinstance(request, method.request):
            raise InvalidArgument(f"{method.name} takes a {method.request.__name__}")
        if call.actor is None and not method.public:
            raise PermissionDenied(f"{method.name} acts for a person: x-actor and x-actor-role are required")
        if method.writes and call.idempotency_key is None:
            raise InvalidArgument(f"{method.name} changes something: send an idempotency-key")
        handler = self.handlers[method.name]
        try:
            if method.writes:
                return await self._write(method, call, request, handler)
            async with self.db.transaction(readonly=True, isolation="repeatable_read") as tx:
                await self._identify(tx, call)
                return await self._answer(method, handler, tx, call, request)
        except DatabaseUnavailable as error:
            raise Unavailable(str(error)) from error

    @staticmethod
    async def _answer(method: Method, handler: Handler, tx: Connection, call: Call, request: Any) -> Any:
        """The handler's response, or its refusal carried in the response's outcome."""
        try:
            return await handler(tx, call, request)
        except Refused as refused:
            if "outcome" not in method.response.DESCRIPTOR.oneofs_by_name:
                raise TypeError(f"{method.name} has no outcome to carry a refusal") from refused
            return method.response(refusal=contract.refusal(refused))

    async def _identify(self, tx: Connection, call: Call) -> None:
        if call.actor is None:
            return
        holds = await tx.fetchval(
            "select exists (select from person_role where person_id = $1 and role = $2)", call.actor, call.role)
        if not holds:
            raise PermissionDenied(f"{call.actor} does not act as {call.role} on this platform")

    async def _write(self, method: Method, call: Call, request: Any, handler: Handler) -> Any:
        attempts = 3
        for attempt in range(attempts):
            try:
                async with self.db.transaction() as tx:
                    await self._identify(tx, call)
                    now = self.clock.now()
                    replay = await idempotency.claim(tx, call, method.full_name, request, now)
                    if replay is not None:
                        return method.response.FromString(replay)
                    async def in_savepoint(tx: Connection, call: Call, request: Any) -> Any:
                        async with tx.savepoint():  # a refusal rolls back what the call had begun
                            return await handler(tx, call, request)

                    response = await self._answer(method, in_savepoint, tx, call, request)
                    await idempotency.complete(tx, call, response, self.clock.now())
                self.wake.set()
                return response
            except DatabaseError as error:
                if error.sqlstate in RETRYABLE and attempt < attempts - 1:
                    continue
                raise
        raise AssertionError("unreachable")

    # -- the engine's own jobs ----------------------------------------------

    async def run_launches(self) -> list[Happened]:
        """A pass of the launches: opens those due, raises the alarm on late ones, moves the others on."""
        try:
            return await self.launches.run_pass()
        except DatabaseUnavailable as error:
            raise Unavailable(str(error)) from error

    async def activate_due(self) -> list[Outcome]:
        """A pass of the launches, told change by change: activated, refused, failed or cancelled in this pass."""
        outcomes: dict[int, Outcome] = {}
        for happened in await self.run_launches():
            change = happened.change
            if happened.event == "launch_done":
                outcomes[change] = Outcome(change, "activated", int(happened.detail["snapshot"]))
            elif happened.event == "launch_refused":
                outcomes[change] = Outcome(change, "refused", error=str(happened.detail["reason"]))
            elif happened.event == "launch_cancelled":
                outcomes[change] = Outcome(change, "cancelled", error=str(happened.detail["reason"]))
            elif happened.event == "launch_step_failed" and change not in outcomes:
                outcomes[change] = Outcome(change, "failed", error=str(happened.detail["error"]))
        return list(outcomes.values())

    async def end_due(self) -> list[Outcome]:
        try:
            return await end_due(self.db, self.clock, self.publisher)
        except DatabaseUnavailable as error:
            raise Unavailable(str(error)) from error

    async def settle_migrations(self) -> list[Settled]:
        """A pass of the price migrations: acts on every window that ended, once each."""
        try:
            return await self.migrations.settle_due()
        except DatabaseUnavailable as error:
            raise Unavailable(str(error)) from error

    async def expire_prepaid_codes(self) -> list[prepaid.Expired]:
        """A pass of the prepaid codes: those not activated by their last day expire, once each."""
        try:
            return await self.prepaid_expiry.expire_due()
        except DatabaseUnavailable as error:
            raise Unavailable(str(error)) from error

    async def deliver_outbox(self) -> list[Delivery]:
        try:
            return await self.relay.deliver_due()
        except DatabaseUnavailable as error:
            raise Unavailable(str(error)) from error

    async def prune_idempotency_keys(self) -> int:
        try:
            return await idempotency.prune(self.db, self.clock)
        except DatabaseUnavailable as error:
            raise Unavailable(str(error)) from error


__all__ = ["METHODS", "Engine", "EngineError", "Method"]
