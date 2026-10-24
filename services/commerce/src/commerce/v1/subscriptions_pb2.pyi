from commerce.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class PaymentState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PAYMENT_STATE_UNSPECIFIED: _ClassVar[PaymentState]
    PAYMENT_STATE_PENDING: _ClassVar[PaymentState]
    PAYMENT_STATE_SUCCEEDED: _ClassVar[PaymentState]
    PAYMENT_STATE_FAILED: _ClassVar[PaymentState]
PAYMENT_STATE_UNSPECIFIED: PaymentState
PAYMENT_STATE_PENDING: PaymentState
PAYMENT_STATE_SUCCEEDED: PaymentState
PAYMENT_STATE_FAILED: PaymentState

class DemoListener(_message.Message):
    __slots__ = ("subscriber_id", "market", "title", "label", "plan", "student_verified")
    SUBSCRIBER_ID_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    LABEL_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    STUDENT_VERIFIED_FIELD_NUMBER: _ClassVar[int]
    subscriber_id: int
    market: str
    title: str
    label: str
    plan: str
    student_verified: bool
    def __init__(self, subscriber_id: _Optional[int] = ..., market: _Optional[str] = ..., title: _Optional[str] = ..., label: _Optional[str] = ..., plan: _Optional[str] = ..., student_verified: bool = ...) -> None: ...

class ListDemoListenersRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListDemoListenersResponse(_message.Message):
    __slots__ = ("listeners",)
    LISTENERS_FIELD_NUMBER: _ClassVar[int]
    listeners: _containers.RepeatedCompositeFieldContainer[DemoListener]
    def __init__(self, listeners: _Optional[_Iterable[_Union[DemoListener, _Mapping]]] = ...) -> None: ...

class StudentVerification(_message.Message):
    __slots__ = ("verified_on", "valid_until", "provider", "reference", "valid")
    VERIFIED_ON_FIELD_NUMBER: _ClassVar[int]
    VALID_UNTIL_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    VALID_FIELD_NUMBER: _ClassVar[int]
    verified_on: str
    valid_until: str
    provider: str
    reference: str
    valid: bool
    def __init__(self, verified_on: _Optional[str] = ..., valid_until: _Optional[str] = ..., provider: _Optional[str] = ..., reference: _Optional[str] = ..., valid: bool = ...) -> None: ...

class VerifyStudentRequest(_message.Message):
    __slots__ = ("subscriber_id",)
    SUBSCRIBER_ID_FIELD_NUMBER: _ClassVar[int]
    subscriber_id: int
    def __init__(self, subscriber_id: _Optional[int] = ...) -> None: ...

