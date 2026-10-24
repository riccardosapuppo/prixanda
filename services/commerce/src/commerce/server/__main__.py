"""python -m commerce.server: the engine, configured from the environment.

  COMMERCE_DATABASE_URL                 the engine's PostgreSQL URL (a secret: it holds the password)
  COMMERCE_INTERNAL_TOKEN               the token the gateway sends (a secret, at least 32 characters)
  COMMERCE_ENGINE_HOST, _PORT           where to listen: 127.0.0.1 and 4611 unless set
  COMMERCE_DB_POOL_SIZE                 connections to the database, 10 unless set
  COMMERCE_ACTIVATION_INTERVAL_SECONDS  how often the engine's jobs run (launches, the outbox, the end of offers,
                                        the pruning of idempotency keys), 5 unless set; 0 is off
  COMMERCE_HEALTH_INTERVAL_SECONDS      how often health asks the database, 5 unless set
  COMMERCE_SHUTDOWN_GRACE_SECONDS       how long running calls may finish when it stops, 10 unless set
  COMMERCE_STOP_ON_STDIN_CLOSE=1        stop when standard input closes (for a supervisor)

Exits 0 after an orderly stop, 1 when it could not serve, 2 on a configuration error.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from commerce.server.app import serve
from commerce.server.config import ConfigError, from_env


def main() -> int:
    try:
        config = from_env(os.environ)
    except ConfigError as error:
        sys.stderr.write(json.dumps({"level": "error", "event": "configuration", "error": str(error)}) + "\n")
        return 2
    return asyncio.run(serve(config))


if __name__ == "__main__":
    sys.exit(main())
