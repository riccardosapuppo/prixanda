from commerce.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Market(_message.Message):
    __slots__ = ("code", "name", "currency", "minor_units", "time_zone", "vat_bp", "artists_minimum", "floor")
    CODE_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    MINOR_UNITS_FIELD_NUMBER: _ClassVar[int]
    TIME_ZONE_FIELD_NUMBER: _ClassVar[int]
    VAT_BP_FIELD_NUMBER: _ClassVar[int]
    ARTISTS_MINIMUM_FIELD_NUMBER: _ClassVar[int]
    FLOOR_FIELD_NUMBER: _ClassVar[int]
    code: str
    name: str
    currency: str
    minor_units: int
    time_zone: str
    vat_bp: int
    artists_minimum: _common_pb2.Money
    floor: _common_pb2.Money
    def __init__(self, code: _Optional[str] = ..., name: _Optional[str] = ..., currency: _Optional[str] = ..., minor_units: _Optional[int] = ..., time_zone: _Optional[str] = ..., vat_bp: _Optional[int] = ..., artists_minimum: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., floor: _Optional[_Union[_common_pb2.Money, _Mapping]] = ...) -> None: ...

class ListMarketsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListMarketsResponse(_message.Message):
    __slots__ = ("markets",)
    MARKETS_FIELD_NUMBER: _ClassVar[int]
    markets: _containers.RepeatedCompositeFieldContainer[Market]
    def __init__(self, markets: _Optional[_Iterable[_Union[Market, _Mapping]]] = ...) -> None: ...

class Entitlements(_message.Message):
    __slots__ = ("skips_per_hour", "audio", "offline", "seats", "needs_student_check")
    SKIPS_PER_HOUR_FIELD_NUMBER: _ClassVar[int]
    AUDIO_FIELD_NUMBER: _ClassVar[int]
    OFFLINE_FIELD_NUMBER: _ClassVar[int]
    SEATS_FIELD_NUMBER: _ClassVar[int]
    NEEDS_STUDENT_CHECK_FIELD_NUMBER: _ClassVar[int]
    skips_per_hour: int
    audio: str
    offline: bool
    seats: int
    needs_student_check: bool
    def __init__(self, skips_per_hour: _Optional[int] = ..., audio: _Optional[str] = ..., offline: bool = ..., seats: _Optional[int] = ..., needs_student_check: bool = ...) -> None: ...

class PriceBreakdown(_message.Message):
    __slots__ = ("price", "vat", "net", "artists", "top_up", "payment_costs", "encore_keeps")
    PRICE_FIELD_NUMBER: _ClassVar[int]
    VAT_FIELD_NUMBER: _ClassVar[int]
    NET_FIELD_NUMBER: _ClassVar[int]
    ARTISTS_FIELD_NUMBER: _ClassVar[int]
    TOP_UP_FIELD_NUMBER: _ClassVar[int]
    PAYMENT_COSTS_FIELD_NUMBER: _ClassVar[int]
    ENCORE_KEEPS_FIELD_NUMBER: _ClassVar[int]
    price: _common_pb2.Money
    vat: _common_pb2.Money
    net: _common_pb2.Money
    artists: _common_pb2.Money
    top_up: _common_pb2.Money
    payment_costs: _common_pb2.Money
    encore_keeps: _common_pb2.Money
    def __init__(self, price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., vat: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., net: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., artists: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., top_up: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., payment_costs: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., encore_keeps: _Optional[_Union[_common_pb2.Money, _Mapping]] = ...) -> None: ...

class Plan(_message.Message):
    __slots__ = ("id", "name", "paid", "entitlements", "list_price", "breakdown")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    PAID_FIELD_NUMBER: _ClassVar[int]
    ENTITLEMENTS_FIELD_NUMBER: _ClassVar[int]
    LIST_PRICE_FIELD_NUMBER: _ClassVar[int]
    BREAKDOWN_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    paid: bool
    entitlements: Entitlements
    list_price: _common_pb2.Money
    breakdown: PriceBreakdown
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., paid: bool = ..., entitlements: _Optional[_Union[Entitlements, _Mapping]] = ..., list_price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., breakdown: _Optional[_Union[PriceBreakdown, _Mapping]] = ...) -> None: ...

class ListPlansRequest(_message.Message):
    __slots__ = ("market", "at")
    MARKET_FIELD_NUMBER: _ClassVar[int]
    AT_FIELD_NUMBER: _ClassVar[int]
    market: str
    at: str
    def __init__(self, market: _Optional[str] = ..., at: _Optional[str] = ...) -> None: ...

