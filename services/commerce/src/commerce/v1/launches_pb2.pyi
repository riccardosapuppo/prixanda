from commerce.v1 import changes_pb2 as _changes_pb2
from commerce.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class LaunchState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LAUNCH_STATE_UNSPECIFIED: _ClassVar[LaunchState]
    LAUNCH_STATE_RUNNING: _ClassVar[LaunchState]
    LAUNCH_STATE_DONE: _ClassVar[LaunchState]
    LAUNCH_STATE_FAILED: _ClassVar[LaunchState]
    LAUNCH_STATE_REFUSED: _ClassVar[LaunchState]
    LAUNCH_STATE_CANCELLED: _ClassVar[LaunchState]

class LaunchStepState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LAUNCH_STEP_STATE_UNSPECIFIED: _ClassVar[LaunchStepState]
    LAUNCH_STEP_STATE_PENDING: _ClassVar[LaunchStepState]
    LAUNCH_STEP_STATE_RUNNING: _ClassVar[LaunchStepState]
    LAUNCH_STEP_STATE_DONE: _ClassVar[LaunchStepState]
    LAUNCH_STEP_STATE_FAILED: _ClassVar[LaunchStepState]
LAUNCH_STATE_UNSPECIFIED: LaunchState
LAUNCH_STATE_RUNNING: LaunchState
LAUNCH_STATE_DONE: LaunchState
LAUNCH_STATE_FAILED: LaunchState
LAUNCH_STATE_REFUSED: LaunchState
LAUNCH_STATE_CANCELLED: LaunchState
LAUNCH_STEP_STATE_UNSPECIFIED: LaunchStepState
LAUNCH_STEP_STATE_PENDING: LaunchStepState
LAUNCH_STEP_STATE_RUNNING: LaunchStepState
LAUNCH_STEP_STATE_DONE: LaunchStepState
LAUNCH_STEP_STATE_FAILED: LaunchStepState

class LaunchStep(_message.Message):
    __slots__ = ("name", "purpose", "state", "started_at", "finished_at", "attempts", "error", "facts")
    class FactsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    NAME_FIELD_NUMBER: _ClassVar[int]
    PURPOSE_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    FINISHED_AT_FIELD_NUMBER: _ClassVar[int]
    ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    FACTS_FIELD_NUMBER: _ClassVar[int]
    name: str
    purpose: str
    state: LaunchStepState
    started_at: str
    finished_at: str
    attempts: int
    error: str
    facts: _containers.ScalarMap[str, str]
    def __init__(self, name: _Optional[str] = ..., purpose: _Optional[str] = ..., state: _Optional[_Union[LaunchStepState, str]] = ..., started_at: _Optional[str] = ..., finished_at: _Optional[str] = ..., attempts: _Optional[int] = ..., error: _Optional[str] = ..., facts: _Optional[_Mapping[str, str]] = ...) -> None: ...

class LaunchIncident(_message.Message):
    __slots__ = ("incident_id", "kind", "state", "summary", "opened_at", "closed_at", "resolution")
    INCIDENT_ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    OPENED_AT_FIELD_NUMBER: _ClassVar[int]
    CLOSED_AT_FIELD_NUMBER: _ClassVar[int]
    RESOLUTION_FIELD_NUMBER: _ClassVar[int]
    incident_id: int
    kind: str
    state: str
    summary: str
    opened_at: str
    closed_at: str
    resolution: str
    def __init__(self, incident_id: _Optional[int] = ..., kind: _Optional[str] = ..., state: _Optional[str] = ..., summary: _Optional[str] = ..., opened_at: _Optional[str] = ..., closed_at: _Optional[str] = ..., resolution: _Optional[str] = ...) -> None: ...

