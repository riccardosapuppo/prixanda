"""The engine's configuration, from the environment. The two secrets (the
database URL with its password, and the internal token) are read from the
environment only and never written to a log."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

TOKEN_MIN = 32


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Config:
    database_url: str
    token: str
    host: str = "127.0.0.1"
    port: int = 4611
    pool_size: int = 10
    activation_interval: float = 5.0  # seconds; 0 switches the timer off
    health_interval: float = 5.0
    shutdown_grace: float = 10.0
    stop_on_stdin_close: bool = False

    @property
    def address(self) -> str:
        return f"{self.host}:{self.port}"

    def database_for_logs(self) -> str:
        parts = urlsplit(self.database_url)
        host = parts.hostname or ""
        where = f"{host}:{parts.port}" if parts.port else host
        return urlunsplit((parts.scheme, f"{parts.username or ''}@{where}", parts.path, "", ""))


def _number(env: Mapping[str, str], name: str, default: float, low: float, high: float) -> float:
    text = env.get(name)
    if text is None or text == "":
        return default
    try:
        value = float(text)
    except ValueError as error:
        raise ConfigError(f"{name} is a number, not {text!r}") from error
    if not low <= value <= high:
        raise ConfigError(f"{name} is between {low:g} and {high:g}")
    return value


def from_env(env: Mapping[str, str]) -> Config:
    url = env.get("COMMERCE_DATABASE_URL", "")
    if not url.startswith(("postgresql://", "postgres://")):
        raise ConfigError("COMMERCE_DATABASE_URL is the engine's PostgreSQL URL (postgresql://...)")
    token = env.get("COMMERCE_INTERNAL_TOKEN", "")
    if len(token) < TOKEN_MIN or not re.fullmatch(r"[\x21-\x7e]+", token):
        raise ConfigError(f"COMMERCE_INTERNAL_TOKEN is the gateway's internal token: at least {TOKEN_MIN} visible characters")
    host = env.get("COMMERCE_ENGINE_HOST", "127.0.0.1")
    if not re.fullmatch(r"[A-Za-z0-9.:\[\]-]+", host):
        raise ConfigError("COMMERCE_ENGINE_HOST is a host name or an address")
    return Config(
        database_url=url, token=token, host=host,
        port=int(_number(env, "COMMERCE_ENGINE_PORT", 4611, 1, 65_535)),
        pool_size=int(_number(env, "COMMERCE_DB_POOL_SIZE", 10, 1, 100)),
        activation_interval=_number(env, "COMMERCE_ACTIVATION_INTERVAL_SECONDS", 5, 0, 3_600),
        health_interval=_number(env, "COMMERCE_HEALTH_INTERVAL_SECONDS", 5, 0.1, 3_600),
        shutdown_grace=_number(env, "COMMERCE_SHUTDOWN_GRACE_SECONDS", 10, 0, 300),
        stop_on_stdin_close=env.get("COMMERCE_STOP_ON_STDIN_CLOSE", "") == "1",
    )
