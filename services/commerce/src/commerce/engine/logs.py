"""One JSON line per event, with the request identifier when there is one,
so that a call can be followed from the site through the gateway to the
engine and the audit log. ASCII only, so that any console prints it."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from datetime import datetime
from typing import Any, TextIO

from commerce.domain.localtime import format_instant


class JsonLog:
    def __init__(self, now: Callable[[], datetime], stream: TextIO | None = None) -> None:
        self._now = now
        self._stream = stream

    def __call__(self, level: str, event: str, **fields: Any) -> None:
        line = {"at": format_instant(self._now()), "level": level, "event": event,
                **{k: v for k, v in fields.items() if v is not None}}
        stream = self._stream or sys.stderr
        stream.write(json.dumps(line, ensure_ascii=True, default=str) + "\n")
        stream.flush()