class VerifyStudentResponse(_message.Message):
    __slots__ = ("verification", "refusal")
    VERIFICATION_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    verification: StudentVerification
    refusal: _common_pb2.Refusal
    def __init__(self, verification: _Optional[_Union[StudentVerification, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class Subscription(_message.Message):
    __slots__ = ("subscription_id", "plan", "market", "paid", "price", "started_on", "billing_day", "offer_id", "offer_title", "offer_months", "offer_months_left", "full_price_from", "full_price", "next_billing_on", "next_charge")
    SUBSCRIPTION_ID_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    PAID_FIELD_NUMBER: _ClassVar[int]
    PRICE_FIELD_NUMBER: _ClassVar[int]
    STARTED_ON_FIELD_NUMBER: _ClassVar[int]
    BILLING_DAY_FIELD_NUMBER: _ClassVar[int]
    OFFER_ID_FIELD_NUMBER: _ClassVar[int]
    OFFER_TITLE_FIELD_NUMBER: _ClassVar[int]
    OFFER_MONTHS_FIELD_NUMBER: _ClassVar[int]
    OFFER_MONTHS_LEFT_FIELD_NUMBER: _ClassVar[int]
    FULL_PRICE_FROM_FIELD_NUMBER: _ClassVar[int]
    FULL_PRICE_FIELD_NUMBER: _ClassVar[int]
    NEXT_BILLING_ON_FIELD_NUMBER: _ClassVar[int]
    NEXT_CHARGE_FIELD_NUMBER: _ClassVar[int]
    subscription_id: int
    plan: str
    market: str
    paid: bool
    price: _common_pb2.Money
    started_on: str
    billing_day: int
    offer_id: int
    offer_title: str
    offer_months: int
    offer_months_left: int
    full_price_from: str
    full_price: _common_pb2.Money
    next_billing_on: str
    next_charge: _common_pb2.Money
    def __init__(self, subscription_id: _Optional[int] = ..., plan: _Optional[str] = ..., market: _Optional[str] = ..., paid: bool = ..., price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., started_on: _Optional[str] = ..., billing_day: _Optional[int] = ..., offer_id: _Optional[int] = ..., offer_title: _Optional[str] = ..., offer_months: _Optional[int] = ..., offer_months_left: _Optional[int] = ..., full_price_from: _Optional[str] = ..., full_price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., next_billing_on: _Optional[str] = ..., next_charge: _Optional[_Union[_common_pb2.Money, _Mapping]] = ...) -> None: ...

class Receipt(_message.Message):
    __slots__ = ("receipt_id", "amount", "issued_at", "provider", "provider_reference", "demonstration", "note")
    RECEIPT_ID_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_FIELD_NUMBER: _ClassVar[int]
    ISSUED_AT_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_REFERENCE_FIELD_NUMBER: _ClassVar[int]
    DEMONSTRATION_FIELD_NUMBER: _ClassVar[int]
    NOTE_FIELD_NUMBER: _ClassVar[int]
    receipt_id: str
    amount: _common_pb2.Money
    issued_at: str
    provider: str
    provider_reference: str
    demonstration: bool
    note: str
    def __init__(self, receipt_id: _Optional[str] = ..., amount: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., issued_at: _Optional[str] = ..., provider: _Optional[str] = ..., provider_reference: _Optional[str] = ..., demonstration: bool = ..., note: _Optional[str] = ...) -> None: ...

class Payment(_message.Message):
    __slots__ = ("payment_id", "state", "amount", "provider", "requested_at", "settled_at", "failure_reason", "receipt")
    PAYMENT_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    REQUESTED_AT_FIELD_NUMBER: _ClassVar[int]
    SETTLED_AT_FIELD_NUMBER: _ClassVar[int]
    FAILURE_REASON_FIELD_NUMBER: _ClassVar[int]
    RECEIPT_FIELD_NUMBER: _ClassVar[int]
    payment_id: str
    state: PaymentState
    amount: _common_pb2.Money
    provider: str
    requested_at: str
    settled_at: str
    failure_reason: str
    receipt: Receipt
    def __init__(self, payment_id: _Optional[str] = ..., state: _Optional[_Union[PaymentState, str]] = ..., amount: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., provider: _Optional[str] = ..., requested_at: _Optional[str] = ..., settled_at: _Optional[str] = ..., failure_reason: _Optional[str] = ..., receipt: _Optional[_Union[Receipt, _Mapping]] = ...) -> None: ...

class Confirmation(_message.Message):
    __slots__ = ("subscription", "receipt", "payment")
    SUBSCRIPTION_FIELD_NUMBER: _ClassVar[int]
    RECEIPT_FIELD_NUMBER: _ClassVar[int]
    PAYMENT_FIELD_NUMBER: _ClassVar[int]
    subscription: Subscription
    receipt: Receipt
    payment: Payment
    def __init__(self, subscription: _Optional[_Union[Subscription, _Mapping]] = ..., receipt: _Optional[_Union[Receipt, _Mapping]] = ..., payment: _Optional[_Union[Payment, _Mapping]] = ...) -> None: ...

class ConfirmQuoteRequest(_message.Message):
    __slots__ = ("quote_id", "subscriber_id")
    QUOTE_ID_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIBER_ID_FIELD_NUMBER: _ClassVar[int]
    quote_id: str
    subscriber_id: int
    def __init__(self, quote_id: _Optional[str] = ..., subscriber_id: _Optional[int] = ...) -> None: ...

class ConfirmQuoteResponse(_message.Message):
    __slots__ = ("confirmation", "refusal")
    CONFIRMATION_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    confirmation: Confirmation
    refusal: _common_pb2.Refusal
    def __init__(self, confirmation: _Optional[_Union[Confirmation, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class Account(_message.Message):
    __slots__ = ("subscriber_id", "market", "subscription", "student_verification", "payment", "price_changes")
    SUBSCRIBER_ID_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIPTION_FIELD_NUMBER: _ClassVar[int]
    STUDENT_VERIFICATION_FIELD_NUMBER: _ClassVar[int]
    PAYMENT_FIELD_NUMBER: _ClassVar[int]
    PRICE_CHANGES_FIELD_NUMBER: _ClassVar[int]
    subscriber_id: int
    market: str
    subscription: Subscription
    student_verification: StudentVerification
    payment: Payment
    price_changes: _containers.RepeatedCompositeFieldContainer[PriceChange]
    def __init__(self, subscriber_id: _Optional[int] = ..., market: _Optional[str] = ..., subscription: _Optional[_Union[Subscription, _Mapping]] = ..., student_verification: _Optional[_Union[StudentVerification, _Mapping]] = ..., payment: _Optional[_Union[Payment, _Mapping]] = ..., price_changes: _Optional[_Iterable[_Union[PriceChange, _Mapping]]] = ...) -> None: ...

class PriceChange(_message.Message):
    __slots__ = ("price_change_id", "change_id", "plan", "old_price", "new_price", "kind", "sent_at", "window_ends", "state", "new_price_from", "if_no_answer", "legal_basis")
    PRICE_CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    OLD_PRICE_FIELD_NUMBER: _ClassVar[int]
    NEW_PRICE_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    SENT_AT_FIELD_NUMBER: _ClassVar[int]
    WINDOW_ENDS_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    NEW_PRICE_FROM_FIELD_NUMBER: _ClassVar[int]
    IF_NO_ANSWER_FIELD_NUMBER: _ClassVar[int]
    LEGAL_BASIS_FIELD_NUMBER: _ClassVar[int]
    price_change_id: int
    change_id: int
    plan: str
    old_price: _common_pb2.Money
    new_price: _common_pb2.Money
    kind: str
    sent_at: str
    window_ends: _common_pb2.LocalTime
    state: str
    new_price_from: str
    if_no_answer: str
    legal_basis: str
    def __init__(self, price_change_id: _Optional[int] = ..., change_id: _Optional[int] = ..., plan: _Optional[str] = ..., old_price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., new_price: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., kind: _Optional[str] = ..., sent_at: _Optional[str] = ..., window_ends: _Optional[_Union[_common_pb2.LocalTime, _Mapping]] = ..., state: _Optional[str] = ..., new_price_from: _Optional[str] = ..., if_no_answer: _Optional[str] = ..., legal_basis: _Optional[str] = ...) -> None: ...

class AnswerPriceChangeRequest(_message.Message):
    __slots__ = ("subscriber_id", "price_change_id", "accept")
    SUBSCRIBER_ID_FIELD_NUMBER: _ClassVar[int]
    PRICE_CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    ACCEPT_FIELD_NUMBER: _ClassVar[int]
    subscriber_id: int
    price_change_id: int
    accept: bool
    def __init__(self, subscriber_id: _Optional[int] = ..., price_change_id: _Optional[int] = ..., accept: bool = ...) -> None: ...

class AnswerPriceChangeResponse(_message.Message):
    __slots__ = ("price_change", "refusal")
    PRICE_CHANGE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    price_change: PriceChange
    refusal: _common_pb2.Refusal
    def __init__(self, price_change: _Optional[_Union[PriceChange, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class GetAccountRequest(_message.Message):
    __slots__ = ("subscriber_id",)
    SUBSCRIBER_ID_FIELD_NUMBER: _ClassVar[int]
    subscriber_id: int
    def __init__(self, subscriber_id: _Optional[int] = ...) -> None: ...

class GetAccountResponse(_message.Message):
    __slots__ = ("account",)
    ACCOUNT_FIELD_NUMBER: _ClassVar[int]
    account: Account
    def __init__(self, account: _Optional[_Union[Account, _Mapping]] = ...) -> None: ...
