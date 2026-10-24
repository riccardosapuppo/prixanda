"""Between the contract's messages and the domain's values.

A request field that cannot mean anything (a local time that is not a time,
an amount without a currency, an enum value the contract does not know)
becomes InvalidArgument here, before any rule looks at it.
"""

from __future__ import annotations

from datetime import datetime

from commerce.domain.localtime import MalformedTime, format_local, parse_instant, parse_local
from commerce.domain.money import Money
from commerce.domain.offers import (
    Audience, Content, ListeningRule, ListPrice, Offer, OfferPage, OfferPeriod, OfferPrice, PrepaidPass, PriceMigration,
)
from commerce.engine.errors import InvalidArgument, Refused
from commerce.v1 import changes_pb2, common_pb2

ROLE = common_pb2.Role
KIND = changes_pb2.ChangeKind
STATE = changes_pb2.ChangeState
SEGMENT = changes_pb2.Segment
SEVERITY = changes_pb2.Severity
REFUSAL = common_pb2.RefusalCode


def _enum_name(enum, prefix: str, value: int) -> str | None:
    if value == 0:
        return None
    try:
        return enum.Name(value)[len(prefix):].lower()
    except ValueError as error:
        raise InvalidArgument(f"{value} is not a value of {prefix.rstrip('_').lower()}") from error


def enum_name(enum, prefix: str, value: int) -> str | None:
    """The lower-case name of a contract enum's value without its prefix; None when unspecified."""
    return _enum_name(enum, prefix, value)


def role_to_proto(role: str) -> int:
    return ROLE.Value(f"ROLE_{role.upper()}")


def role_from_proto(value: int) -> str | None:
    return _enum_name(ROLE, "ROLE_", value)


def kind_to_proto(kind: str) -> int:
    return KIND.Value(f"CHANGE_KIND_{kind.upper()}")


def kind_from_proto(value: int) -> str | None:
    return _enum_name(KIND, "CHANGE_KIND_", value)


def state_to_proto(state: str) -> int:
    return STATE.Value(f"CHANGE_STATE_{state.upper()}")


def state_from_proto(value: int) -> str | None:
    return _enum_name(STATE, "CHANGE_STATE_", value)


def severity_to_proto(severity: str) -> int:
    return SEVERITY.Value(f"SEVERITY_{severity.upper()}")


def refusal(refused: Refused) -> common_pb2.Refusal:
    return common_pb2.Refusal(code=REFUSAL.Value(f"REFUSAL_CODE_{refused.code}"), reason=refused.reason, facts=refused.facts)


def money(value: Money) -> common_pb2.Money:
    return common_pb2.Money(amount_minor=value.amount, currency=value.currency)


def money_from_proto(message: common_pb2.Money, where: str) -> Money:
    try:
        return Money(message.amount_minor, message.currency)
    except (TypeError, ValueError) as error:
        raise InvalidArgument(f"{where}: {error}") from error


def local_from_proto(text: str, where: str) -> datetime | None:
    if not text:
        return None
    try:
        return parse_local(text)
    except MalformedTime as error:
        raise InvalidArgument(f"{where}: {error}") from error


def instant_from_proto(text: str, where: str) -> datetime | None:
    if not text:
        return None
    try:
        return parse_instant(text)
    except MalformedTime as error:
        raise InvalidArgument(f"{where}: {error}") from error


def _prices_from_proto(messages) -> tuple[OfferPrice, ...]:
    prices = []
    for price in messages:
        which = price.WhichOneof("price")
        prices.append(OfferPrice(
            price.market,
            fixed=money_from_proto(price.fixed, f"the price in {price.market}") if which == "fixed" else None,
            percent_off_bp=price.percent_off_bp if which == "percent_off_bp" else None))
    return tuple(prices)


def _periods_from_proto(messages) -> tuple[OfferPeriod, ...]:
    return tuple(OfferPeriod(p.market, local_from_proto(p.starts_local, f"the start in {p.market}"),
                             local_from_proto(p.ends_local, f"the end in {p.market}")) for p in messages)


def _pages_from_proto(messages) -> tuple[OfferPage, ...]:
    return tuple(OfferPage(p.market, p.title, p.text, p.terms, p.treatment) for p in messages)


def offer_from_proto(message: changes_pb2.OfferContent) -> Offer:
    a = message.audience
    listening = None
    if a.HasField("listening"):
        listening = ListeningRule(a.listening.artist_id, a.listening.min_seconds, a.listening.within_days)
    prices = _prices_from_proto(message.prices)
    return Offer(
        title=message.title,
        plan=message.plan or None,
        audience=Audience(_enum_name(SEGMENT, "SEGMENT_", a.segment), a.current_plan or None, a.needs_student_check, listening),
        prices=prices,
        months_at_offer_price=message.months_at_offer_price,
        periods=_periods_from_proto(message.periods),
        group=message.non_combinability_group or None,
        redemption_cap=message.redemption_cap,
        pages=_pages_from_proto(message.pages),
    )


