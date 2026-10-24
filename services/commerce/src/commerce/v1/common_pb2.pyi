from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Role(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ROLE_UNSPECIFIED: _ClassVar[Role]
    ROLE_MARKETING: _ClassVar[Role]
    ROLE_COMMERCIAL_LEAD: _ClassVar[Role]
    ROLE_FINANCE: _ClassVar[Role]
    ROLE_CATALOG_MANAGER: _ClassVar[Role]
    ROLE_ON_CALL: _ClassVar[Role]
    ROLE_AUDITOR: _ClassVar[Role]

class RefusalCode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    REFUSAL_CODE_UNSPECIFIED: _ClassVar[RefusalCode]
    REFUSAL_CODE_OWN_VERSION: _ClassVar[RefusalCode]
    REFUSAL_CODE_ROLE_NOT_ALLOWED: _ClassVar[RefusalCode]
    REFUSAL_CODE_STALE_VERSION: _ClassVar[RefusalCode]
    REFUSAL_CODE_WRONG_STATE: _ClassVar[RefusalCode]
    REFUSAL_CODE_OVERLAP: _ClassVar[RefusalCode]
    REFUSAL_CODE_INVALID: _ClassVar[RefusalCode]
    REFUSAL_CODE_ALREADY_SIGNED: _ClassVar[RefusalCode]
    REFUSAL_CODE_FINGERPRINT_MISMATCH: _ClassVar[RefusalCode]
    REFUSAL_CODE_REASON_REQUIRED: _ClassVar[RefusalCode]
    REFUSAL_CODE_AMBIGUOUS_LOCAL_TIME: _ClassVar[RefusalCode]
    REFUSAL_CODE_QUOTE_EXPIRED: _ClassVar[RefusalCode]
    REFUSAL_CODE_NOT_ELIGIBLE: _ClassVar[RefusalCode]
    REFUSAL_CODE_ALREADY_SUBSCRIBED: _ClassVar[RefusalCode]
    REFUSAL_CODE_NOT_COMBINABLE: _ClassVar[RefusalCode]
    REFUSAL_CODE_CAP_REACHED: _ClassVar[RefusalCode]
    REFUSAL_CODE_PAYMENT_DECLINED: _ClassVar[RefusalCode]
ROLE_UNSPECIFIED: Role
ROLE_MARKETING: Role
ROLE_COMMERCIAL_LEAD: Role
ROLE_FINANCE: Role
ROLE_CATALOG_MANAGER: Role
ROLE_ON_CALL: Role
ROLE_AUDITOR: Role
REFUSAL_CODE_UNSPECIFIED: RefusalCode
REFUSAL_CODE_OWN_VERSION: RefusalCode
REFUSAL_CODE_ROLE_NOT_ALLOWED: RefusalCode
REFUSAL_CODE_STALE_VERSION: RefusalCode
REFUSAL_CODE_WRONG_STATE: RefusalCode
REFUSAL_CODE_OVERLAP: RefusalCode
REFUSAL_CODE_INVALID: RefusalCode
REFUSAL_CODE_ALREADY_SIGNED: RefusalCode
REFUSAL_CODE_FINGERPRINT_MISMATCH: RefusalCode
REFUSAL_CODE_REASON_REQUIRED: RefusalCode
REFUSAL_CODE_AMBIGUOUS_LOCAL_TIME: RefusalCode
REFUSAL_CODE_QUOTE_EXPIRED: RefusalCode
REFUSAL_CODE_NOT_ELIGIBLE: RefusalCode
REFUSAL_CODE_ALREADY_SUBSCRIBED: RefusalCode
REFUSAL_CODE_NOT_COMBINABLE: RefusalCode
REFUSAL_CODE_CAP_REACHED: RefusalCode
REFUSAL_CODE_PAYMENT_DECLINED: RefusalCode

class Money(_message.Message):
    __slots__ = ("amount_minor", "currency")
    AMOUNT_MINOR_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    amount_minor: int
    currency: str
    def __init__(self, amount_minor: _Optional[int] = ..., currency: _Optional[str] = ...) -> None: ...

class LocalTime(_message.Message):
    __slots__ = ("market", "local", "utc")
    MARKET_FIELD_NUMBER: _ClassVar[int]
    LOCAL_FIELD_NUMBER: _ClassVar[int]
    UTC_FIELD_NUMBER: _ClassVar[int]
    market: str
    local: str
    utc: str
    def __init__(self, market: _Optional[str] = ..., local: _Optional[str] = ..., utc: _Optional[str] = ...) -> None: ...

class Refusal(_message.Message):
    __slots__ = ("code", "reason", "facts")
    class FactsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    CODE_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    FACTS_FIELD_NUMBER: _ClassVar[int]
    code: RefusalCode
    reason: str
    facts: _containers.ScalarMap[str, str]
    def __init__(self, code: _Optional[_Union[RefusalCode, str]] = ..., reason: _Optional[str] = ..., facts: _Optional[_Mapping[str, str]] = ...) -> None: ...

class PageRequest(_message.Message):
    __slots__ = ("size", "after")
    SIZE_FIELD_NUMBER: _ClassVar[int]
    AFTER_FIELD_NUMBER: _ClassVar[int]
    size: int
    after: str
    def __init__(self, size: _Optional[int] = ..., after: _Optional[str] = ...) -> None: ...

class PageInfo(_message.Message):
    __slots__ = ("next",)
    NEXT_FIELD_NUMBER: _ClassVar[int]
    next: str
    def __init__(self, next: _Optional[str] = ...) -> None: ...
