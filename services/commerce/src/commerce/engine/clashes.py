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
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from commerce.domain.offers import Content, ListPrice, Offer, from_json
from commerce.domain.validation import clashes
from commerce.engine.database import Connection

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


@dataclass(frozen=True)
class Clash:
    market: str
    other: Other


async def first_clash(tx: Connection, offer: Offer, change_id: int, states: tuple[str, ...]) -> Clash | None:
    """The first offer in one of these states that clashes with this one, market by market."""
    for other in await others(tx, "offer", states, change_id):
        assert isinstance(other.content, Offer)
        for market in offer.markets():
            if clashes(offer, other.content, market):
                return Clash(market, other)
    return None


async def pending_list_price(tx: Connection, change: ListPrice, change_id: int, states: tuple[str, ...]) -> Other | None:
    """Another change of the same plan's list price in the same market, in one of these states."""
    for other in await others(tx, "list_price", states, change_id):
        assert isinstance(other.content, ListPrice)
        if other.content.plan == change.plan and other.content.market == change.market:
            return other
    return None