def prepaid_from_proto(message: changes_pb2.PrepaidPassContent) -> PrepaidPass:
    return PrepaidPass(
        title=message.title, plan=message.plan or None, months=message.months, prices=_prices_from_proto(message.prices),
        periods=_periods_from_proto(message.periods), code_valid_months=message.code_valid_months,
        pages=_pages_from_proto(message.pages))


def list_price_from_proto(message: changes_pb2.ListPriceContent) -> ListPrice:
    return ListPrice(
        title=message.title,
        plan=message.plan or None,
        market=message.market or None,
        amount=money_from_proto(message.amount, "the new price") if message.HasField("amount") else None,
        starts=local_from_proto(message.starts_local, "the start"),
    )


def price_migration_from_proto(message: changes_pb2.PriceMigrationContent) -> PriceMigration:
    return PriceMigration(
        title=message.title,
        plan=message.plan or None,
        market=message.market or None,
        amount=money_from_proto(message.amount, "the new price") if message.HasField("amount") else None,
        notices=local_from_proto(message.notices_local, "the notices"),
        starts=local_from_proto(message.starts_local, "the start"),
    )


def content_from_message(holder) -> Content:
    """The content a request or a stored version carries, by the field its oneof set."""
    which = holder.WhichOneof("content")
    if which == "offer":
        return offer_from_proto(holder.offer)
    if which == "list_price":
        return list_price_from_proto(holder.list_price)
    if which == "price_migration":
        return price_migration_from_proto(holder.price_migration)
    if which == "prepaid":
        return prepaid_from_proto(holder.prepaid)
    raise InvalidArgument("the request carries no content: an offer, a list price, a price migration or a prepaid pass")


def content_from_request(request) -> Content:
    return content_from_message(request)


def _local_text(value: datetime | None) -> str:
    return "" if value is None else format_local(value)


def _prices_to_proto(prices: tuple[OfferPrice, ...]) -> list[changes_pb2.OfferPrice]:
    out = []
    for p in prices:
        if p.fixed is not None:
            out.append(changes_pb2.OfferPrice(market=p.market, fixed=money(p.fixed)))
        else:
            out.append(changes_pb2.OfferPrice(market=p.market, percent_off_bp=p.percent_off_bp or 0))
    return out


def _periods_to_proto(periods: tuple[OfferPeriod, ...]) -> list[changes_pb2.OfferPeriod]:
    return [changes_pb2.OfferPeriod(market=p.market, starts_local=_local_text(p.starts), ends_local=_local_text(p.ends))
            for p in periods]


def _pages_to_proto(pages: tuple[OfferPage, ...]) -> list[changes_pb2.OfferPage]:
    return [changes_pb2.OfferPage(market=p.market, title=p.title, text=p.text, terms=p.terms, treatment=p.treatment)
            for p in pages]


def content_to_proto(content: Content) -> tuple[str, object]:
    if isinstance(content, PrepaidPass):
        return "prepaid", changes_pb2.PrepaidPassContent(
            title=content.title, plan=content.plan or "", months=content.months, prices=_prices_to_proto(content.prices),
            periods=_periods_to_proto(content.periods), code_valid_months=content.code_valid_months,
            pages=_pages_to_proto(content.pages))
    if isinstance(content, PriceMigration):
        message = changes_pb2.PriceMigrationContent(
            title=content.title, plan=content.plan or "", market=content.market or "",
            notices_local=_local_text(content.notices), starts_local=_local_text(content.starts))
        if content.amount is not None:
            message.amount.CopyFrom(money(content.amount))
        return "price_migration", message
    if isinstance(content, ListPrice):
        message = changes_pb2.ListPriceContent(title=content.title, plan=content.plan or "", market=content.market or "",
                                               starts_local=_local_text(content.starts))
        if content.amount is not None:
            message.amount.CopyFrom(money(content.amount))
        return "list_price", message
    a = content.audience
    audience = changes_pb2.Audience(
        segment=SEGMENT.Value(f"SEGMENT_{a.segment.upper()}") if a.segment else 0,
        current_plan=a.current_plan or "", needs_student_check=a.needs_student_check)
    if a.listening is not None:
        audience.listening.CopyFrom(changes_pb2.ListeningRule(
            artist_id=a.listening.artist_id, min_seconds=a.listening.min_seconds, within_days=a.listening.within_days))
    return "offer", changes_pb2.OfferContent(
        title=content.title, plan=content.plan or "", audience=audience, prices=_prices_to_proto(content.prices),
        months_at_offer_price=content.months_at_offer_price, periods=_periods_to_proto(content.periods),
        non_combinability_group=content.group or "", redemption_cap=content.redemption_cap,
        pages=_pages_to_proto(content.pages),
    )
