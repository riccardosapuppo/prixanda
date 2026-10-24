// Token buckets, one per key (a session, an address). Each bucket holds up to
// `capacity` requests and refills at `perSecond`; a request takes one token
// or is refused with how long to wait. The clock is injected, so a test walks
// through a minute without waiting for one. The number of keys is bounded:
// past `maxKeys`, the buckets touched least recently are forgotten, which
// only ever gives a forgotten key a full bucket again.

export type Verdict = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export type BucketOptions = {
  readonly capacity: number;
  readonly perSecond: number;
  readonly maxKeys: number;
  /** Milliseconds, from any origin, never going back. */
  readonly now: () => number;
};

export class TokenBuckets {
  readonly #options: BucketOptions;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(options: BucketOptions) {
    if (options.capacity < 1 || options.perSecond <= 0 || options.maxKeys < 1) throw new Error("a token bucket needs a capacity, a refill rate and room for keys");
    this.#options = options;
  }

  take(key: string): Verdict {
    const { capacity, perSecond, maxKeys, now } = this.#options;
    const at = now();
    const kept = this.#buckets.get(key);
    const tokens = kept === undefined ? capacity : Math.min(capacity, kept.tokens + ((at - kept.at) / 1000) * perSecond);
    // Delete and set again: the map's order is then the order of last use.
    this.#buckets.delete(key);
    if (tokens >= 1) {
      this.#buckets.set(key, { tokens: tokens - 1, at });
      this.#forgetOldest(maxKeys);
      return { allowed: true };
    }
    this.#buckets.set(key, { tokens, at });
    this.#forgetOldest(maxKeys);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / perSecond)) };
  }

  get size(): number {
    return this.#buckets.size;
  }

  #forgetOldest(maxKeys: number): void {
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size <= maxKeys) break;
      this.#buckets.delete(key);
    }
  }
}
