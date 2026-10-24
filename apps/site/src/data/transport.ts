// How the site's requests reach the public API: a transport carries one
// GraphQL request and brings back what came of it. Pages never fetch on
// their own; they go through the data layer (api.ts), which goes through a
// transport.
//
// Today the transport is HTTP to the gateway's public endpoint
// (httpTransport). In stage 8 the browser sandbox hands the same data layer a
// transport that executes the same schema inside the page: nothing above this
// file changes.

export type GraphqlRequest = {
  readonly operationName: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
  /** What the gateway reads besides the body: X-Request-Id, Idempotency-Key, X-CSRF-Token. */
  readonly headers: Readonly<Record<string, string>>;
};

export type GraphqlError = {
  readonly message: string;
  readonly extensions?: { readonly code?: unknown; readonly requestId?: unknown };
};

export type GraphqlResponse = {
  /** The HTTP status; a transport without HTTP answers 200. */
  readonly status: number;
  readonly data: unknown;
  readonly errors: readonly GraphqlError[];
  /** The request id the answer names (header or extensions); null when it names none. */
  readonly requestId: string | null;
  /** Seconds before asking again, when the API said 429. */
  readonly retryAfter: number | null;
};

export type Transport = {
  send(request: GraphqlRequest, signal?: AbortSignal): Promise<GraphqlResponse>;
};

/** The request never got an answer: the network, a refused origin, a server that is down. */
export class TransportFailure extends Error {
  override readonly name = "TransportFailure";
}

type HttpOptions = {
  /**
   * Whether the browser sends the API's cookies. The site's session (the demo
   * listener it signed in as) lives in an HttpOnly cookie of the API's own,
   * which only "include" sends to the API's origin.
   */
  readonly credentials: RequestCredentials;
  readonly fetch?: typeof fetch;
};

/** The gateway's public endpoint over HTTP: one POST of JSON per request. */
export function httpTransport(endpoint: string, options: HttpOptions): Transport {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  return {
    async send(request, signal) {
      let response: Response;
      try {
        response = await send(endpoint, {
          method: "POST",
          credentials: options.credentials,
          cache: "no-store",
          headers: { "content-type": "application/json", accept: "application/graphql-response+json, application/json", ...request.headers },
          body: JSON.stringify({ operationName: request.operationName, query: request.query, variables: request.variables }),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new TransportFailure(error instanceof Error ? error.message : String(error));
      }
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const record = isRecord(body) ? body : {};
      const extensions = isRecord(record["extensions"]) ? record["extensions"] : {};
      const errors = Array.isArray(record["errors"]) ? record["errors"].filter(isGraphqlError) : [];
      const fromExtensions = typeof extensions["requestId"] === "string" ? extensions["requestId"] : null;
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        status: response.status,
        data: "data" in record ? record["data"] : null,
        errors,
        requestId: response.headers.get("x-request-id") ?? fromExtensions,
        retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGraphqlError(value: unknown): value is GraphqlError {
  return isRecord(value) && typeof value["message"] === "string";
}
