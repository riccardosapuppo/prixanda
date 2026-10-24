"""The simulation of a campaign in one market (business book §6.6).

It applies the book's formulas to assumptions it shows next to the results,
each with where its value comes from: the eligible audience counted in the
data, a default of the book, or a value the caller typed (with their role and
the time). It learns nothing from data and forecasts nothing beyond those
formulas. Typed values change what the simulation shows, never which
signatures a version needs: validation uses the defaults (§7.3).
"""

from __future__ import annotations

from commerce.domain import policy
from commerce.domain.economics import Book, Campaign, break_even_retention, finance_conditions, simulate
from commerce.domain.localtime import format_instant, to_local
from commerce.domain.money import Money, format_money
from commerce.domain.offers import Offer
from commerce.domain.validation import resolve_price
from commerce.engine import contract, eligibility, records, reference
from commerce.engine.call import Call, Clock
from commerce.engine.catalog import list_price_at, market_code
from commerce.engine.changes import require_role
from commerce.engine.database import Connection
from commerce.engine.errors import InvalidArgument, NotFound, Refused
from commerce.v1 import simulation_pb2

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

    async def simulate_offer(self, tx: Connection, call: Call,
                             request: simulation_pb2.SimulateOfferRequest) -> simulation_pb2.SimulateOfferResponse:
        require_role(call, policy.SIMULATORS, "run a simulation")
        kind = await tx.fetchval("select kind from change where id = $1", request.change_id)
        if kind is None:
            raise NotFound(f"no change #{request.change_id}")
        if kind != "offer":
            raise InvalidArgument(f"change #{request.change_id} is not an offer: only campaigns are simulated")
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
