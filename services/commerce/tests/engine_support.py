"""What the engine's tests share: a world (a database cloned from the seeded
template, the engine on top of it with a clock the test moves), calls made
as the demo's people, and the contents of the scenarios."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

import asyncpg

from commerce.engine.call import Call, FixedClock
from commerce.engine.engine import METHODS, Engine
from commerce.v1 import changes_pb2, common_pb2
from helpers import add_subscription

BY_NAME = {method.name: method for method in METHODS.values()}

# Who acts, by role: (person, role).
MARKETING = ("marketing-1", "marketing")
MARKETING_2 = ("marketing-2", "marketing")
LEAD = ("commercial-lead-1", "commercial_lead")
FINANCE = ("finance-1", "finance")
FINANCE_2 = ("finance-2", "finance")
CATALOG = ("catalog-manager-1", "catalog_manager")
ON_CALL = ("on-call-1", "on_call")
AUDITOR = ("auditor-1", "auditor")
PUBLIC = (None, None)


def request_id() -> str:
    return f"req-{uuid.uuid4().hex[:16]}"


def new_key() -> str:
    return f"key-{uuid.uuid4().hex}"


@dataclass
class World:
    name: str
    owner: asyncpg.Connection
    engine: Engine
    clock: FixedClock

    async def call(self, method: str, request, who: tuple[str | None, str | None] = MARKETING, *, key: str | None = None,
                   request_id_: str | None = None):
        spec = BY_NAME[method]
        actor, role = who
        if key is None and spec.writes:
            key = new_key()
        call = Call(request_id=request_id_ or request_id(), actor=actor, role=role, idempotency_key=key)
        return await self.engine.handle(spec.full_name, call, request)

    async def events(self, action: str | None = None) -> list[asyncpg.Record]:
        sql = "select * from audit_event" + (" where action = $1" if action else "") + " order by seq"
        return await self.owner.fetch(sql, *([action] if action else []))


def eur(amount: int) -> common_pb2.Money:
    return common_pb2.Money(amount_minor=amount, currency="EUR")


def gbp(amount: int) -> common_pb2.Money:
    return common_pb2.Money(amount_minor=amount, currency="GBP")


def apply(content, changes: dict):
    """A copy of a message with some fields replaced."""
    copy = type(content)()
    copy.CopyFrom(content)
    for field, value in changes.items():
        if isinstance(value, list):
            del getattr(copy, field)[:]
            getattr(copy, field).extend(value)
        elif hasattr(value, "CopyFrom"):
            getattr(copy, field).CopyFrom(value)
        else:
            setattr(copy, field, value)
    return copy


def student_autumn(**changes) -> changes_pb2.OfferContent:
    """§14.1: three months of Student at €2.99 for verified students in Italy who never paid."""
    content = changes_pb2.OfferContent(
        title="Student Autumn Pass", plan="student",
        audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_NEVER_PAID, needs_student_check=True),
        prices=[changes_pb2.OfferPrice(market="IT", fixed=eur(299))], months_at_offer_price=3,
        periods=[changes_pb2.OfferPeriod(market="IT", starts_local="2026-10-26T09:00", ends_local="2026-11-30T00:00")],
        non_combinability_group="student-offers",
        pages=[changes_pb2.OfferPage(market="IT", title="Student Autumn Pass", text="Three months of Student for 2,99 €.",
                                     terms="New subscribers only. One pass per verified student.", treatment="autumn")])
    return apply(content, changes)


def nordflur(**changes) -> changes_pb2.OfferContent:
    """§14.2: two months of Individual at €1.99 for Free listeners with over 3 hours of Doppelfenster."""
    content = student_autumn(
        title="Nordflur release", plan="individual",
        audience=changes_pb2.Audience(segment=changes_pb2.SEGMENT_FREE_LISTENERS,
                                      listening=changes_pb2.ListeningRule(artist_id=4, min_seconds=10_800, within_days=30)),
        prices=[changes_pb2.OfferPrice(market="DE", fixed=eur(199))], months_at_offer_price=2,
        periods=[changes_pb2.OfferPeriod(market="DE", starts_local="2026-11-06T00:00", ends_local="2026-12-06T00:00")],
        non_combinability_group="release-offers", redemption_cap=1_500,
        pages=[changes_pb2.OfferPage(market="DE", title="Nordflur is out on 6 November", text="Two months of Individual.",
                                     terms="Free listeners only.")])
    return apply(content, changes)


def family_rise(**changes) -> changes_pb2.ListPriceContent:
    """§14.3: the Family plan in Germany from €18.99 to €20.99 from 1 December 2026."""
    content = changes_pb2.ListPriceContent(title="Family price, Germany", plan="family", market="DE", amount=eur(2_099),
                                           starts_local="2026-12-01T00:00")
    return apply(content, changes)


def family_migration(**changes) -> changes_pb2.PriceMigrationContent:
    """§14.3: the Family plan in Germany from €18.99 to €20.99, for new subscribers from 1 December 2026; the existing
    ones asked for their consent from 2 November 2026, 09:00 in Berlin."""
    content = changes_pb2.PriceMigrationContent(title="Family price rise, Germany", plan="family", market="DE",
                                                amount=eur(2_099), notices_local="2026-11-02T09:00",
                                                starts_local="2026-12-01T00:00")
    return apply(content, changes)


FIELDS = {changes_pb2.OfferContent: "offer", changes_pb2.ListPriceContent: "list_price",
          changes_pb2.PriceMigrationContent: "price_migration"}


async def create(world: World, content, who=MARKETING) -> changes_pb2.Change:
    field = FIELDS[type(content)]
    response = await world.call("CreateChange", changes_pb2.CreateChangeRequest(**{field: content}), who)
    assert response.WhichOneof("outcome") == "change", response
    return response.change


async def validated(world: World, content, who=MARKETING) -> changes_pb2.Change:
    change = await create(world, content, who)
    response = await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=change.id, version=1), who)
    assert response.WhichOneof("outcome") == "change", response
    return response.change


async def submitted(world: World, content, who=MARKETING, reason: str = "We are buying students for the autumn.") -> changes_pb2.Change:
    change = await validated(world, content, who)
    response = await world.call("SubmitChange", changes_pb2.SubmitChangeRequest(
        change_id=change.id, version=change.current_version, author_reason=reason), who)
    assert response.WhichOneof("outcome") == "change", response
    return response.change


def fingerprint(change: changes_pb2.Change) -> bytes:
    return next(v.content_hash for v in change.versions if v.version == change.current_version)


async def approved(world: World, content, who=MARKETING, signer=FINANCE) -> changes_pb2.Change:
    change = await submitted(world, content, who)
    response = await world.call("ApproveChange", changes_pb2.ApproveChangeRequest(
        change_id=change.id, version=change.current_version, content_hash=fingerprint(change)), signer)
    assert response.WhichOneof("outcome") == "change", response
    return response.change


async def scheduled(world: World, content, who=MARKETING, signer=FINANCE, scheduler=None) -> changes_pb2.Change:
    change = await approved(world, content, who, signer)
    response = await world.call("ScheduleChange", changes_pb2.ScheduleChangeRequest(change_id=change.id), scheduler or who)
    assert response.WhichOneof("outcome") == "change", response
    return response.change


async def past_validation_by_hand(world, content, who=MARKETING_2) -> changes_pb2.Change:
    """A second campaign moved along by the database's owner, as a validation
    race before this check, or a hand edit, could leave one."""
    change = await create(world, content, who)
    for state in ("validated", "in_approval"):
        await world.owner.execute("update change set state = $2 where id = $1", change.id, state)
    await world.owner.execute(
        "insert into approval (change_id, version, author, content_hash, approver, role, decided_at) "
        "select change_id, version, author, content_hash, 'finance-1', 'finance', $2 from change_version where change_id = $1",
        change.id, world.clock.now())
    await world.owner.execute("update change set state = 'approved' where id = $1", change.id)
    return change


async def add_students(world: World, count: int) -> None:
    """Verified students in Italy who never paid, beyond the seeded one."""
    for n in range(count):
        subscriber = 1_000 + n
        await world.owner.execute("insert into subscriber (id, market, joined_on) values ($1, 'IT', '2026-01-10')", subscriber)
        await add_subscription(world.owner, subscriber, "IT", "free", 0, "2026-01-10", subscription=subscriber)
        await world.owner.execute("insert into student_verification (subscriber_id, verified_on, valid_until, provider) "
                                  "values ($1, '2026-09-01', '2027-09-01', 'simulated')", subscriber)
