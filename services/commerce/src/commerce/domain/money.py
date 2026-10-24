"""Money: integers in the currency's minor unit (business book §3.4).

The one rounding rule of the engine lives here. Every division of money
rounds half up to the minor unit, ties away from zero, so that a loss
converts to the same magnitude as a gain. Amounts carry their currency, and
adding two currencies is an error, never a silent conversion.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# ISO 4217 minor units of the currencies the engine can write. Encore sells
# in euros and pounds; the yen is here because the engine is also tested on
# a currency without decimals, so that nothing assumes two (§3.4).
MINOR_UNITS: dict[str, int] = {"EUR": 2, "GBP": 2, "JPY": 0}
SYMBOLS: dict[str, str] = {"EUR": "€", "GBP": "£", "JPY": "¥"}

# Shares and rates are integers in basis points: 2200 is 22%.
BASIS_POINTS = 10_000

# Box Office writes a negative amount with a real minus sign.
MINUS = "−"

_CURRENCY = re.compile(r"^[A-Z]{3}$")


def _integer(value: object, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{what} must be an integer, not {type(value).__name__}")
    return value


def round_half_up(numerator: int, denominator: int) -> int:
    """numerator / denominator, rounded to an integer with ties away from zero."""
    _integer(numerator, "the numerator")
    _integer(denominator, "the denominator")
    if denominator <= 0:
        raise ValueError("the denominator must be positive")
    quotient, remainder = divmod(abs(numerator), denominator)
    if 2 * remainder >= denominator:
        quotient += 1
    return quotient if numerator >= 0 else -quotient


def apply_bp(amount: int, basis_points: int) -> int:
    """A share of an amount, amount × bp / 10,000, rounded half up."""
    return round_half_up(_integer(amount, "the amount") * _integer(basis_points, "the share"), BASIS_POINTS)


class CurrencyMismatch(ValueError):
    """Two amounts in different currencies met where one currency was meant."""


@dataclass(frozen=True, slots=True)
class Money:
    amount: int
    currency: str

    def __post_init__(self) -> None:
        _integer(self.amount, "an amount of money")
        if not isinstance(self.currency, str) or not _CURRENCY.match(self.currency):
            raise ValueError(f"not an ISO 4217 currency code: {self.currency!r}")

    def _other(self, other: object) -> Money:
        if not isinstance(other, Money):
            raise TypeError("money combines only with money")
        if other.currency != self.currency:
            raise CurrencyMismatch(f"{self.currency} and {other.currency} do not add up: convert first")
        return other

    def __add__(self, other: object) -> Money:
        return Money(self.amount + self._other(other).amount, self.currency)

    def __sub__(self, other: object) -> Money:
        return Money(self.amount - self._other(other).amount, self.currency)

    def __neg__(self) -> Money:
        return Money(-self.amount, self.currency)

    def times(self, factor: int) -> Money:
        return Money(self.amount * _integer(factor, "a factor"), self.currency)

    def __lt__(self, other: object) -> bool:
        return self.amount < self._other(other).amount

    def __le__(self, other: object) -> bool:
        return self.amount <= self._other(other).amount

    def __gt__(self, other: object) -> bool:
        return self.amount > self._other(other).amount

    def __ge__(self, other: object) -> bool:
        return self.amount >= self._other(other).amount

    @staticmethod
    def zero(currency: str) -> Money:
        return Money(0, currency)


def format_money(money: Money) -> str:
    """The way Box Office writes every amount (en-GB): €5.79, £9.49, −€1,877.51, ¥1,000."""
    if money.currency not in MINOR_UNITS:
        raise ValueError(f"the engine does not know how many minor units {money.currency} has")
    digits = MINOR_UNITS[money.currency]
    units, minor = divmod(abs(money.amount), 10**digits)
    body = f"{units:,}" + (f".{minor:0{digits}d}" if digits else "")
    sign = MINUS if money.amount < 0 else ""
    symbol = SYMBOLS.get(money.currency)
    return f"{sign}{symbol}{body}" if symbol else f"{sign}{body} {money.currency}"


def format_count(count: int) -> str:
    """10000 as 10,000."""
    return f"{_integer(count, 'a count'):,}"


def format_percent(basis_points: int) -> str:
    """2000 as 20%, 1250 as 12.5%, 25 as 0.25%."""
    whole, rest = divmod(abs(_integer(basis_points, "a share")), 100)
    sign = MINUS if basis_points < 0 else ""
    return f"{sign}{whole}%" if rest == 0 else f"{sign}{whole}.{rest:02d}".rstrip("0") + "%"
