// The worker's downloads, tried again when the network drops them (stage 9).
// The demo's host is far from most of its visitors, and a start fetches some
// twenty files, the largest several megabytes: a connection that dropped
// during one of them stopped the demo with fetch's "Failed to fetch". Here a
// GET that failed before any answer came (fetch's TypeError) is tried again,
// after a pause that grows; an answer, even an error status, comes back as it
// came, and a request that was aborted on purpose is not tried again.
// backend.ts puts it in place of the worker's fetch, which Pyodide and PGlite
// call for their files.

export type RetryOptions = {
  /** Tries in all, the first included. */
  readonly attempts?: number;
  /** The pause before the second try; each later pause adds as much again. */
  readonly pauseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export function retryingFetch(plain: typeof fetch, options: RetryOptions = {}): typeof fetch {
  const attempts = options.attempts ?? 3;
  const pauseMs = options.pauseMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (input, init) => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await plain(input, init);
      } catch (error) {
        const aborted = init?.signal?.aborted === true || request?.signal.aborted === true;
        if (attempt >= attempts || method !== "GET" || aborted || !(error instanceof TypeError)) throw error;
        await sleep(pauseMs * attempt);
      }
    }
  };
}
