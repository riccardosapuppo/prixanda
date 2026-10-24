"""Answers and errors.

A refusal is an answer (rule 33: a refusal is not a fault): the author signing
their own version, a stale version, a quote for an offer that ended. It
travels in the response's outcome as a typed Refusal, and when a call has an
idempotency key the refusal is recorded like any other outcome.

An EngineError is not an answer: the call could not be served as asked. The
gRPC layer maps its status to the status code of the same name. Nothing of an
EngineError's internals reaches the caller beyond its message.
"""

from __future__ import annotations

from collections.abc import Mapping


class EngineError(Exception):
    status = "INTERNAL"


class InvalidArgument(EngineError):
    """The call is malformed: a missing field, a text that is not a time, a key of the wrong shape."""

    status = "INVALID_ARGUMENT"


class NotFound(EngineError):
    """An identifier names nothing."""

    status = "NOT_FOUND"


class PermissionDenied(EngineError):
    """The caller is not who may make this call at all."""

    status = "PERMISSION_DENIED"


class FailedPrecondition(EngineError):
    """The data is not in a state the call can be served from (a gap the invariants should have caught)."""

    status = "FAILED_PRECONDITION"


class Aborted(EngineError):
    """A call with the same idempotency key is still running."""

    status = "ABORTED"


class Unavailable(EngineError):
    """The database cannot be reached."""

    status = "UNAVAILABLE"


class Refused(Exception):
    """A business refusal: code is the RefusalCode without its prefix (OWN_VERSION)."""

    def __init__(self, code: str, reason: str, facts: Mapping[str, object] | None = None) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.facts = {k: str(v) for k, v in (facts or {}).items()}
