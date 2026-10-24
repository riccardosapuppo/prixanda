// The identifiers the site gives its requests.
//
// A request id is born here, in the browser, for every request: the gateway
// passes it to the engine, and the engine writes it into the audit log with
// whatever the request changed (business book §11.1). An idempotency key
// names one action of the visitor (one quote asked, one subscription
// confirmed): a retry of the same action sends the same key, so the engine
// answers it with what it already decided instead of doing it twice.
//
// Both follow the shape the gateway and the engine accept:
// ^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$.

export const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

/** A new request id: site-<uuid>. */
export function newRequestId(): string {
  return `site-${uuid()}`;
}

/** A new idempotency key for one action of the visitor: site-action-<uuid>. */
export function newIdempotencyKey(): string {
  return `site-action-${uuid()}`;
}
