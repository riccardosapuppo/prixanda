"""The simulation of a campaign in one market (business book §6.6).

It applies the book's formulas to assumptions it shows next to the results,
each with where its value comes from: the eligible audience counted in the
data, a default of the book, or a value the caller typed (with their role and
the time). It learns nothing from data and forecasts nothing beyond those
formulas. Typed values change what the simulation shows, never which
signatures a version needs: validation uses the defaults (§7.3).
"""

from __future__ import annotations

from commerce.domain import migration, policy
from commerce.domain.economics import Book, Campaign, break_even_retention, finance_conditions, simulate
from commerce.domain.localtime import describe_local, format_instant, format_local, to_instant, to_local
from commerce.domain.money import Money, format_money
from commerce.domain.offers import Offer, PriceMigration
from commerce.domain.validation import resolve_price
from commerce.engine import contract, eligibility, migrations, prepaid, records, reference
from commerce.engine.call import Call, Clock
from commerce.engine.catalog import list_price_at, list_price_replaced, market_code
from commerce.engine.changes import require_role
from commerce.engine.database import Connection
from commerce.engine.errors import InvalidArgument, NotFound, Refused
from commerce.v1 import common_pb2, simulation_pb2

# name: (lowest, highest) accepted for a typed value.
ASSUMPTIONS = {
    "eligible": (0, 100_000_000),
    "take_up": (0, 10_000),
    "incremental": (0, 10_000),
    "retention": (0, 10_000),
    "horizon_months": (1, 60),
}