class LaunchRun(_message.Message):
    __slots__ = ("launch_id", "change_id", "title", "kind", "version", "state", "starts", "due_at", "started_at", "finished_at", "current_step", "attempts", "cause", "retry_at", "snapshot_before", "snapshot_after", "resolution", "run", "steps", "audit_events", "incidents")
    LAUNCH_ID_FIELD_NUMBER: _ClassVar[int]
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    STARTS_FIELD_NUMBER: _ClassVar[int]
    DUE_AT_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    FINISHED_AT_FIELD_NUMBER: _ClassVar[int]
    CURRENT_STEP_FIELD_NUMBER: _ClassVar[int]
    ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    CAUSE_FIELD_NUMBER: _ClassVar[int]
    RETRY_AT_FIELD_NUMBER: _ClassVar[int]
    SNAPSHOT_BEFORE_FIELD_NUMBER: _ClassVar[int]
    SNAPSHOT_AFTER_FIELD_NUMBER: _ClassVar[int]
    RESOLUTION_FIELD_NUMBER: _ClassVar[int]
    RUN_FIELD_NUMBER: _ClassVar[int]
    STEPS_FIELD_NUMBER: _ClassVar[int]
    AUDIT_EVENTS_FIELD_NUMBER: _ClassVar[int]
    INCIDENTS_FIELD_NUMBER: _ClassVar[int]
    launch_id: int
    change_id: int
    title: str
    kind: _changes_pb2.ChangeKind
    version: int
    state: LaunchState
    starts: _common_pb2.LocalTime
    due_at: str
    started_at: str
    finished_at: str
    current_step: str
    attempts: int
    cause: str
    retry_at: str
    snapshot_before: int
    snapshot_after: int
    resolution: str
    run: str
    steps: _containers.RepeatedCompositeFieldContainer[LaunchStep]
    audit_events: _containers.RepeatedScalarFieldContainer[int]
    incidents: _containers.RepeatedCompositeFieldContainer[LaunchIncident]
    def __init__(self, launch_id: _Optional[int] = ..., change_id: _Optional[int] = ..., title: _Optional[str] = ..., kind: _Optional[_Union[_changes_pb2.ChangeKind, str]] = ..., version: _Optional[int] = ..., state: _Optional[_Union[LaunchState, str]] = ..., starts: _Optional[_Union[_common_pb2.LocalTime, _Mapping]] = ..., due_at: _Optional[str] = ..., started_at: _Optional[str] = ..., finished_at: _Optional[str] = ..., current_step: _Optional[str] = ..., attempts: _Optional[int] = ..., cause: _Optional[str] = ..., retry_at: _Optional[str] = ..., snapshot_before: _Optional[int] = ..., snapshot_after: _Optional[int] = ..., resolution: _Optional[str] = ..., run: _Optional[str] = ..., steps: _Optional[_Iterable[_Union[LaunchStep, _Mapping]]] = ..., audit_events: _Optional[_Iterable[int]] = ..., incidents: _Optional[_Iterable[_Union[LaunchIncident, _Mapping]]] = ...) -> None: ...

class ListLaunchesRequest(_message.Message):
    __slots__ = ("state", "change_id", "page")
    STATE_FIELD_NUMBER: _ClassVar[int]
    CHANGE_ID_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    state: LaunchState
    change_id: int
    page: _common_pb2.PageRequest
    def __init__(self, state: _Optional[_Union[LaunchState, str]] = ..., change_id: _Optional[int] = ..., page: _Optional[_Union[_common_pb2.PageRequest, _Mapping]] = ...) -> None: ...

class ListLaunchesResponse(_message.Message):
    __slots__ = ("launches", "page")
    LAUNCHES_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    launches: _containers.RepeatedCompositeFieldContainer[LaunchRun]
    page: _common_pb2.PageInfo
    def __init__(self, launches: _Optional[_Iterable[_Union[LaunchRun, _Mapping]]] = ..., page: _Optional[_Union[_common_pb2.PageInfo, _Mapping]] = ...) -> None: ...

class GetLaunchRequest(_message.Message):
    __slots__ = ("launch_id",)
    LAUNCH_ID_FIELD_NUMBER: _ClassVar[int]
    launch_id: int
    def __init__(self, launch_id: _Optional[int] = ...) -> None: ...

class GetLaunchResponse(_message.Message):
    __slots__ = ("launch",)
    LAUNCH_FIELD_NUMBER: _ClassVar[int]
    launch: LaunchRun
    def __init__(self, launch: _Optional[_Union[LaunchRun, _Mapping]] = ...) -> None: ...

class RetryLaunchRequest(_message.Message):
    __slots__ = ("launch_id", "reason")
    LAUNCH_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    launch_id: int
    reason: str
    def __init__(self, launch_id: _Optional[int] = ..., reason: _Optional[str] = ...) -> None: ...

class RetryLaunchResponse(_message.Message):
    __slots__ = ("launch", "refusal")
    LAUNCH_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    launch: LaunchRun
    refusal: _common_pb2.Refusal
    def __init__(self, launch: _Optional[_Union[LaunchRun, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...

class CancelLaunchRequest(_message.Message):
    __slots__ = ("launch_id", "reason")
    LAUNCH_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    launch_id: int
    reason: str
    def __init__(self, launch_id: _Optional[int] = ..., reason: _Optional[str] = ...) -> None: ...

class CancelLaunchResponse(_message.Message):
    __slots__ = ("launch", "refusal")
    LAUNCH_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    launch: LaunchRun
    refusal: _common_pb2.Refusal
    def __init__(self, launch: _Optional[_Union[LaunchRun, _Mapping]] = ..., refusal: _Optional[_Union[_common_pb2.Refusal, _Mapping]] = ...) -> None: ...
