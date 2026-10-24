from commerce.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ChangeKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CHANGE_KIND_UNSPECIFIED: _ClassVar[ChangeKind]
    CHANGE_KIND_OFFER: _ClassVar[ChangeKind]
    CHANGE_KIND_LIST_PRICE: _ClassVar[ChangeKind]
    CHANGE_KIND_ENTITLEMENT: _ClassVar[ChangeKind]
    CHANGE_KIND_PRICE_MIGRATION: _ClassVar[ChangeKind]
    CHANGE_KIND_PREPAID: _ClassVar[ChangeKind]

class ChangeState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CHANGE_STATE_UNSPECIFIED: _ClassVar[ChangeState]
    CHANGE_STATE_DRAFT: _ClassVar[ChangeState]
    CHANGE_STATE_VALIDATED: _ClassVar[ChangeState]
    CHANGE_STATE_IN_APPROVAL: _ClassVar[ChangeState]
    CHANGE_STATE_APPROVED: _ClassVar[ChangeState]
    CHANGE_STATE_SCHEDULED: _ClassVar[ChangeState]
    CHANGE_STATE_ACTIVE: _ClassVar[ChangeState]
    CHANGE_STATE_ENDED: _ClassVar[ChangeState]
    CHANGE_STATE_SUSPENDED: _ClassVar[ChangeState]
    CHANGE_STATE_CANCELLED: _ClassVar[ChangeState]

