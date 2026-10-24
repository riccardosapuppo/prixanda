from commerce.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Assumption(_message.Message):
    __slots__ = ("name", "value", "source")
    NAME_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    name: str
    value: int
    source: str
    def __init__(self, name: _Optional[str] = ..., value: _Optional[int] = ..., source: _Optional[str] = ...) -> None: ...

class AssumptionOverride(_message.Message):
    __slots__ = ("name", "value")
    NAME_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    name: str
    value: int
    def __init__(self, name: _Optional[str] = ..., value: _Optional[int] = ...) -> None: ...

class SimulateOfferRequest(_message.Message):
    __slots__ = ("change_id", "version", "market", "overrides")
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    OVERRIDES_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    version: int
    market: str
    overrides: _containers.RepeatedCompositeFieldContainer[AssumptionOverride]
    def __init__(self, change_id: _Optional[int] = ..., version: _Optional[int] = ..., market: _Optional[str] = ..., overrides: _Optional[_Iterable[_Union[AssumptionOverride, _Mapping]]] = ...) -> None: ...

class Totals(_message.Message):
    __slots__ = ("revenue", "artists", "payment_costs", "contribution")
    REVENUE_FIELD_NUMBER: _ClassVar[int]
    ARTISTS_FIELD_NUMBER: _ClassVar[int]
    PAYMENT_COSTS_FIELD_NUMBER: _ClassVar[int]
    CONTRIBUTION_FIELD_NUMBER: _ClassVar[int]
    revenue: _common_pb2.Money
    artists: _common_pb2.Money
    payment_costs: _common_pb2.Money
    contribution: _common_pb2.Money
    def __init__(self, revenue: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., artists: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., payment_costs: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., contribution: _Optional[_Union[_common_pb2.Money, _Mapping]] = ...) -> None: ...

class FinanceCondition(_message.Message):
    __slots__ = ("number", "rule", "met", "detail")
    NUMBER_FIELD_NUMBER: _ClassVar[int]
    RULE_FIELD_NUMBER: _ClassVar[int]
    MET_FIELD_NUMBER: _ClassVar[int]
    DETAIL_FIELD_NUMBER: _ClassVar[int]
    number: int
    rule: str
    met: bool
    detail: str
    def __init__(self, number: _Optional[int] = ..., rule: _Optional[str] = ..., met: bool = ..., detail: _Optional[str] = ...) -> None: ...

class SimulationResult(_message.Message):
    __slots__ = ("eligible", "takers", "stayers", "cannibalized", "with_offer", "without_offer", "difference", "discount_cost", "top_up_cost", "finance_conditions", "break_even_retention_bp", "assumptions", "horizon_months")
    ELIGIBLE_FIELD_NUMBER: _ClassVar[int]
    TAKERS_FIELD_NUMBER: _ClassVar[int]
    STAYERS_FIELD_NUMBER: _ClassVar[int]
    CANNIBALIZED_FIELD_NUMBER: _ClassVar[int]
    WITH_OFFER_FIELD_NUMBER: _ClassVar[int]
    WITHOUT_OFFER_FIELD_NUMBER: _ClassVar[int]
    DIFFERENCE_FIELD_NUMBER: _ClassVar[int]
    DISCOUNT_COST_FIELD_NUMBER: _ClassVar[int]
    TOP_UP_COST_FIELD_NUMBER: _ClassVar[int]
    FINANCE_CONDITIONS_FIELD_NUMBER: _ClassVar[int]
    BREAK_EVEN_RETENTION_BP_FIELD_NUMBER: _ClassVar[int]
    ASSUMPTIONS_FIELD_NUMBER: _ClassVar[int]
    HORIZON_MONTHS_FIELD_NUMBER: _ClassVar[int]
    eligible: int
    takers: int
    stayers: int
    cannibalized: int
    with_offer: Totals
    without_offer: Totals
    difference: Totals
    discount_cost: _common_pb2.Money
    top_up_cost: _common_pb2.Money
    finance_conditions: _containers.RepeatedCompositeFieldContainer[FinanceCondition]
    break_even_retention_bp: int
    assumptions: _containers.RepeatedCompositeFieldContainer[Assumption]
    horizon_months: int
    def __init__(self, eligible: _Optional[int] = ..., takers: _Optional[int] = ..., stayers: _Optional[int] = ..., cannibalized: _Optional[int] = ..., with_offer: _Optional[_Union[Totals, _Mapping]] = ..., without_offer: _Optional[_Union[Totals, _Mapping]] = ..., difference: _Optional[_Union[Totals, _Mapping]] = ..., discount_cost: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., top_up_cost: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., finance_conditions: _Optional[_Iterable[_Union[FinanceCondition, _Mapping]]] = ..., break_even_retention_bp: _Optional[int] = ..., assumptions: _Optional[_Iterable[_Union[Assumption, _Mapping]]] = ..., horizon_months: _Optional[int] = ...) -> None: ...

class SimulateOfferResponse(_message.Message):
    __slots__ = ("result", "refusal")
    RESULT_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    result: SimulationResult
    refusal: _common_pb2.Refusal
    def __init__(self, result: _Optional[_Union[SimulationResult, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...
