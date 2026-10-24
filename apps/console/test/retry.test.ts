// When the console reads again after a failed read: twice more for a read
// with no answer, after the gateway's Retry-After for a 429, never for a
// refusal.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GatewayError } from "../src/lib/gateway.ts";
import { readRetryDelay, retryRead } from "../src/lib/retry.ts";

const error = (code: ConstructorParameters<typeof GatewayError>[0], retryAfterSeconds: number | null = null) => new GatewayError(code, "", "console:test", retryAfterSeconds);

describe("reading again", () => {
  it("waits as the gateway says after too many requests, then tries again, twice at most", () => {
    const limited = error("RATE_LIMITED", 3);
    assert.equal(retryRead(0, limited), true);
    assert.equal(retryRead(1, limited), true);
    assert.equal(retryRead(2, limited), false);
    assert.equal(readRetryDelay(0, limited), 3000);
    assert.equal(readRetryDelay(1, limited), 3000);
  });

  it("tries a read with no answer again after one, then two seconds", () => {
    for (const code of ["UNREACHABLE", "ENGINE_UNAVAILABLE"] as const) {
      assert.equal(retryRead(0, error(code)), true, code);
      assert.equal(retryRead(2, error(code)), false, code);
    }
    assert.equal(readRetryDelay(0, error("UNREACHABLE")), 1000);
    assert.equal(readRetryDelay(1, error("UNREACHABLE")), 2000);
    assert.equal(readRetryDelay(0, error("RATE_LIMITED")), 1000, "a 429 without Retry-After waits like a read with no answer");
  });

  it("never tries a refusal again: the same request would be refused the same way", () => {
    for (const code of ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "BAD_USER_INPUT", "BAD_RESPONSE", "INTERNAL_SERVER_ERROR"] as const) {
      assert.equal(retryRead(0, error(code)), false, code);
    }
    assert.equal(retryRead(0, new Error("not the gateway's")), false);
  });
});
