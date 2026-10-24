"""Who calls, and the clock the engine reads.

The gateway authenticates to the engine with the internal token and asserts,
in the call's metadata, who acts: x-actor and x-actor-role. The engine
believes that assertion only as far as it can check it: the person exists
and holds that role (business book §7.4: identities come from the server's
session, never from a field of a request). It does not authenticate people.
In this project the gateway's sessions are a demonstration mode, where a
visitor picks one of the demo's people; that is not authentication, and no
mode of the engine lets a browser grant itself a role.

Public calls (the site's catalog, quotes and the list of people) come with
no person at all.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from commerce.domain.policy import ROLES
from commerce.engine.errors import InvalidArgument, PermissionDenied

# The shape agreed with the gateway for x-request-id and idempotency-key:
# under the 100 characters the audit log keeps for a request id.
TOKEN_SHAPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$")
PERSON = re.compile(r"^[a-z][a-z0-9-]{0,40}$")
PUBLIC_SCOPE = "(public)"


@dataclass(frozen=True)
class Call:
    request_id: str
    actor: str | None = None
    role: str | None = None
    idempotency_key: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.request_id, str) or not TOKEN_SHAPE.match(self.request_id):
            raise InvalidArgument("x-request-id is 8 to 100 letters, digits, dots, colons, dashes or underscores")
        if self.idempotency_key is not None and not TOKEN_SHAPE.match(self.idempotency_key):
            raise InvalidArgument("idempotency-key is 8 to 100 letters, digits, dots, colons, dashes or underscores")
        if (self.actor is None) != (self.role is None):
            raise PermissionDenied("x-actor and x-actor-role come together")
        if self.actor is not None and not PERSON.match(self.actor):
            raise PermissionDenied("x-actor names no person of this platform")
        if self.role is not None and self.role not in ROLES:
            raise PermissionDenied(f"x-actor-role is one of {', '.join(ROLES)}")

    @property
    def scope(self) -> str:
        """Whose idempotency keys these are."""
        return self.actor or PUBLIC_SCOPE


class Clock(Protocol):
    def now(self) -> datetime:
        """The current instant, timezone-aware."""
        ...


class FixedClock:
    """A clock that says what it is told: for tests and for replaying a day."""

    def __init__(self, at: datetime) -> None:
        if at.tzinfo is None:
            raise ValueError("a clock gives instants, with their offset")
        self.at = at.astimezone(UTC)

    def now(self) -> datetime:
        return self.at

    def advance(self, **delta: float) -> None:
        self.at += timedelta(**delta)
