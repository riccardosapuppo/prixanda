from commerce.v1 import catalog_pb2 as _catalog_pb2
from commerce.v1 import common_pb2 as _common_pb2
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GetQuoteRequest(_message.Message):
    __slots__ = ("plan", "market", "offer_id", "subscriber_id")
    PLAN_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    OFFER_ID_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIBER_ID_FIELD_NUMBER: _ClassVar[int]
    plan: str
    market: str
    offer_id: int
    subscriber_id: int
    def __init__(self, plan: _Optional[str] = ..., market: _Optional[str] = ..., offer_id: _Optional[int] = ..., subscriber_id: _Optional[int] = ...) -> None: ...

class Quote(_message.Message):
    __slots__ = ("quote_id", "plan", "market", "price", "list_price", "months_at_price", "then_price", "expires_at", "offer_id", "breakdown")
    QUOTE_ID_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    PRICE_FIELD_NUMBER: _ClassVar[int]
    LIST_PRICE_FIELD_NUMBER: _ClassVar[int]
    MONTHS_AT_PRICE_FIELD_NUMBER: _ClassVar[int]
    THEN_PRICE_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_FIELD_NUMBER: _ClassVar[int]
    OFFER_ID_FIELD_NUMBER: _ClassVar[int]
    BREAKDOWN_FIELD_NUMBER: _ClassVar[int]
    quote_id: str
    plan: str
    market: str
    price: _common_pb2.Money
    list_price: _common_pb2.Money
    months_at_price: int
    then_price: _common_pb2.Money
    expires_at: str
    offer_id: int
    breakdown: _catalog_pb2.PriceBreakdown
    def __init__(self, quote_id: _Optional[str] = ..., plan: _Optional[str] = ..., market: _Optional[str] = ..., price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., list_price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., months_at_price: _Optional[int] = ..., then_price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., expires_at: _Optional[str] = ..., offer_id: _Optional[int] = ..., breakdown: _Optional[_Union[_catalog_pb2.PriceBreakdown, _Mapping]] = ...) -> None: ...

class GetQuoteResponse(_message.Message):
    __slots__ = ("quote", "refusal")
    QUOTE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    quote: Quote
    refusal: _common_pb2.Refusal
    def __init__(self, quote: _Optional[_Union[Quote, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...
