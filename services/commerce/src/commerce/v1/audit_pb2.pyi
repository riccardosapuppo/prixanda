from commerce.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class AuditEvent(_message.Message):
    __slots__ = ("seq", "at", "actor", "actor_role", "action", "subject", "request_id", "reason", "body_json", "prev_hash", "hash")
    SEQ_FIELD_NUMBER: _ClassVar[int]
    AT_FIELD_NUMBER: _ClassVar[int]
    ACTOR_FIELD_NUMBER: _ClassVar[int]
    ACTOR_ROLE_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    SUBJECT_FIELD_NUMBER: _ClassVar[int]
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    BODY_JSON_FIELD_NUMBER: _ClassVar[int]
    PREV_HASH_FIELD_NUMBER: _ClassVar[int]
    HASH_FIELD_NUMBER: _ClassVar[int]
    seq: int
    at: str
    actor: str
    actor_role: str
    action: str
    subject: str
    request_id: str
    reason: str
    body_json: str
    prev_hash: bytes
    hash: bytes
    def __init__(self, seq: _Optional[int] = ..., at: _Optional[str] = ..., actor: _Optional[str] = ..., actor_role: _Optional[str] = ..., action: _Optional[str] = ..., subject: _Optional[str] = ..., request_id: _Optional[str] = ..., reason: _Optional[str] = ..., body_json: _Optional[str] = ..., prev_hash: _Optional[bytes] = ..., hash: _Optional[bytes] = ...) -> None: ...

class ListEventsRequest(_message.Message):
    __slots__ = ("actor", "action", "subject", "page")
    ACTOR_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    SUBJECT_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    actor: str
    action: str
    subject: str
    page: _common_pb2.PageRequest
    def __init__(self, actor: _Optional[str] = ..., action: _Optional[str] = ..., subject: _Optional[str] = ..., page: _Optional[_Union[_common_pb2.PageRequest, _Mapping]] = ...) -> None: ...

class ListEventsResponse(_message.Message):
    __slots__ = ("events", "page")
    EVENTS_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    events: _containers.RepeatedCompositeFieldContainer[AuditEvent]
    page: _common_pb2.PageInfo
    def __init__(self, events: _Optional[_Iterable[_Union[AuditEvent, _Mapping]]] = ..., page: _Optional[_Union[_common_pb2.PageInfo, _Mapping]] = ...) -> None: ...

class ChainHead(_message.Message):
    __slots__ = ("seq", "hash")
    SEQ_FIELD_NUMBER: _ClassVar[int]
    HASH_FIELD_NUMBER: _ClassVar[int]
    seq: int
    hash: bytes
    def __init__(self, seq: _Optional[int] = ..., hash: _Optional[bytes] = ...) -> None: ...

class VerifyChainRequest(_message.Message):
    __slots__ = ("anchor",)
    ANCHOR_FIELD_NUMBER: _ClassVar[int]
    anchor: ChainHead
    def __init__(self, anchor: _Optional[_Union[ChainHead, _Mapping]] = ...) -> None: ...

class VerifyChainResponse(_message.Message):
    __slots__ = ("ok", "events", "head", "broken_at", "why")
    OK_FIELD_NUMBER: _ClassVar[int]
    EVENTS_FIELD_NUMBER: _ClassVar[int]
    HEAD_FIELD_NUMBER: _ClassVar[int]
    BROKEN_AT_FIELD_NUMBER: _ClassVar[int]
    WHY_FIELD_NUMBER: _ClassVar[int]
    ok: bool
    events: int
    head: ChainHead
    broken_at: int
    why: str
    def __init__(self, ok: bool = ..., events: _Optional[int] = ..., head: _Optional[_Union[ChainHead, _Mapping]] = ..., broken_at: _Optional[int] = ..., why: _Optional[str] = ...) -> None: ...

class ExportHeadRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ExportHeadResponse(_message.Message):
    __slots__ = ("head", "refusal")
    HEAD_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    head: ChainHead
    refusal: _common_pb2.Refusal
    def __init__(self, head: _Optional[_Union[ChainHead, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...
