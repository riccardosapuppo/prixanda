"""SimulateOffer (business book §6.6, §6.7, §7.3): the book's formulas on
assumptions shown with their source, the worked example reproduced through
the contract, and its refusals and errors."""

from __future__ import annotations

import pytest

from commerce.engine.errors import InvalidArgument, NotFound
from commerce.v1 import changes_pb2, common_pb2, simulation_pb2
from engine_support import AUDITOR, FINANCE, LEAD, MARKETING, ON_CALL, add_students, create, family_rise, student_autumn

REFUSAL = common_pb2.RefusalCode
WORKED_EXAMPLE = [("eligible", 10_000), ("take_up", 1_200), ("incremental", 6_000), ("retention", 5_500)]


async def simulate(world, change_id: int, market: str = "IT", overrides=(), who=MARKETING, version: int = 0):
    return await world.call("SimulateOffer", simulation_pb2.SimulateOfferRequest(
        change_id=change_id, version=version, market=market,
        overrides=[simulation_pb2.AssumptionOverride(name=n, value=v) for n, v in overrides]), who)


async def test_the_worked_example_of_the_book_comes_back_through_the_contract(world):
    change = await create(world, student_autumn())
    result = (await simulate(world, change.id, overrides=WORKED_EXAMPLE, who=FINANCE)).result
    assert (result.eligible, result.takers, result.stayers, result.cannibalized) == (10_000, 1_200, 660, 480)
    assert (result.with_offer.revenue.amount_minor, result.without_offer.revenue.amount_minor) == (3_703_500, 2_736_000)
    assert (result.difference.artists.amount_minor, result.difference.payment_costs.amount_minor) == (1_134_000, 21_251)
    assert result.difference.contribution.amount_minor == -187_751
    assert (result.discount_cost.amount_minor, result.top_up_cost.amount_minor) == (331_200, 550_800)
    assert result.break_even_retention_bp == 6_555 and result.horizon_months == 12
    met = [c.number for c in result.finance_conditions if c.met]
    assert met == [2, 4]


async def test_every_assumption_says_where_it_comes_from(world):
    change = await create(world, student_autumn())
    result = (await simulate(world, change.id, overrides=[("retention", 7_000)])).result
    sources = {a.name: (a.value, a.source) for a in result.assumptions}
    assert sources["eligible"] == (1, "counted in the data at 2026-10-24T08:42:00Z")
    assert sources["take_up"] == (1_200, "default: business book §6.7 (illustrative)")
    assert sources["retention"] == (7_000, "typed by marketing at 2026-10-24T08:42:00Z")
    assert sources["horizon_months"] == (12, "default: business book §6.6")


async def test_a_campaign_that_never_pays_back_has_no_break_even(world):
    change = await create(world, student_autumn(prices=[changes_pb2.OfferPrice(
        market="IT", fixed=common_pb2.Money(amount_minor=99, currency="EUR"))]))
    result = (await simulate(world, change.id, overrides=[*WORKED_EXAMPLE[:3], ("horizon_months", 3)])).result
    assert result.difference.contribution.amount_minor < 0 and result.break_even_retention_bp == -1


async def test_typed_assumptions_do_not_change_who_must_sign(world):
    await add_students(world, 100)  # 101 eligible: at the book's defaults the campaign loses money
    change = await create(world, student_autumn())
    optimistic = (await simulate(world, change.id, overrides=[("retention", 10_000), ("incremental", 10_000)])).result
    assert optimistic.difference.contribution.amount_minor > 0
    validated = (await world.call("ValidateChange", changes_pb2.ValidateChangeRequest(change_id=change.id, version=1))).change
    assert [list(s.conditions) for s in validated.required_signatures] == [[2, 4]]


async def test_takers_rounded_to_zero_leave_the_effect_unseen_and_finance_signs(world):
    change = await create(world, student_autumn())
    result = (await simulate(world, change.id, who=FINANCE)).result
    assert (result.eligible, result.takers, result.difference.contribution.amount_minor) == (1, 0, 0)
    condition = next(c for c in result.finance_conditions if c.number == 4)
    assert condition.met and "round to zero in Italy" in condition.detail


@pytest.mark.parametrize("overrides", [
    [("conversion", 100)], [("retention", 10_001)], [("eligible", -1)], [("horizon_months", 0)],
    [("take_up", 100), ("take_up", 200)], [("horizon_months", 2)],
])
async def test_assumptions_that_mean_nothing_are_malformed(world, overrides):
    change = await create(world, student_autumn())
    with pytest.raises(InvalidArgument):
        await simulate(world, change.id, overrides=overrides)


async def test_simulation_errors_and_refusals(world):
    offer = await create(world, student_autumn())
    price = await create(world, family_rise(), LEAD)
    with pytest.raises(NotFound):
        await simulate(world, 999)
    with pytest.raises(NotFound):
        await simulate(world, offer.id, version=5)
    with pytest.raises(InvalidArgument):
        await simulate(world, price.id, market="DE")
    with pytest.raises(InvalidArgument):
        await simulate(world, offer.id, market="FR")
    for who in (ON_CALL, AUDITOR):
        assert (await simulate(world, offer.id, who=who)).refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    empty = await create(world, changes_pb2.OfferContent(title="An idea", prices=[changes_pb2.OfferPrice(
        market="IT", fixed=common_pb2.Money(amount_minor=299, currency="EUR"))]))
    assert (await simulate(world, empty.id)).refusal.code == REFUSAL.REFUSAL_CODE_INVALID
    dear = await create(world, student_autumn(prices=[changes_pb2.OfferPrice(
        market="IT", fixed=common_pb2.Money(amount_minor=600, currency="EUR"))]))
    assert (await simulate(world, dear.id)).refusal.code == REFUSAL.REFUSAL_CODE_INVALID


async def test_an_offer_longer_than_the_book_s_horizon_is_simulated_over_all_its_months(world):
    # 24 months at the offer price: the default horizon covers them and the book's 12 months after.
    change = await create(world, student_autumn(months_at_offer_price=24))
    result = (await simulate(world, change.id, overrides=WORKED_EXAMPLE, who=FINANCE)).result
    assert result.horizon_months == 36
    horizon = next(a for a in result.assumptions if a.name == "horizon_months")
    assert (horizon.value, horizon.source) == (36, "default for an offer longer than the book's horizon: its months, "
                                                   "then the book's 12 months after them (§6.6)")
