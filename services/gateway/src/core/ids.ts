// Identifiers that travel with a request (convention 5 of proto/README.md):
// the request id, born in the site or the console and carried through the
// gateway and the engine to the audit log (§11.1), and the idempotency key of
// a mutation. Both have the same shape, which stays under the 100 characters
// of audit_event.request_id; the engine refuses anything else as malformed.

export const TOKEN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;

/** The client's request id when it is well formed, otherwise a new one: the engine never sees a malformed id. */
export function requestIdFrom(header: string | null | undefined, newId: () => string): { id: string; fromClient: boolean } {
  if (header !== null && header !== undefined && TOKEN_SHAPE.test(header)) return { id: header, fromClient: true };
  return { id: newId(), fromClient: false };
}

/**
 * The idempotency key of a mutation. A missing key is not invented: a key the
 * gateway made up would differ on the retry it exists for. A malformed one is
 * refused instead of being passed on.
 */
export function idempotencyKeyFrom(header: string | null | undefined): { key: string | null; malformed: boolean } {
  if (header === null || header === undefined || header === "") return { key: null, malformed: false };
  return TOKEN_SHAPE.test(header) ? { key: header, malformed: false } : { key: null, malformed: true };
}

const POSITIVE_ID = /^[1-9][0-9]{0,18}$/;
const INT64_MAX = 2n ** 63n - 1n;

/** An id as the contract writes it (a positive int64, as a string), or null when it is not one. */
export function positiveId(value: string): string | null {
  return POSITIVE_ID.test(value) && BigInt(value) <= INT64_MAX ? value : null;
}
