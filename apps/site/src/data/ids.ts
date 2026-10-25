// The identifiers the site gives its requests.
//
// A request id is born here, in the browser, for every request: the gateway
// passes it to the engine, and the engine writes it into the audit log with
// whatever the request changed (business book §11.1). An idempotency key
// names one action of the visitor (one quote asked, one subscription
// confirmed): a retry of the same action sends the same key, so the engine
// answers it with what it already decided instead of doing it twice. An
// action ends with a definitive answer, success or refusal: trying again
// after it is a new action, with a new key (ActionKeys).
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

/**
 * The idempotency keys of what a visitor may send more than once, one per
 * thing sent (a code typed, an answer given). A key goes again only to retry
 * an attempt whose outcome is unknown: the request failed on its way, or the
 * API answered with an error. A definitive answer, success or refusal, ends
 * its key, and the next attempt takes a new one: the engine keeps each key's
 * answer and gives it back to the same key, so a code refused while its
 * payment was pending would be refused again, under that key, once the
 * payment settled.
 */
export class ActionKeys<Sent> {
  readonly #keys = new Map<Sent, string>();
  readonly #make: () => string;

  constructor(make: () => string = newIdempotencyKey) {
    this.#make = make;
  }

  /** The key to send now: the one of an attempt whose outcome is unknown, or a new one. */
  key(sent: Sent): string {
    const held = this.#keys.get(sent);
    if (held !== undefined) return held;
    const fresh = this.#make();
    this.#keys.set(sent, fresh);
    return fresh;
  }

  /** A definitive answer came for it, success or refusal: its key is spent. */
  answered(sent: Sent): void {
    this.#keys.delete(sent);
  }
}
