"""The artists' economics and the simulation of a campaign, with integers
only (business book §3.5, §3.6, §5, §6.6, §7.3, §9.2).

Every formula here is the book's, under the book's names, and every
division goes through money.round_half_up. The golden cases in
tests/golden check them number by number against the book's examples.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from types import MappingProxyType

from commerce.domain.money import BASIS_POINTS, Money, apply_bp, format_money, round_half_up


@dataclass(frozen=True)
class ExchangeRate:
    """A declared reporting rate: one unit of `base` is worth per_base / scale of `quote` (§3.6)."""

    base: str
    quote: str
    per_base: int
    scale: int
    source: str

    def to_base(self, money: Money) -> Money:
        """An amount in the reporting currency, rounded half up: £9.49 is €11.33."""
        if money.currency == self.base:
            return money
        if money.currency != self.quote:
            raise ValueError(f"the declared rate converts {self.quote} to {self.base}, not {money.currency}")
        return Money(round_half_up(money.amount * self.scale, self.per_base), self.base)

    def note(self) -> str:
        whole, fraction = divmod(self.per_base, self.scale)
        digits = len(str(self.scale)) - 1
        decimal = f"{whole}.{fraction:0{digits}d}".rstrip("0").rstrip(".")
        return f"1 {self.base} = {decimal} {self.quote} ({self.source})"


# The reference rate of the book and of the generated data (§3.6).
ECB_23_OCTOBER_2026 = ExchangeRate("EUR", "GBP", 83_728, 100_000, "ECB reference rate, 23 October 2026")


@dataclass(frozen=True)
class Book:
    """The assumptions of the business book (§16), with its defaults.

    The platform is meant to let finance edit them; until a settings screen
    exists the engine is built with these values, injected, never read from
    module constants inside the rules.
    """

    pool_share_bp: int = 6_000  # §5.2, the artists' share of net revenue
    minimum: Mapping[str, int] = field(  # §5.3, per paying subscription per month
        default_factory=lambda: MappingProxyType({"EUR": 300, "GBP": 260}))
    payment_fee_bp: int = 180  # §5.6, of gross receipts
    finance_threshold: Money = Money(2_000_000, "EUR")  # §7.3, condition 3
    horizon_months: int = 12  # §6.6
    # The take-up, incremental share and retention of the book's worked
    # example (§6.7). They are illustrative, and the simulation says so.
    take_up_bp: int = 1_200
    incremental_bp: int = 6_000
    retention_bp: int = 5_500
    # The share of existing subscribers who accept a price increase, in the
    # simulation of a migration (§8.7). Illustrative, and said so (§16).
    price_increase_acceptance_bp: int = 9_000
    exchange_rate: ExchangeRate = ECB_23_OCTOBER_2026
    quote_validity_seconds: int = 30 * 60

    def horizon_for(self, months_at_offer: int) -> int:
        """§6.6: the book's horizon when the offer fits in it; an offer longer than
        that is simulated over its own months and then the book's horizon after
        them, so that the simulation always covers the whole offer."""
        if months_at_offer <= self.horizon_months:
            return self.horizon_months
        return months_at_offer + self.horizon_months

    def terms(self, currency: str, vat_bp: int) -> MarketTerms:
        if currency not in self.minimum:
            raise ValueError(f"the book sets no artists' minimum in {currency}")
        return MarketTerms(currency, vat_bp, self.minimum[currency], self.pool_share_bp, self.payment_fee_bp)


@dataclass(frozen=True)
class Breakdown:
    """Where a price goes, per subscription per month (§3.5, §5)."""

    price: int
    vat: int
    net: int
    pool: int
    top_up: int
    artists: int
    payment_costs: int
    keeps: int


@dataclass(frozen=True)
class MarketTerms:
    """What the economics of one market need: its currency, its VAT, the
    artists' minimum there, and the book's shares."""

    currency: str
    vat_bp: int
    minimum: int
    pool_share_bp: int
    payment_fee_bp: int

    def __post_init__(self) -> None:
        for name in ("vat_bp", "pool_share_bp", "payment_fee_bp"):
            if not 0 <= getattr(self, name) <= BASIS_POINTS:
                raise ValueError(f"{name} must be between 0 and {BASIS_POINTS} basis points")
        if self.minimum < 0:
            raise ValueError("the artists' minimum cannot be negative")

    def net(self, price: int) -> int:
        """§3.5: N(P) = round_half_up(P × 10000 / (10000 + v))."""
        return round_half_up(price * BASIS_POINTS, BASIS_POINTS + self.vat_bp)

    def pool(self, net: int) -> int:
        """§5.2: pool(N) = round_half_up(N × s)."""
        return apply_bp(net, self.pool_share_bp)

    def top_up(self, net: int) -> int:
        """§5.3: top_up(N) = max(0, G − pool(N))."""
        return max(0, self.minimum - self.pool(net))

    def owed(self, net: int) -> int:
        """§5.3: owed_to_artists(N) = max(pool(N), G)."""
        return max(self.pool(net), self.minimum)

    def payment_costs(self, gross: int) -> int:
        """§5.6: f × gross receipts, VAT included."""
        return apply_bp(gross, self.payment_fee_bp)

    def breakdown(self, price: int) -> Breakdown:
        net = self.net(price)
        pool, top_up, artists, fees = self.pool(net), self.top_up(net), self.owed(net), self.payment_costs(price)
        return Breakdown(price, price - net, net, pool, top_up, artists, fees, net - artists - fees)

    def floor(self) -> int:
        """§5.4: the lowest price, VAT included, whose pool covers the minimum
        without a top-up, found through the same formulas so that rounding is
        included. The pool never falls as the price rises, so a binary search
        finds it."""
        low, high = 0, 1
        while self.pool(self.net(high)) < self.minimum:
            high *= 2
        while low < high:
            middle = (low + high) // 2
            if self.pool(self.net(middle)) >= self.minimum:
                high = middle
            else:
                low = middle + 1
        return low


def recognize_monthly(net: int, months: int) -> list[int]:
    """§9.2: a prepaid pass's net amount in equal monthly parts from
    activation, the last part taking the remainder: 2458 over 3 months is
    819, 819, 820."""
    if months < 1:
        raise ValueError("a pass covers at least one month")
    part = net // months
    return [part] * (months - 1) + [net - part * (months - 1)]


@dataclass(frozen=True)
class Campaign:
    """A campaign in one market against not running it (§6.6)."""

    terms: MarketTerms
    list_price: int  # P_l
    offer_price: int  # P_o
    months_at_offer: int  # d
    horizon_months: int  # H
    eligible: int  # E
    take_up_bp: int  # u
    incremental_bp: int  # i
    retention_bp: int  # r

    def __post_init__(self) -> None:
        for name in ("take_up_bp", "incremental_bp", "retention_bp"):
            if not 0 <= getattr(self, name) <= BASIS_POINTS:
                raise ValueError(f"{name} must be between 0 and {BASIS_POINTS} basis points")
        if self.eligible < 0:
            raise ValueError("the eligible audience cannot be negative")
        if self.months_at_offer < 1:
            raise ValueError("an offer lasts at least one month")
        if self.horizon_months < self.months_at_offer:
            raise ValueError("the horizon must cover the months at the offer price")
        if self.list_price <= 0 or self.offer_price <= 0:
            raise ValueError("prices are positive")


@dataclass(frozen=True)
class Totals:
    revenue: int
    artists: int
    payment_costs: int

    @property
    def contribution(self) -> int:
        return self.revenue - self.artists - self.payment_costs


@dataclass(frozen=True)
class CampaignResult:
    takers: int  # T
    stayers: int  # R
    cannibalized: int  # C
    net_offer: int
    pool_offer: int
    top_up_offer: int
    net_list: int
    pool_list: int
    top_up_list: int
    with_offer: Totals
    without_offer: Totals
    discount_cost: int
    top_up_cost: int

    @property
    def difference(self) -> Totals:
        return Totals(self.with_offer.revenue - self.without_offer.revenue,
                      self.with_offer.artists - self.without_offer.artists,
                      self.with_offer.payment_costs - self.without_offer.payment_costs)

    @property
    def contribution(self) -> int:
        """Δ margin = Δ revenue − Δ artists − Δ fees."""
        return self.difference.contribution


def simulate(campaign: Campaign) -> CampaignResult:
    """§6.6, formula by formula."""
    c, t = campaign, campaign.terms
    takers = apply_bp(c.eligible, c.take_up_bp)
    stayers = apply_bp(takers, c.retention_bp)
    cannibalized = takers - apply_bp(takers, c.incremental_bp)
    n_offer, n_list = t.net(c.offer_price), t.net(c.list_price)
    rest = c.horizon_months - c.months_at_offer
    d, h = c.months_at_offer, c.horizon_months
    with_offer = Totals(
        revenue=takers * d * n_offer + stayers * rest * n_list,
        artists=takers * d * t.owed(n_offer) + stayers * rest * t.owed(n_list),
        payment_costs=t.payment_costs(takers * d * c.offer_price + stayers * rest * c.list_price),
    )
    without_offer = Totals(
        revenue=cannibalized * h * n_list,
        artists=cannibalized * h * t.owed(n_list),
        payment_costs=t.payment_costs(cannibalized * h * c.list_price),
    )
    return CampaignResult(
        takers=takers, stayers=stayers, cannibalized=cannibalized,
        net_offer=n_offer, pool_offer=t.pool(n_offer), top_up_offer=t.top_up(n_offer),
        net_list=n_list, pool_list=t.pool(n_list), top_up_list=t.top_up(n_list),
        with_offer=with_offer, without_offer=without_offer,
        discount_cost=cannibalized * d * (n_list - n_offer),
        top_up_cost=takers * d * t.top_up(n_offer),
    )


def break_even_retention(campaign: Campaign) -> int | None:
    """The lowest retention, in basis points, at which the contribution is not
    negative, everything else unchanged; None when no retention gets there.

    Why a binary search is exact: retention moves only the stayers R, and R
    never falls as retention rises. One more stayer adds m = (H − d) × (N(P_l) −
    owed(N(P_l))) to the margin and raises the payment costs, rounded once over
    the whole gross, by either floor(δ) or ceil(δ), where δ = f × (H − d) × P_l.
    No integer lies strictly between those two, so either m ≥ ceil(δ) and the
    contribution never falls as retention rises, or m ≤ floor(δ) and it never
    rises. In the second case it cannot go from negative to not negative, which
    the two ends below rule out; in the first, the search finds the point."""
    def contribution_at(retention_bp: int) -> int:
        return simulate(replace(campaign, retention_bp=retention_bp)).contribution

    if contribution_at(0) >= 0:
        return 0
    if contribution_at(BASIS_POINTS) < 0:
        return None
    low, high = 0, BASIS_POINTS  # contribution_at(low) < 0 <= contribution_at(high)
    while high - low > 1:
        middle = (low + high) // 2
        if contribution_at(middle) >= 0:
            high = middle
        else:
            low = middle
    return high


# §7.3: when finance must sign.
FINANCE_RULES: dict[int, str] = {
    1: "A list price is created or changed",
    2: "An offer price is below the floor of its market",
    3: "The simulated discount cost plus top-up cost over the horizon is above {threshold}",
    4: "The simulated contribution over the horizon is negative",
    5: "A price migration asks existing subscribers to accept a higher price",
}


@dataclass(frozen=True)
class FinanceCondition:
    number: int
    rule: str
    met: bool
    detail: str


def finance_rule(number: int, book: Book) -> str:
    return FINANCE_RULES[number].format(threshold=format_money(book.finance_threshold))


def finance_conditions(book: Book, *, sets_list_price: bool, below_floor: list[str],
                       discount_and_top_up: Money | None, contribution: Money | None, horizon_months: int,
                       asks_consent: bool = False, no_takers: list[str] | None = None,
                       unsimulated: list[str] | None = None) -> list[FinanceCondition]:
    """The five conditions of §7.3, each met or not, with the numbers.

    below_floor lists the offer prices under their market's floor, already in
    words ("Italy: €2.99 against a floor of €6.10"). The simulated amounts are
    in the reporting currency (§3.6), summed over the markets that could be
    simulated; None when there is nothing to simulate (a list price).

    no_takers names the markets whose simulated takers round to zero: there
    the simulation shows no effect either way, and condition 4 counts as met,
    because an effect that cannot be shown is finance's to sign (§7.3).

    unsimulated says, in words, why a campaign could not be simulated at all
    ("France: no list price in force"). A simulation that is missing never
    reads as a condition not met: conditions 3 and 4 then count as met."""
    def condition(number: int, met: bool, detail: str) -> FinanceCondition:
        return FinanceCondition(number, finance_rule(number, book), met, detail)

    threshold = book.finance_threshold
    over = f"over {horizon_months} months"
    unseen = no_takers or []
    blind = f"the campaign cannot be simulated ({'; '.join(unsimulated)}), so finance signs for it" if unsimulated else ""

    def described(parts: list[str]) -> str:
        text = "; ".join(part for part in parts if part)
        return (text[0].upper() + text[1:] + ("" if text.endswith(".") else ".")) if text else "Nothing to simulate."

    cost_detail = described([
        f"{format_money(discount_and_top_up)} {over}, against {format_money(threshold)}" if discount_and_top_up is not None else "",
        blind])
    contribution_detail = described([
        f"{format_money(contribution)} {over}" if contribution is not None else "",
        f"the simulated takers round to zero in {listing(unseen)}, so the effect cannot be shown and finance signs for it"
        if unseen else "",
        blind])
    return [
        condition(1, sets_list_price,
                  "This change sets a list price." if sets_list_price else "No list price is created or changed."),
        condition(2, bool(below_floor),
                  "; ".join(below_floor) if below_floor else "Every offer price is at or above its market's floor."),
        condition(3, (discount_and_top_up is not None and discount_and_top_up > threshold) or bool(unsimulated),
                  cost_detail),
        condition(4, (contribution is not None and (contribution.amount < 0 or bool(unseen))) or bool(unsimulated),
                  contribution_detail),
        condition(5, asks_consent,
                  "Existing subscribers are asked to accept a higher price." if asks_consent else "No price migration."),
    ]


@dataclass(frozen=True)
class SignatureNeed:
    """One signature a version needs (§7.3). A need for the commercial lead
    can always be met by finance as well: "otherwise the commercial lead or
    finance may approve"."""

    role: str
    conditions: tuple[int, ...]
    why: str

    def met_by(self, roles: set[str]) -> bool:
        return "finance" in roles if self.role == "finance" else bool(roles & {"commercial_lead", "finance"})


def listing(words: list[str]) -> str:
    """["2"] as 2, ["2", "4"] as 2 and 4, ["2", "3", "4"] as 2, 3 and 4."""
    if not words:
        return ""
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def signatures_needed(conditions: list[FinanceCondition]) -> list[SignatureNeed]:
    met = tuple(c.number for c in conditions if c.met)
    if met:
        plural = "s" if len(met) > 1 else ""
        why = f"Finance must sign: condition{plural} {listing([str(n) for n in met])} of §7.3."
        return [SignatureNeed("finance", met, why)]
    return [SignatureNeed("commercial_lead", (), "The commercial lead or finance signs: no condition of §7.3 asks for finance.")]
