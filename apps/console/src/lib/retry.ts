// When the console reads again after a failed read (TanStack Query's retry).
// A read that got no answer (the gateway or the engine did not reply) is
// tried twice more, after one and two seconds. A read the gateway turned
// away for too many requests (429) is tried again after the wait the gateway
// names in Retry-After, twice at most: the console waits as it is told
// instead of showing an error for a pause of a second. A refusal is never
// tried again, since the same request would be refused the same way.
// Actions (mutations) are not tried again by themselves: the person decides,
// and the action's idempotency key makes a second try replay the first.
import { GatewayError } from "./gateway.ts";

export const MAX_READ_RETRIES = 2;

export function retryRead(failures: number, error: unknown): boolean {
  return error instanceof GatewayError && error.transient && failures < MAX_READ_RETRIES;
}

/** Milliseconds before the next try (failures: those before this one, from 0): the gateway's Retry-After for a 429, otherwise 1 s, then 2 s. */
export function readRetryDelay(failures: number, error: unknown): number {
  if (error instanceof GatewayError && error.code === "RATE_LIMITED" && error.retryAfterSeconds !== null) return error.retryAfterSeconds * 1000;
  return Math.min(1000 * 2 ** failures, 8000);
}