class ListPlansResponse(_message.Message):
    __slots__ = ("plans",)
    PLANS_FIELD_NUMBER: _ClassVar[int]
    plans: _containers.RepeatedCompositeFieldContainer[Plan]
    def __init__(self, plans: _Optional[_Iterable[_Union[Plan, _Mapping]]] = ...) -> None: ...

class PriceListEntry(_message.Message):
    __slots__ = ("id", "plan", "market", "amount", "valid_from_local", "valid_until_local", "change_id", "below_floor", "top_up")
    ID_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_FIELD_NUMBER: _ClassVar[int]
    VALID_FROM_LOCAL_FIELD_NUMBER: _ClassVar[int]
    VALID_UNTIL_LOCAL_FIELD_NUMBER: _ClassVar[int]
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    BELOW_FLOOR_FIELD_NUMBER: _ClassVar[int]
    TOP_UP_FIELD_NUMBER: _ClassVar[int]
    id: int
    plan: str
    market: str
    amount: _common_pb2.Money
    valid_from_local: str
    valid_until_local: str
    change_id: int
    below_floor: bool
    top_up: _common_pb2.Money
    def __init__(self, id: _Optional[int] = ..., plan: _Optional[str] = ..., market: _Optional[str] = ..., amount: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., valid_from_local: _Optional[str] = ..., valid_until_local: _Optional[str] = ..., change_id: _Optional[int] = ..., below_floor: bool = ..., top_up: _Optional[_Union[_common_pb2.Money, _Mapping]] = ...) -> None: ...

class GetPriceListRequest(_message.Message):
    __slots__ = ("market", "plan")
    MARKET_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    market: str
    plan: str
    def __init__(self, market: _Optional[str] = ..., plan: _Optional[str] = ...) -> None: ...

class GetPriceListResponse(_message.Message):
    __slots__ = ("entries",)
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    entries: _containers.RepeatedCompositeFieldContainer[PriceListEntry]
    def __init__(self, entries: _Optional[_Iterable[_Union[PriceListEntry, _Mapping]]] = ...) -> None: ...

class PublishedOffer(_message.Message):
    __slots__ = ("offer_id", "version", "market", "plan", "title", "text", "terms", "price", "list_price", "months_at_offer_price", "takeable_until", "audience", "needs_student_check")
    OFFER_ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    TERMS_FIELD_NUMBER: _ClassVar[int]
    PRICE_FIELD_NUMBER: _ClassVar[int]
    LIST_PRICE_FIELD_NUMBER: _ClassVar[int]
    MONTHS_AT_OFFER_PRICE_FIELD_NUMBER: _ClassVar[int]
    TAKEABLE_UNTIL_FIELD_NUMBER: _ClassVar[int]
    AUDIENCE_FIELD_NUMBER: _ClassVar[int]
    NEEDS_STUDENT_CHECK_FIELD_NUMBER: _ClassVar[int]
    offer_id: int
    version: int
    market: str
    plan: str
    title: str
    text: str
    terms: str
    price: _common_pb2.Money
    list_price: _common_pb2.Money
    months_at_offer_price: int
    takeable_until: _common_pb2.LocalTime
    audience: str
    needs_student_check: bool
    def __init__(self, offer_id: _Optional[int] = ..., version: _Optional[int] = ..., market: _Optional[str] = ..., plan: _Optional[str] = ..., title: _Optional[str] = ..., text: _Optional[str] = ..., terms: _Optional[str] = ..., price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., list_price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., months_at_offer_price: _Optional[int] = ..., takeable_until: _Optional[_Union[_common_pb2.LocalTime, _Mapping]] = ..., audience: _Optional[str] = ..., needs_student_check: bool = ...) -> None: ...

class ListOffersRequest(_message.Message):
    __slots__ = ("market", "at")
    MARKET_FIELD_NUMBER: _ClassVar[int]
    AT_FIELD_NUMBER: _ClassVar[int]
    market: str
    at: str
    def __init__(self, market: _Optional[str] = ..., at: _Optional[str] = ...) -> None: ...

class ListOffersResponse(_message.Message):
    __slots__ = ("offers",)
    OFFERS_FIELD_NUMBER: _ClassVar[int]
    offers: _containers.RepeatedCompositeFieldContainer[PublishedOffer]
    def __init__(self, offers: _Optional[_Iterable[_Union[PublishedOffer, _Mapping]]] = ...) -> None: ...