class Simulation:
    def __init__(self, clock: Clock, book: Book) -> None:
        self.clock = clock
        self.book = book

    async def simulate_migration(self, tx: Connection, call: Call,
                                 request: simulation_pb2.SimulateMigrationRequest) -> simulation_pb2.SimulateMigrationResponse:
        return await simulate_migration(tx, call, request, clock=self.clock, book=self.book)

    async def simulate_offer(self, tx: Connection, call: Call,
                             request: simulation_pb2.SimulateOfferRequest) -> simulation_pb2.SimulateOfferResponse:
        require_role(call, policy.SIMULATORS, "run a simulation")
        kind = await tx.fetchval("select kind from change where id = $1", request.change_id)
        if kind is None:
            raise NotFound(f"no change #{request.change_id}")
        if kind != "offer":
            raise InvalidArgument(f"change #{request.change_id} is not an offer: SimulateOffer simulates campaigns"
                                  + ("; a price migration has SimulateMigration" if kind == "price_migration" else ""))
        version = request.version or await tx.fetchval("select current_version from change where id = $1", request.change_id)
        offer, _, _ = await records.version_content(tx, request.change_id, version)
        assert isinstance(offer, Offer)
        code = market_code(request.market)
        if offer.price_in(code) is None:
            raise InvalidArgument(f"version {version} of change #{request.change_id} is not sold in {code}")

        typed: dict[str, int] = {}
        for override in request.overrides:
            if override.name not in ASSUMPTIONS:
                raise InvalidArgument(f"{override.name!r} is not an assumption; they are {', '.join(ASSUMPTIONS)}")
            if override.name in typed:
                raise InvalidArgument(f"{override.name} is typed twice")
            low, high = ASSUMPTIONS[override.name]
            if not low <= override.value <= high:
                raise InvalidArgument(f"{override.name} is between {low} and {high}")
            typed[override.name] = override.value

        now = self.clock.now()
        ref = await reference.load(tx, now)
        market = ref.market(code)
        local_now = to_local(now, market.zone)
        period = offer.period_in(code)
        at = period.starts if period is not None and period.starts is not None and period.starts > local_now else local_now
        if offer.plan is None or offer.months_at_offer_price < 1:
            raise Refused("INVALID", "Nothing to simulate yet: the offer needs its plan and how many months it lasts.")
        list_price = await list_price_at(tx, offer.plan, market, at)
        if list_price is None:
            raise Refused("INVALID", f"No {offer.plan} price is in force in {market.name} at the offer's start.")
        offer_price = resolve_price(offer.price_in(code), list_price)
        if offer_price.amount <= 0:
            raise Refused("INVALID", f"The offer comes to {format_money(offer_price)} off {format_money(list_price)}: "
                                     "there is no price to simulate.")
        if offer_price >= list_price:
            raise Refused("INVALID", f"The offer costs {format_money(offer_price)}, not less than the list price "
                                     f"{format_money(list_price)}: there is no campaign to simulate.")
        horizon = typed.get("horizon_months", self.book.horizon_for(offer.months_at_offer_price))
        if horizon < offer.months_at_offer_price:
            raise InvalidArgument(f"the horizon must cover the {offer.months_at_offer_price} months at the offer price")

        typed_by = f"typed by {policy.ROLE_NAMES[call.role]} at {format_instant(now)}"
        counted = None
        if "eligible" not in typed:
            counted = await eligibility.count(tx, offer.audience, code, market.today(now))
        values = {
            "eligible": typed.get("eligible", counted),
            "take_up": typed.get("take_up", self.book.take_up_bp),
            "incremental": typed.get("incremental", self.book.incremental_bp),
            "retention": typed.get("retention", self.book.retention_bp),
            "horizon_months": horizon,
        }
        default = {"eligible": f"counted in the data at {format_instant(now)}",
                   "take_up": "default: business book §6.7 (illustrative)",
                   "incremental": "default: business book §6.7 (illustrative)",
                   "retention": "default: business book §6.7 (illustrative)",
                   "horizon_months": "default: business book §6.6"
                   if offer.months_at_offer_price <= self.book.horizon_months else
                   f"default for an offer longer than the book's horizon: its months, then the book's "
                   f"{self.book.horizon_months} months after them (§6.6)"}
        assumptions = [simulation_pb2.Assumption(name=name, value=values[name], source=typed_by if name in typed else default[name])
                       for name in ASSUMPTIONS]

        terms = market.terms(self.book)
        campaign = Campaign(terms, list_price.amount, offer_price.amount, offer.months_at_offer_price, horizon,
                            values["eligible"], values["take_up"], values["incremental"], values["retention"])
        result = simulate(campaign)
        break_even = break_even_retention(campaign)
        rate = self.book.exchange_rate
        floor = terms.floor()
        below = [f"{market.name}: {format_money(offer_price)} against a floor of {format_money(Money(floor, market.currency))}"
                 ] if offer_price.amount < floor else []
        conditions = finance_conditions(
            self.book, sets_list_price=False, below_floor=below,
            discount_and_top_up=rate.to_base(Money(result.discount_cost + result.top_up_cost, market.currency)),
            contribution=rate.to_base(Money(result.contribution, market.currency)), horizon_months=horizon,
            no_takers=[market.name] if result.takers == 0 else [])

        def totals(t) -> simulation_pb2.Totals:
            m = lambda amount: contract.money(Money(amount, market.currency))  # noqa: E731
            return simulation_pb2.Totals(revenue=m(t.revenue), artists=m(t.artists), payment_costs=m(t.payment_costs),
                                         contribution=m(t.contribution))

        return simulation_pb2.SimulateOfferResponse(result=simulation_pb2.SimulationResult(
            eligible=values["eligible"], takers=result.takers, stayers=result.stayers, cannibalized=result.cannibalized,
            with_offer=totals(result.with_offer), without_offer=totals(result.without_offer),
            difference=totals(result.difference),
            discount_cost=contract.money(Money(result.discount_cost, market.currency)),
            top_up_cost=contract.money(Money(result.top_up_cost, market.currency)),
            finance_conditions=[simulation_pb2.FinanceCondition(number=c.number, rule=c.rule, met=c.met, detail=c.detail)
                                for c in conditions],
            break_even_retention_bp=-1 if break_even is None else break_even,
            assumptions=assumptions, horizon_months=horizon))


# name: (lowest, highest) accepted for a typed value of a migration's simulation.
MIGRATION_ASSUMPTIONS = {"existing": (0, 100_000_000), "acceptance": (0, 10_000)}


