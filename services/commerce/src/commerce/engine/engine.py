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
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from commerce.domain.economics import Book
from commerce.engine import contract, idempotency
from commerce.engine.audit_log import AuditLog
from commerce.engine.call import Call, Clock
from commerce.engine.catalog import Catalog
from commerce.engine.changes import Changes
from commerce.engine.database import RETRYABLE, Connection, Database, DatabaseError, DatabaseUnavailable
from commerce.engine.errors import EngineError, InvalidArgument, PermissionDenied, Refused, Unavailable
from commerce.engine.overview import Overview
from commerce.engine.publication import Publisher, activate_due, end_due
from commerce.engine.quotes import Quotes
from commerce.engine.simulation import Simulation
from commerce.v1 import audit_pb2, catalog_pb2, changes_pb2, overview_pb2, quotes_pb2, simulation_pb2

PACKAGE = "commerce.v1"


@dataclass(frozen=True)
class Method:
    service: str
    name: str
    request: type
    response: type
    public: bool  # served without a person: the site's catalog and quotes, and the list of people
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
    _m("AuditService", "ListEvents", audit_pb2),
    _m("AuditService", "VerifyChain", audit_pb2),
    _m("AuditService", "ExportHead", audit_pb2, writes=True),
    _m("OverviewService", "GetOverview", overview_pb2),
    _m("PeopleService", "ListPeople", overview_pb2, public=True),
]}

Handler = Callable[[Connection, Call, Any], Awaitable[Any]]


class Engine:
    def __init__(self, db: Database, clock: Clock, book: Book | None = None) -> None:
        self.db = db
        self.clock = clock
        self.book = book or Book()
        self.publisher = Publisher()
        self.catalog = Catalog(clock, self.book, self.publisher)
        self.changes = Changes(clock, self.book, self.publisher)
        self.quotes = Quotes(clock, self.book, self.catalog)
        self.simulation = Simulation(clock, self.book)
        self.audit = AuditLog(clock)
        self.overview = Overview(clock, self.book)
        self.handlers: dict[str, Handler] = {
            "ListMarkets": self.catalog.list_markets, "ListPlans": self.catalog.list_plans,
            "GetPriceList": self.catalog.get_price_list, "ListOffers": self.catalog.list_offers,
            "GetQuote": self.quotes.get_quote,
            "CreateChange": self.changes.create, "SaveVersion": self.changes.save_version, "GetChange": self.changes.get,
            "BatchGetChanges": self.changes.batch_get, "ListChanges": self.changes.list,
            "ValidateChange": self.changes.validate, "SubmitChange": self.changes.submit,
            "ApproveChange": self.changes.approve, "RejectChange": self.changes.reject,
            "ScheduleChange": self.changes.schedule, "CancelChange": self.changes.cancel,
            "SuspendChange": self.changes.suspend,
            "SimulateOffer": self.simulation.simulate_offer,
            "ListEvents": self.audit.list_events, "VerifyChain": self.audit.verify_chain, "ExportHead": self.audit.export_head,
            "GetOverview": self.overview.get_overview, "ListPeople": self.overview.list_people,
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
                    return response
            except DatabaseError as error:
                if error.sqlstate in RETRYABLE and attempt < attempts - 1:
                    continue
                raise
        raise AssertionError("unreachable")

    # The engine's own jobs, until stage 6 turns them into a job runner.

    async def activate_due(self):
        try:
            return await activate_due(self.db, self.clock, self.publisher)
        except DatabaseUnavailable as error:
            raise Unavailable(str(error)) from error

    async def end_due(self):
        try:
            return await end_due(self.db, self.clock, self.publisher)
        except DatabaseUnavailable as error:
            raise Unavailable(str(error)) from error


__all__ = ["METHODS", "Engine", "EngineError", "Method"]
