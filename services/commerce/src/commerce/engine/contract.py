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
    Audience, Content, ListeningRule, ListPrice, Offer, OfferPage, OfferPeriod, OfferPrice,
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


def offer_from_proto(message: changes_pb2.OfferContent) -> Offer:
    a = message.audience
    listening = None
    if a.HasField("listening"):
        listening = ListeningRule(a.listening.artist_id, a.listening.min_seconds, a.listening.within_days)
    prices = []
    for price in message.prices:
        which = price.WhichOneof("price")
        prices.append(OfferPrice(
            price.market,
            fixed=money_from_proto(price.fixed, f"the price in {price.market}") if which == "fixed" else None,
            percent_off_bp=price.percent_off_bp if which == "percent_off_bp" else None))
    return Offer(
        title=message.title,
        plan=message.plan or None,
        audience=Audience(_enum_name(SEGMENT, "SEGMENT_", a.segment), a.current_plan or None, a.needs_student_check, listening),
        prices=tuple(prices),
        months_at_offer_price=message.months_at_offer_price,
        periods=tuple(OfferPeriod(p.market, local_from_proto(p.starts_local, f"the start in {p.market}"),
                                  local_from_proto(p.ends_local, f"the end in {p.market}")) for p in message.periods),
        group=message.non_combinability_group or None,
        redemption_cap=message.redemption_cap,
        pages=tuple(OfferPage(p.market, p.title, p.text, p.terms, p.treatment) for p in message.pages),
    )


def list_price_from_proto(message: changes_pb2.ListPriceContent) -> ListPrice:
    return ListPrice(
        title=message.title,
        plan=message.plan or None,
        market=message.market or None,
        amount=money_from_proto(message.amount, "the new price") if message.HasField("amount") else None,
        starts=local_from_proto(message.starts_local, "the start"),
    )


def content_from_request(request) -> Content:
    which = request.WhichOneof("content")
    if which == "offer":
        return offer_from_proto(request.offer)
    if which == "list_price":
        return list_price_from_proto(request.list_price)
    raise InvalidArgument("the request carries no content: an offer or a list price")


def _local_text(value: datetime | None) -> str:
    return "" if value is None else format_local(value)


def content_to_proto(content: Content) -> tuple[str, object]:
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
    prices = []
    for p in content.prices:
        if p.fixed is not None:
            prices.append(changes_pb2.OfferPrice(market=p.market, fixed=money(p.fixed)))
        else:
            prices.append(changes_pb2.OfferPrice(market=p.market, percent_off_bp=p.percent_off_bp or 0))
    return "offer", changes_pb2.OfferContent(
        title=content.title, plan=content.plan or "", audience=audience, prices=prices,
        months_at_offer_price=content.months_at_offer_price,
        periods=[changes_pb2.OfferPeriod(market=p.market, starts_local=_local_text(p.starts), ends_local=_local_text(p.ends))
                 for p in content.periods],
        non_combinability_group=content.group or "", redemption_cap=content.redemption_cap,
        pages=[changes_pb2.OfferPage(market=p.market, title=p.title, text=p.text, terms=p.terms, treatment=p.treatment)
               for p in content.pages],
    )
