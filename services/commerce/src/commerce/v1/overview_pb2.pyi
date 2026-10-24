from commerce.v1 import changes_pb2 as _changes_pb2
from commerce.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GetOverviewRequest(_message.Message):
    __slots__ = ("at",)
    AT_FIELD_NUMBER: _ClassVar[int]
    at: str
    def __init__(self, at: _Optional[str] = ...) -> None: ...

class Launch(_message.Message):
    __slots__ = ("change_id", "title", "starts", "state", "at_risk", "risk")
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    STARTS_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    AT_RISK_FIELD_NUMBER: _ClassVar[int]
    RISK_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    title: str
    starts: _common_pb2.LocalTime
    state: _changes_pb2.ChangeState
    at_risk: bool
    risk: str
    def __init__(self, change_id: _Optional[int] = ..., title: _Optional[str] = ..., starts: _Optional[_Union[_common_pb2.LocalTime, _Mapping]] = ..., state: _Optional[_Union[_changes_pb2.ChangeState, str]] = ..., at_risk: bool = ..., risk: _Optional[str] = ...) -> None: ...

class Incident(_message.Message):
    __slots__ = ("change_id", "title", "run", "state", "summary")
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    RUN_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    title: str
    run: str
    state: str
    summary: str
    def __init__(self, change_id: _Optional[int] = ..., title: _Optional[str] = ..., run: _Optional[str] = ..., state: _Optional[str] = ..., summary: _Optional[str] = ...) -> None: ...

class SubscriberCount(_message.Message):
    __slots__ = ("market", "plan", "count")
    MARKET_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    market: str
    plan: str
    count: int
    def __init__(self, market: _Optional[str] = ..., plan: _Optional[str] = ..., count: _Optional[int] = ...) -> None: ...

class MarketRevenue(_message.Message):
    __slots__ = ("market", "revenue", "revenue_eur")
    MARKET_FIELD_NUMBER: _ClassVar[int]
    REVENUE_FIELD_NUMBER: _ClassVar[int]
    REVENUE_EUR_FIELD_NUMBER: _ClassVar[int]
    market: str
    revenue: _common_pb2.Money
    revenue_eur: _common_pb2.Money
    def __init__(self, market: _Optional[str] = ..., revenue: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., revenue_eur: _Optional[_Union[_common_pb2.Money, _Mapping]] = ...) -> None: ...

class GetOverviewResponse(_message.Message):
    __slots__ = ("waiting_for_approval", "launches_next_7_days", "incidents_today", "paying_subscribers", "free_listeners", "monthly_revenue", "monthly_revenue_eur", "exchange_rate_note", "monthly_top_ups")
    WAITING_FOR_APPROVAL_FIELD_NUMBER: _ClassVar[int]
    LAUNCHES_NEXT_7_DAYS_FIELD_NUMBER: _ClassVar[int]
    INCIDENTS_TODAY_FIELD_NUMBER: _ClassVar[int]
    PAYING_SUBSCRIBERS_FIELD_NUMBER: _ClassVar[int]
    FREE_LISTENERS_FIELD_NUMBER: _ClassVar[int]
    MONTHLY_REVENUE_FIELD_NUMBER: _ClassVar[int]
    MONTHLY_REVENUE_EUR_FIELD_NUMBER: _ClassVar[int]
    EXCHANGE_RATE_NOTE_FIELD_NUMBER: _ClassVar[int]
    MONTHLY_TOP_UPS_FIELD_NUMBER: _ClassVar[int]
    waiting_for_approval: _containers.RepeatedCompositeFieldContainer[_changes_pb2.ChangeSummary]
    launches_next_7_days: _containers.RepeatedCompositeFieldContainer[Launch]
    incidents_today: _containers.RepeatedCompositeFieldContainer[Incident]
    paying_subscribers: _containers.RepeatedCompositeFieldContainer[SubscriberCount]
    free_listeners: _containers.RepeatedCompositeFieldContainer[SubscriberCount]
    monthly_revenue: _containers.RepeatedCompositeFieldContainer[MarketRevenue]
    monthly_revenue_eur: _common_pb2.Money
    exchange_rate_note: str
    monthly_top_ups: _common_pb2.Money
    def __init__(self, waiting_for_approval: _Optional[_Iterable[_Union[_changes_pb2.ChangeSummary, _Mapping]]] = ..., launches_next_7_days: _Optional[_Iterable[_Union[Launch, _Mapping]]] = ..., incidents_today: _Optional[_Iterable[_Union[Incident, _Mapping]]] = ..., paying_subscribers: _Optional[_Iterable[_Union[SubscriberCount, _Mapping]]] = ..., free_listeners: _Optional[_Iterable[_Union[SubscriberCount, _Mapping]]] = ..., monthly_revenue: _Optional[_Iterable[_Union[MarketRevenue, _Mapping]]] = ..., monthly_revenue_eur: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., exchange_rate_note: _Optional[str] = ..., monthly_top_ups: _Optional[_Union[_common_pb2.Money, _Mapping]] = ...) -> None: ...

class Person(_message.Message):
    __slots__ = ("id", "label", "roles")
    ID_FIELD_NUMBER: _ClassVar[int]
    LABEL_FIELD_NUMBER: _ClassVar[int]
    ROLES_FIELD_NUMBER: _ClassVar[int]
    id: str
    label: str
    roles: _containers.RepeatedScalarFieldContainer[_common_pb2.Role]
    def __init__(self, id: _Optional[str] = ..., label: _Optional[str] = ..., roles: _Optional[_Iterable[_Union[_common_pb2.Role, str]]] = ...) -> None: ...

class ListPeopleRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListPeopleResponse(_message.Message):
    __slots__ = ("people",)
    PEOPLE_FIELD_NUMBER: _ClassVar[int]
    people: _containers.RepeatedCompositeFieldContainer[Person]
    def __init__(self, people: _Optional[_Iterable[_Union[Person, _Mapping]]] = ...) -> None: ...