class Segment(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SEGMENT_UNSPECIFIED: _ClassVar[Segment]
    SEGMENT_NEVER_PAID: _ClassVar[Segment]
    SEGMENT_FREE_LISTENERS: _ClassVar[Segment]
    SEGMENT_SUBSCRIBERS_OF_PLAN: _ClassVar[Segment]
    SEGMENT_ANYONE: _ClassVar[Segment]

class Severity(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SEVERITY_UNSPECIFIED: _ClassVar[Severity]
    SEVERITY_BLOCKING: _ClassVar[Severity]
    SEVERITY_NEEDS_SIGNATURE: _ClassVar[Severity]
    SEVERITY_INFO: _ClassVar[Severity]
CHANGE_KIND_UNSPECIFIED: ChangeKind
CHANGE_KIND_OFFER: ChangeKind
CHANGE_KIND_LIST_PRICE: ChangeKind
CHANGE_KIND_ENTITLEMENT: ChangeKind
CHANGE_KIND_PRICE_MIGRATION: ChangeKind
CHANGE_KIND_PREPAID: ChangeKind
CHANGE_STATE_UNSPECIFIED: ChangeState
CHANGE_STATE_DRAFT: ChangeState
CHANGE_STATE_VALIDATED: ChangeState
CHANGE_STATE_IN_APPROVAL: ChangeState
CHANGE_STATE_APPROVED: ChangeState
CHANGE_STATE_SCHEDULED: ChangeState
CHANGE_STATE_ACTIVE: ChangeState
CHANGE_STATE_ENDED: ChangeState
CHANGE_STATE_SUSPENDED: ChangeState
CHANGE_STATE_CANCELLED: ChangeState
SEGMENT_UNSPECIFIED: Segment
SEGMENT_NEVER_PAID: Segment
SEGMENT_FREE_LISTENERS: Segment
SEGMENT_SUBSCRIBERS_OF_PLAN: Segment
SEGMENT_ANYONE: Segment
SEVERITY_UNSPECIFIED: Severity
SEVERITY_BLOCKING: Severity
SEVERITY_NEEDS_SIGNATURE: Severity
SEVERITY_INFO: Severity

class ListeningRule(_message.Message):
    __slots__ = ("artist_id", "min_seconds", "within_days")
    ARTIST_ID_FIELD_NUMBER: _ClassVar[int]
    MIN_SECONDS_FIELD_NUMBER: _ClassVar[int]
    WITHIN_DAYS_FIELD_NUMBER: _ClassVar[int]
    artist_id: int
    min_seconds: int
    within_days: int
    def __init__(self, artist_id: _Optional[int] = ..., min_seconds: _Optional[int] = ..., within_days: _Optional[int] = ...) -> None: ...

class Audience(_message.Message):
    __slots__ = ("segment", "current_plan", "needs_student_check", "listening")
    SEGMENT_FIELD_NUMBER: _ClassVar[int]
    CURRENT_PLAN_FIELD_NUMBER: _ClassVar[int]
    NEEDS_STUDENT_CHECK_FIELD_NUMBER: _ClassVar[int]
    LISTENING_FIELD_NUMBER: _ClassVar[int]
    segment: Segment
    current_plan: str
    needs_student_check: bool
    listening: ListeningRule
    def __init__(self, segment: _Optional[_Union[Segment, str]] = ..., current_plan: _Optional[str] = ..., needs_student_check: bool = ..., listening: _Optional[_Union[ListeningRule, _Mapping]] = ...) -> None: ...

class OfferPrice(_message.Message):
    __slots__ = ("market", "fixed", "percent_off_bp")
    MARKET_FIELD_NUMBER: _ClassVar[int]
    FIXED_FIELD_NUMBER: _ClassVar[int]
    PERCENT_OFF_BP_FIELD_NUMBER: _ClassVar[int]
    market: str
    fixed: _common_pb2.Money
    percent_off_bp: int
    def __init__(self, market: _Optional[str] = ..., fixed: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., percent_off_bp: _Optional[int] = ...) -> None: ...

class OfferPeriod(_message.Message):
    __slots__ = ("market", "starts_local", "ends_local")
    MARKET_FIELD_NUMBER: _ClassVar[int]
    STARTS_LOCAL_FIELD_NUMBER: _ClassVar[int]
    ENDS_LOCAL_FIELD_NUMBER: _ClassVar[int]
    market: str
    starts_local: str
    ends_local: str
    def __init__(self, market: _Optional[str] = ..., starts_local: _Optional[str] = ..., ends_local: _Optional[str] = ...) -> None: ...

class OfferPage(_message.Message):
    __slots__ = ("market", "title", "text", "terms", "treatment")
    MARKET_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    TERMS_FIELD_NUMBER: _ClassVar[int]
    TREATMENT_FIELD_NUMBER: _ClassVar[int]
    market: str
    title: str
    text: str
    terms: str
    treatment: str
    def __init__(self, market: _Optional[str] = ..., title: _Optional[str] = ..., text: _Optional[str] = ..., terms: _Optional[str] = ..., treatment: _Optional[str] = ...) -> None: ...

class OfferContent(_message.Message):
    __slots__ = ("title", "plan", "audience", "prices", "months_at_offer_price", "periods", "non_combinability_group", "redemption_cap", "pages")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    AUDIENCE_FIELD_NUMBER: _ClassVar[int]
    PRICES_FIELD_NUMBER: _ClassVar[int]
    MONTHS_AT_OFFER_PRICE_FIELD_NUMBER: _ClassVar[int]
    PERIODS_FIELD_NUMBER: _ClassVar[int]
    NON_COMBINABILITY_GROUP_FIELD_NUMBER: _ClassVar[int]
    REDEMPTION_CAP_FIELD_NUMBER: _ClassVar[int]
    PAGES_FIELD_NUMBER: _ClassVar[int]
    title: str
    plan: str
    audience: Audience
    prices: _containers.RepeatedCompositeFieldContainer[OfferPrice]
    months_at_offer_price: int
    periods: _containers.RepeatedCompositeFieldContainer[OfferPeriod]
    non_combinability_group: str
    redemption_cap: int
    pages: _containers.RepeatedCompositeFieldContainer[OfferPage]
    def __init__(self, title: _Optional[str] = ..., plan: _Optional[str] = ..., audience: _Optional[_Union[Audience, _Mapping]] = ..., prices: _Optional[_Iterable[_Union[OfferPrice, _Mapping]]] = ..., months_at_offer_price: _Optional[int] = ..., periods: _Optional[_Iterable[_Union[OfferPeriod, _Mapping]]] = ..., non_combinability_group: _Optional[str] = ..., redemption_cap: _Optional[int] = ..., pages: _Optional[_Iterable[_Union[OfferPage, _Mapping]]] = ...) -> None: ...

class ListPriceContent(_message.Message):
    __slots__ = ("title", "plan", "market", "amount", "starts_local")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_FIELD_NUMBER: _ClassVar[int]
    STARTS_LOCAL_FIELD_NUMBER: _ClassVar[int]
    title: str
    plan: str
    market: str
    amount: _common_pb2.Money
    starts_local: str
    def __init__(self, title: _Optional[str] = ..., plan: _Optional[str] = ..., market: _Optional[str] = ..., amount: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., starts_local: _Optional[str] = ...) -> None: ...

class PriceMigrationContent(_message.Message):
    __slots__ = ("title", "plan", "market", "amount", "notices_local", "starts_local")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_FIELD_NUMBER: _ClassVar[int]
    NOTICES_LOCAL_FIELD_NUMBER: _ClassVar[int]
    STARTS_LOCAL_FIELD_NUMBER: _ClassVar[int]
    title: str
    plan: str
    market: str
    amount: _common_pb2.Money
    notices_local: str
    starts_local: str
    def __init__(self, title: _Optional[str] = ..., plan: _Optional[str] = ..., market: _Optional[str] = ..., amount: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., notices_local: _Optional[str] = ..., starts_local: _Optional[str] = ...) -> None: ...

class PrepaidPassContent(_message.Message):
    __slots__ = ("title", "plan", "months", "prices", "periods", "code_valid_months", "pages")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    MONTHS_FIELD_NUMBER: _ClassVar[int]
    PRICES_FIELD_NUMBER: _ClassVar[int]
    PERIODS_FIELD_NUMBER: _ClassVar[int]
    CODE_VALID_MONTHS_FIELD_NUMBER: _ClassVar[int]
    PAGES_FIELD_NUMBER: _ClassVar[int]
    title: str
    plan: str
    months: int
    prices: _containers.RepeatedCompositeFieldContainer[OfferPrice]
    periods: _containers.RepeatedCompositeFieldContainer[OfferPeriod]
    code_valid_months: int
    pages: _containers.RepeatedCompositeFieldContainer[OfferPage]
    def __init__(self, title: _Optional[str] = ..., plan: _Optional[str] = ..., months: _Optional[int] = ..., prices: _Optional[_Iterable[_Union[OfferPrice, _Mapping]]] = ..., periods: _Optional[_Iterable[_Union[OfferPeriod, _Mapping]]] = ..., code_valid_months: _Optional[int] = ..., pages: _Optional[_Iterable[_Union[OfferPage, _Mapping]]] = ...) -> None: ...

class MigrationProgress(_message.Message):
    __slots__ = ("requirement", "window_ends", "asked", "waiting", "accepted", "declined", "lapsed", "new_price", "left")
    REQUIREMENT_FIELD_NUMBER: _ClassVar[int]
    WINDOW_ENDS_FIELD_NUMBER: _ClassVar[int]
    ASKED_FIELD_NUMBER: _ClassVar[int]
    WAITING_FIELD_NUMBER: _ClassVar[int]
    ACCEPTED_FIELD_NUMBER: _ClassVar[int]
    DECLINED_FIELD_NUMBER: _ClassVar[int]
    LAPSED_FIELD_NUMBER: _ClassVar[int]
    NEW_PRICE_FIELD_NUMBER: _ClassVar[int]
    LEFT_FIELD_NUMBER: _ClassVar[int]
    requirement: str
    window_ends: _common_pb2.LocalTime
    asked: int
    waiting: int
    accepted: int
    declined: int
    lapsed: int
    new_price: int
    left: int
    def __init__(self, requirement: _Optional[str] = ..., window_ends: _Optional[_Union[_common_pb2.LocalTime, _Mapping]] = ..., asked: _Optional[int] = ..., waiting: _Optional[int] = ..., accepted: _Optional[int] = ..., declined: _Optional[int] = ..., lapsed: _Optional[int] = ..., new_price: _Optional[int] = ..., left: _Optional[int] = ...) -> None: ...

class ChangeVersion(_message.Message):
    __slots__ = ("version", "author", "created_at", "content_hash", "offer", "list_price", "price_migration", "prepaid")
    VERSION_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    CONTENT_HASH_FIELD_NUMBER: _ClassVar[int]
    OFFER_FIELD_NUMBER: _ClassVar[int]
    LIST_PRICE_FIELD_NUMBER: _ClassVar[int]
    PRICE_MIGRATION_FIELD_NUMBER: _ClassVar[int]
    PREPAID_FIELD_NUMBER: _ClassVar[int]
    version: int
    author: str
    created_at: str
    content_hash: bytes
    offer: OfferContent
    list_price: ListPriceContent
    price_migration: PriceMigrationContent
    prepaid: PrepaidPassContent
    def __init__(self, version: _Optional[int] = ..., author: _Optional[str] = ..., created_at: _Optional[str] = ..., content_hash: _Optional[bytes] = ..., offer: _Optional[_Union[OfferContent, _Mapping]] = ..., list_price: _Optional[_Union[ListPriceContent, _Mapping]] = ..., price_migration: _Optional[_Union[PriceMigrationContent, _Mapping]] = ..., prepaid: _Optional[_Union[PrepaidPassContent, _Mapping]] = ...) -> None: ...

class Approval(_message.Message):
    __slots__ = ("version", "approver", "role", "decided_at", "content_hash")
    VERSION_FIELD_NUMBER: _ClassVar[int]
    APPROVER_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    DECIDED_AT_FIELD_NUMBER: _ClassVar[int]
    CONTENT_HASH_FIELD_NUMBER: _ClassVar[int]
    version: int
    approver: str
    role: _common_pb2.Role
    decided_at: str
    content_hash: bytes
    def __init__(self, version: _Optional[int] = ..., approver: _Optional[str] = ..., role: _Optional[_Union[_common_pb2.Role, str]] = ..., decided_at: _Optional[str] = ..., content_hash: _Optional[bytes] = ...) -> None: ...

class RequiredSignature(_message.Message):
    __slots__ = ("role", "conditions", "why", "signed")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    CONDITIONS_FIELD_NUMBER: _ClassVar[int]
    WHY_FIELD_NUMBER: _ClassVar[int]
    SIGNED_FIELD_NUMBER: _ClassVar[int]
    role: _common_pb2.Role
    conditions: _containers.RepeatedScalarFieldContainer[int]
    why: str
    signed: bool
    def __init__(self, role: _Optional[_Union[_common_pb2.Role, str]] = ..., conditions: _Optional[_Iterable[int]] = ..., why: _Optional[str] = ..., signed: bool = ...) -> None: ...

class ValidationFinding(_message.Message):
    __slots__ = ("check", "severity", "market", "message", "facts")
    class FactsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    CHECK_FIELD_NUMBER: _ClassVar[int]
    SEVERITY_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    FACTS_FIELD_NUMBER: _ClassVar[int]
    check: str
    severity: Severity
    market: str
    message: str
    facts: _containers.ScalarMap[str, str]
    def __init__(self, check: _Optional[str] = ..., severity: _Optional[_Union[Severity, str]] = ..., market: _Optional[str] = ..., message: _Optional[str] = ..., facts: _Optional[_Mapping[str, str]] = ...) -> None: ...

class ValidationReport(_message.Message):
    __slots__ = ("version", "valid", "findings", "eligible")
    VERSION_FIELD_NUMBER: _ClassVar[int]
    VALID_FIELD_NUMBER: _ClassVar[int]
    FINDINGS_FIELD_NUMBER: _ClassVar[int]
    ELIGIBLE_FIELD_NUMBER: _ClassVar[int]
    version: int
    valid: bool
    findings: _containers.RepeatedCompositeFieldContainer[ValidationFinding]
    eligible: int
    def __init__(self, version: _Optional[int] = ..., valid: bool = ..., findings: _Optional[_Iterable[_Union[ValidationFinding, _Mapping]]] = ..., eligible: _Optional[int] = ...) -> None: ...

class Change(_message.Message):
    __slots__ = ("id", "kind", "title", "state", "state_reason", "current_version", "created_by", "created_at", "versions", "approvals", "validation", "required_signatures", "sentence", "author_reason", "migration")
    ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    STATE_REASON_FIELD_NUMBER: _ClassVar[int]
    CURRENT_VERSION_FIELD_NUMBER: _ClassVar[int]
    CREATED_BY_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    VERSIONS_FIELD_NUMBER: _ClassVar[int]
    APPROVALS_FIELD_NUMBER: _ClassVar[int]
    VALIDATION_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_SIGNATURES_FIELD_NUMBER: _ClassVar[int]
    SENTENCE_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_REASON_FIELD_NUMBER: _ClassVar[int]
    MIGRATION_FIELD_NUMBER: _ClassVar[int]
    id: int
    kind: ChangeKind
    title: str
    state: ChangeState
    state_reason: str
    current_version: int
    created_by: str
    created_at: str
    versions: _containers.RepeatedCompositeFieldContainer[ChangeVersion]
    approvals: _containers.RepeatedCompositeFieldContainer[Approval]
    validation: ValidationReport
    required_signatures: _containers.RepeatedCompositeFieldContainer[RequiredSignature]
    sentence: str
    author_reason: str
    migration: MigrationProgress
    def __init__(self, id: _Optional[int] = ..., kind: _Optional[_Union[ChangeKind, str]] = ..., title: _Optional[str] = ..., state: _Optional[_Union[ChangeState, str]] = ..., state_reason: _Optional[str] = ..., current_version: _Optional[int] = ..., created_by: _Optional[str] = ..., created_at: _Optional[str] = ..., versions: _Optional[_Iterable[_Union[ChangeVersion, _Mapping]]] = ..., approvals: _Optional[_Iterable[_Union[Approval, _Mapping]]] = ..., validation: _Optional[_Union[ValidationReport, _Mapping]] = ..., required_signatures: _Optional[_Iterable[_Union[RequiredSignature, _Mapping]]] = ..., sentence: _Optional[str] = ..., author_reason: _Optional[str] = ..., migration: _Optional[_Union[MigrationProgress, _Mapping]] = ...) -> None: ...

class ChangeSummary(_message.Message):
    __slots__ = ("id", "kind", "title", "state", "current_version", "created_by", "markets", "required_signatures", "updated_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    CURRENT_VERSION_FIELD_NUMBER: _ClassVar[int]
    CREATED_BY_FIELD_NUMBER: _ClassVar[int]
    MARKETS_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_SIGNATURES_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: int
    kind: ChangeKind
    title: str
    state: ChangeState
    current_version: int
    created_by: str
    markets: _containers.RepeatedScalarFieldContainer[str]
    required_signatures: _containers.RepeatedCompositeFieldContainer[RequiredSignature]
    updated_at: str
    def __init__(self, id: _Optional[int] = ..., kind: _Optional[_Union[ChangeKind, str]] = ..., title: _Optional[str] = ..., state: _Optional[_Union[ChangeState, str]] = ..., current_version: _Optional[int] = ..., created_by: _Optional[str] = ..., markets: _Optional[_Iterable[str]] = ..., required_signatures: _Optional[_Iterable[_Union[RequiredSignature, _Mapping]]] = ..., updated_at: _Optional[str] = ...) -> None: ...

class CreateChangeRequest(_message.Message):
    __slots__ = ("offer", "list_price", "price_migration", "prepaid")
    OFFER_FIELD_NUMBER: _ClassVar[int]
    LIST_PRICE_FIELD_NUMBER: _ClassVar[int]
    PRICE_MIGRATION_FIELD_NUMBER: _ClassVar[int]
    PREPAID_FIELD_NUMBER: _ClassVar[int]
    offer: OfferContent
    list_price: ListPriceContent
    price_migration: PriceMigrationContent
    prepaid: PrepaidPassContent
    def __init__(self, offer: _Optional[_Union[OfferContent, _Mapping]] = ..., list_price: _Optional[_Union[ListPriceContent, _Mapping]] = ..., price_migration: _Optional[_Union[PriceMigrationContent, _Mapping]] = ..., prepaid: _Optional[_Union[PrepaidPassContent, _Mapping]] = ...) -> None: ...

class CreateChangeResponse(_message.Message):
    __slots__ = ("change", "refusal")
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    change: Change
    refusal: _common_pb2.Refusal
    def __init__(self, change: _Optional[_Union[Change, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class SaveVersionRequest(_message.Message):
    __slots__ = ("change_id", "base_version", "offer", "list_price", "price_migration", "prepaid")
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    BASE_VERSION_FIELD_NUMBER: _ClassVar[int]
    OFFER_FIELD_NUMBER: _ClassVar[int]
    LIST_PRICE_FIELD_NUMBER: _ClassVar[int]
    PRICE_MIGRATION_FIELD_NUMBER: _ClassVar[int]
    PREPAID_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    base_version: int
    offer: OfferContent
    list_price: ListPriceContent
    price_migration: PriceMigrationContent
    prepaid: PrepaidPassContent
    def __init__(self, change_id: _Optional[int] = ..., base_version: _Optional[int] = ..., offer: _Optional[_Union[OfferContent, _Mapping]] = ..., list_price: _Optional[_Union[ListPriceContent, _Mapping]] = ..., price_migration: _Optional[_Union[PriceMigrationContent, _Mapping]] = ..., prepaid: _Optional[_Union[PrepaidPassContent, _Mapping]] = ...) -> None: ...

class SaveVersionResponse(_message.Message):
    __slots__ = ("change", "refusal")
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    change: Change
    refusal: _common_pb2.Refusal
    def __init__(self, change: _Optional[_Union[Change, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class GetChangeRequest(_message.Message):
    __slots__ = ("change_id",)
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    def __init__(self, change_id: _Optional[int] = ...) -> None: ...

class GetChangeResponse(_message.Message):
    __slots__ = ("change",)
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    change: Change
    def __init__(self, change: _Optional[_Union[Change, _Mapping]] = ...) -> None: ...

class BatchGetChangesRequest(_message.Message):
    __slots__ = ("change_ids",)
    CHANGE_IDS_FIELD_NUMBER: _ClassVar[int]
    change_ids: _containers.RepeatedScalarFieldContainer[int]
    def __init__(self, change_ids: _Optional[_Iterable[int]] = ...) -> None: ...

class BatchGetChangesResponse(_message.Message):
    __slots__ = ("changes",)
    CHANGES_FIELD_NUMBER: _ClassVar[int]
    changes: _containers.RepeatedCompositeFieldContainer[Change]
    def __init__(self, changes: _Optional[_Iterable[_Union[Change, _Mapping]]] = ...) -> None: ...

class ListChangesRequest(_message.Message):
    __slots__ = ("states", "kind", "market", "page")
    STATES_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    MARKET_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    states: _containers.RepeatedScalarFieldContainer[ChangeState]
    kind: ChangeKind
    market: str
    page: _common_pb2.PageRequest
    def __init__(self, states: _Optional[_Iterable[_Union[ChangeState, str]]] = ..., kind: _Optional[_Union[ChangeKind, str]] = ..., market: _Optional[str] = ..., page: _Optional[_Union[_common_pb2.PageRequest, _Mapping]] = ...) -> None: ...

class ListChangesResponse(_message.Message):
    __slots__ = ("changes", "page")
    CHANGES_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    changes: _containers.RepeatedCompositeFieldContainer[ChangeSummary]
    page: _common_pb2.PageInfo
    def __init__(self, changes: _Optional[_Iterable[_Union[ChangeSummary, _Mapping]]] = ..., page: _Optional[_Union[_common_pb2.PageInfo, _Mapping]] = ...) -> None: ...

class ValidateChangeRequest(_message.Message):
    __slots__ = ("change_id", "version")
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    version: int
    def __init__(self, change_id: _Optional[int] = ..., version: _Optional[int] = ...) -> None: ...

class ValidateChangeResponse(_message.Message):
    __slots__ = ("change", "refusal")
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    change: Change
    refusal: _common_pb2.Refusal
    def __init__(self, change: _Optional[_Union[Change, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class SubmitChangeRequest(_message.Message):
    __slots__ = ("change_id", "version", "author_reason")
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_REASON_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    version: int
    author_reason: str
    def __init__(self, change_id: _Optional[int] = ..., version: _Optional[int] = ..., author_reason: _Optional[str] = ...) -> None: ...

class SubmitChangeResponse(_message.Message):
    __slots__ = ("change", "refusal")
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    change: Change
    refusal: _common_pb2.Refusal
    def __init__(self, change: _Optional[_Union[Change, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class ApproveChangeRequest(_message.Message):
    __slots__ = ("change_id", "version", "content_hash")
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    CONTENT_HASH_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    version: int
    content_hash: bytes
    def __init__(self, change_id: _Optional[int] = ..., version: _Optional[int] = ..., content_hash: _Optional[bytes] = ...) -> None: ...

class ApproveChangeResponse(_message.Message):
    __slots__ = ("change", "refusal")
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    change: Change
    refusal: _common_pb2.Refusal
    def __init__(self, change: _Optional[_Union[Change, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class RejectChangeRequest(_message.Message):
    __slots__ = ("change_id", "version", "reason")
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    version: int
    reason: str
    def __init__(self, change_id: _Optional[int] = ..., version: _Optional[int] = ..., reason: _Optional[str] = ...) -> None: ...

class RejectChangeResponse(_message.Message):
    __slots__ = ("change", "refusal")
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    change: Change
    refusal: _common_pb2.Refusal
    def __init__(self, change: _Optional[_Union[Change, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class ScheduleChangeRequest(_message.Message):
    __slots__ = ("change_id",)
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    def __init__(self, change_id: _Optional[int] = ...) -> None: ...

class ScheduleChangeResponse(_message.Message):
    __slots__ = ("change", "refusal")
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    change: Change
    refusal: _common_pb2.Refusal
    def __init__(self, change: _Optional[_Union[Change, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class CancelChangeRequest(_message.Message):
    __slots__ = ("change_id", "reason")
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    reason: str
    def __init__(self, change_id: _Optional[int] = ..., reason: _Optional[str] = ...) -> None: ...

class CancelChangeResponse(_message.Message):
    __slots__ = ("change", "refusal")
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    change: Change
    refusal: _common_pb2.Refusal
    def __init__(self, change: _Optional[_Union[Change, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class SuspendChangeRequest(_message.Message):
    __slots__ = ("change_id", "reason")
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    change_id: int
    reason: str
    def __init__(self, change_id: _Optional[int] = ..., reason: _Optional[str] = ...) -> None: ...

class SuspendChangeResponse(_message.Message):
    __slots__ = ("change", "refusal")
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    change: Change
    refusal: _common_pb2.Refusal
    def __init__(self, change: _Optional[_Union[Change, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...
