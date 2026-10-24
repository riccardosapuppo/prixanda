"""Who is in an audience, counted in the data (business book §6.5, §10,
§14.2): one predicate for the count and for one person, on the market's own
calendar day."""

from __future__ import annotations

from datetime import date

import pytest

from commerce.domain.offers import Audience, ListeningRule
from commerce.engine import eligibility
from helpers import add_subscription

DAY = date(2026, 10, 24)
DOPPELFENSTER = 4


async def people(world, audience: Audience, market: str, day: date = DAY) -> set[int]:
    async with world.engine.db.transaction(readonly=True) as tx:
        candidates = [r["id"] for r in await tx.fetch("select id from subscriber where market = $1", market)]
        inside = {s for s in candidates if await eligibility.includes(tx, audience, market, day, s)}
        assert await eligibility.count(tx, audience, market, day) == len(inside)
        return inside


@pytest.mark.parametrize(("audience", "market", "expected"), [
    (Audience("never_paid", None, True), "IT", {101}),
    (Audience("never_paid"), "IT", {101, 102, 105}),
    (Audience("free_listeners"), "IT", {101, 102, 104, 105}),
    (Audience("free_listeners", None, True), "IT", {101, 104}),
    (Audience("subscribers_of_plan", "individual"), "IT", {106}),
    (Audience("subscribers_of_plan", "student", True), "IT", {103}),
    (Audience("anyone"), "IT", {101, 102, 103, 104, 105, 106}),
    (Audience(None), "IT", set()),
    (Audience("free_listeners", None, False, ListeningRule(DOPPELFENSTER, 3 * 3_600, 30)), "DE", {201}),
    (Audience("free_listeners", None, False, ListeningRule(DOPPELFENSTER, 3_600, 30)), "DE", {201, 202}),
    (Audience("free_listeners", None, False, ListeningRule(DOPPELFENSTER, 3_600, 60)), "DE", {201, 202, 204}),
    (Audience("never_paid"), "FR", {401}),
])
async def test_each_audience_reaches_the_people_the_seed_put_in_it(world, audience, market, expected):
    assert await people(world, audience, market) == expected


async def test_the_listening_window_moves_with_the_day(world):
    # Four hours in the first week of October: inside the 30 days on 24 October, outside on 6 November.
    await world.owner.execute("insert into subscriber (id, market, joined_on) values (205, 'DE', '2026-01-10')")
    await add_subscription(world.owner, 205, "DE", "free", 0, "2026-01-10", subscription=205)
    for day in range(1, 9):
        await world.owner.execute("insert into listening_day (subscriber_id, artist_id, day, seconds) values (205, 4, $1, 1800)",
                                  date(2026, 10, day))
    fans = Audience("free_listeners", None, False, ListeningRule(DOPPELFENSTER, 3 * 3_600, 30))
    assert await people(world, fans, "DE", date(2026, 10, 24)) == {201, 205}
    assert await people(world, fans, "DE", date(2026, 11, 6)) == {201}


async def test_a_student_verification_counts_from_its_first_day_until_the_day_before_it_ends(world):
    # 105's verification runs 1 September 2025 to 1 September 2026; 101's starts on 1 September 2026.
    students = Audience("never_paid", None, True)
    assert await people(world, students, "IT", date(2026, 8, 31)) == {105}
    assert await people(world, students, "IT", date(2026, 9, 1)) == {101}