async def simulate_migration(tx: Connection, call: Call, request: simulation_pb2.SimulateMigrationRequest, *, clock: Clock,
                             book: Book) -> simulation_pb2.SimulateMigrationResponse:
    """A price migration against not running it, per month (§8.7): its assumptions are the existing subscribers,
    counted in the data or typed, and the share that accepts, the book's illustrative default or typed."""
    require_role(call, policy.SIMULATORS, "run a simulation")
    kind = await tx.fetchval("select kind from change where id = $1", request.change_id)
    if kind is None:
        raise NotFound(f"no change #{request.change_id}")
    if kind != "price_migration":
        raise InvalidArgument(f"change #{request.change_id} is not a price migration"
                              + ("; a campaign has SimulateOffer" if kind == "offer" else ""))
    version = request.version or await tx.fetchval("select current_version from change where id = $1", request.change_id)
    change, _, _ = await records.version_content(tx, request.change_id, version)
    assert isinstance(change, PriceMigration)
    typed: dict[str, int] = {}
    for override in request.overrides:
        if override.name not in MIGRATION_ASSUMPTIONS:
            raise InvalidArgument(f"{override.name!r} is not an assumption; they are {', '.join(MIGRATION_ASSUMPTIONS)}")
        if override.name in typed:
            raise InvalidArgument(f"{override.name} is typed twice")
        low, high = MIGRATION_ASSUMPTIONS[override.name]
        if not low <= override.value <= high:
            raise InvalidArgument(f"{override.name} is between {low} and {high}")
        typed[override.name] = override.value
    if not (change.plan and change.market and change.amount and change.notices and change.starts):
        raise Refused("INVALID", "Nothing to simulate yet: the migration needs its plan, market, new price and dates.")
    now = clock.now()
    ref = await reference.load(tx, now)
    market = ref.market(change.market)
    rules = (await reference.policies(tx)).get(market.code)
    if rules is None:
        raise Refused("INVALID", f"{market.name} has no rules yet for raising an existing subscriber's price (§8).")
    old = await list_price_replaced(tx, change.plan, market, change.starts, request.change_id)
    if old is None:
        raise Refused("INVALID", f"No {change.plan} price is in force in {market.name} when the new price starts.")
    if change.amount <= old:
        raise Refused("INVALID", f"{format_money(change.amount)} is not above the price in force, {format_money(old)}: "
                                 "a price migration raises the price.")
    typed_by = f"typed by {policy.ROLE_NAMES[call.role]} at {format_instant(now)}"
    counted = f"counted in the data at {format_instant(now)}"
    existing = typed.get("existing")
    if existing is None:
        existing = await eligibility.current_subscribers(tx, market.code, change.plan, market.today(now), by_the_month=True)
        # Those waiting for an earlier migration's price are left for a later one (§8.9): this one does not reach them.
        waiting = await migrations.left_for_later(tx, change_id=request.change_id, content=change, market=market,
                                                  policy=rules, now=now)
        if waiting:
            existing -= waiting
            counted += f", leaving out {waiting} waiting for an earlier migration's price (§8.9)"
    acceptance = typed.get("acceptance", book.price_increase_acceptance_bp)
    result = migration.simulate_migration(market.terms(book), old.amount, change.amount.amount, existing, acceptance, rules)
    window_ends = rules.window_ends(change.notices)
    if rules.consent:
        existing_from = (f"from their first charge after they consent, and not before new subscribers pay it; they answer "
                         f"by {describe_local(window_ends, market.zone)}")
    else:
        existing_from = (f"from their first charge after the {rules.window_days} days of notice, ending "
                         f"{describe_local(window_ends, market.zone)}, unless they leave before it")

    def m(amount: int) -> common_pb2.Money:
        return contract.money(Money(amount, market.currency))

    def priced(step: migration.Step) -> simulation_pb2.PriceStep:
        return simulation_pb2.PriceStep(price=m(step.price), net=m(step.net), artists=m(step.artists),
                                        payment_costs=m(step.payment_costs), contribution=m(step.contribution))

    def local(moment) -> common_pb2.LocalTime:
        return common_pb2.LocalTime(market=market.code, local=format_local(moment)[:16],
                                    utc=format_instant(to_instant(moment, market.zone)))

    conditions = finance_conditions(book, sets_list_price=True, below_floor=[], discount_and_top_up=None, contribution=None,
                                    horizon_months=book.horizon_months, asks_consent=True)
    return simulation_pb2.SimulateMigrationResponse(result=simulation_pb2.MigrationSimulation(
        before=priced(result.before), after=priced(result.after), new_subscribers_from=local(change.starts),
        notices_from=local(change.notices), window_ends=local(window_ends), existing_from=existing_from,
        existing=result.existing, accepting=result.accepting, not_accepting=result.not_accepting,
        moving_to_free=result.moving_to_free, monthly_revenue_change=m(result.revenue_change),
        monthly_contribution_change=m(result.contribution_change), revenue_at_risk_monthly=m(result.revenue_at_risk),
        break_even_acceptance_revenue_bp=-1 if result.break_even_revenue_bp is None else result.break_even_revenue_bp,
        break_even_acceptance_contribution_bp=-1 if result.break_even_contribution_bp is None else result.break_even_contribution_bp,
        prepaid_passes_untouched=await prepaid.untouched(tx, market.code, change.plan, market.today(now)),
        assumptions=[
            simulation_pb2.Assumption(name="existing", value=existing,
                                      source=typed_by if "existing" in typed else counted),
            simulation_pb2.Assumption(name="acceptance", value=acceptance,
                                      source=typed_by if "acceptance" in typed else "default: business book §16 (illustrative)"),
        ],
        finance_conditions=[simulation_pb2.FinanceCondition(number=c.number, rule=c.rule, met=c.met, detail=c.detail)
                            for c in conditions]))
