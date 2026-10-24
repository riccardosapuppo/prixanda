"""Changes that can clash, decided one at a time (business book §4.1, §6.1,
§6.4, §10.3).

Two offers of one non-combinability group that reach the same people in the
same period must never both go live, and neither may two pending changes of
one plan's list price in one market. Validation reads the other changes and
then writes its verdict: two validations running at the same moment would
each read the other as a draft and both pass. So every call that decides on
such a clash (validation, scheduling) first takes a lock on the
neighbourhood (the group, or the plan and market), held until its
transaction ends; the second call then reads what the first decided.
Scheduling and activation check the clash again, so that a pair that got past
validation anyway (an edit by hand, a race before this lock existed) still
never goes live together.

Two campaigns for listeners of different artists clash only if someone is in
both audiences: each check counts them in the data, on the market's day, for
the markets where the clash turns on it (§6.4).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime

from commerce.domain.offers import Content, ListPrice, Offer, PriceMigration, from_json
from commerce.domain.validation import clash_words, clashes, needs_count
from commerce.engine import eligibility
from commerce.engine.database import Connection
from commerce.engine.reference import Reference

NEIGHBOURHOOD_LOCK = 4_600_031


def neighbourhood(content: Content) -> str | None:
    if isinstance(content, Offer):
        return f"offer-group:{content.group}" if content.group else None
    return f"list-price:{content.plan}:{content.market}" if content.plan and content.market else None


async def lock_neighbourhood(tx: Connection, content: Content) -> None:
    key = neighbourhood(content)
    if key is not None:
        await tx.execute("select pg_advisory_xact_lock($1, hashtext($2))", NEIGHBOURHOOD_LOCK, key)


@dataclass(frozen=True)
class Other:
    change_id: int
    title: str
    state: str
    content: Content


async def others(tx: Connection, kind: str, states: tuple[str, ...], excluding: int) -> list[Other]:
    rows = await tx.fetch(
        "select c.id, c.title, c.state, v.content::text as content from change c "
        "join change_version v on v.change_id = c.id and v.version = c.current_version "
        "where c.kind = $1 and c.id <> $2 and c.state in (select jsonb_array_elements_text($3::text::jsonb)) order by c.id",
        kind, excluding, json.dumps(list(states)))
    return [Other(r["id"], r["title"], r["state"], from_json(json.loads(r["content"]))) for r in rows]


def market_days(ref: Reference, offer: Offer, now: datetime) -> dict[str, date]:
    return {code: ref.market(code).today(now) for code in offer.markets()}


async def shared_people(tx: Connection, offer: Offer, other: Offer, days: Mapping[str, date]) -> dict[str, int]:
    """People in both audiences, counted on each market's day, in the markets where the clash turns on it."""
    return {market: await eligibility.count_both(tx, offer.audience, other.audience, market, days[market])
            for market in offer.markets() if needs_count(offer, other, market)}


@dataclass(frozen=True)
class Clash:
    market: str
    other: Other
    shared: int | None = None  # people counted in both audiences, when the clash turned on them

    def words(self, market_name: str, group: str | None) -> str:
        other = self.other
        return clash_words(market_name, other.title, other.change_id, other.state, group,
                           counted=self.shared is not None, shared=self.shared)

    def facts(self) -> dict[str, object]:
        return {"check": "conflict", "market": self.market, "change": self.other.change_id,
                **({} if self.shared is None else {"shared": self.shared})}


async def first_clash(tx: Connection, offer: Offer, change_id: int, states: tuple[str, ...],
                      ref: Reference, now: datetime) -> Clash | None:
    """The first offer in one of these states that clashes with this one, market by market."""
    days = market_days(ref, offer, now)
    for other in await others(tx, "offer", states, change_id):
        assert isinstance(other.content, Offer)
        shared = await shared_people(tx, offer, other.content, days)
        for market in offer.markets():
            if clashes(offer, other.content, market, shared.get(market)):
                return Clash(market, other, shared.get(market))
    return None


async def pending_list_price(tx: Connection, change: ListPrice | PriceMigration, change_id: int,
                             states: tuple[str, ...]) -> Other | None:
    """Another change of the same plan's list price in the same market, in one of these states: a list price
    or a price migration, which sets the list price too."""
    for kind in ("list_price", "price_migration"):
        for other in await others(tx, kind, states, change_id):
            assert isinstance(other.content, (ListPrice, PriceMigration))
            if other.content.plan == change.plan and other.content.market == change.market:
                return other
    return None
