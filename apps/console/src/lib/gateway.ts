// How the console talks to its API, in two layers.
//
// A transport carries one GraphQL request and brings back its result. It is
// the only part that knows where the schema runs: today httpTransport() posts
// to the gateway's internal endpoint; in stage 8 another transport hands the
// same request to the schema running in the page. Both receive the same
// request: the operation's text, its variables, and the three things the
// gateway reads from headers (the request id, the idempotency key of an
// action, the session's CSRF token).
//
// The gateway client on top turns a result into data or into a GatewayError
// with the gateway's code. A business refusal is not an error: it comes back
// as data (the mutation's Refusal), and the screen that asked shows it.
import type { Operation } from "../graphql/operation.ts";

export type GraphQLRequest = {
  readonly operationName: string;
  readonly query: string;
  readonly variables: unknown;
  /** Born here, in the console; the gateway passes it to the engine, which writes it in the audit log (§11.1). */
  readonly requestId: string;
  /** One per action, the same one when the action is retried. Mutations only. */
  readonly idempotencyKey?: string;
  readonly csrfToken?: string;
  readonly signal?: AbortSignal;
};

export type GraphQLErrorShape = { readonly message: string; readonly extensions?: { readonly code?: string } };

export type GraphQLResult = {
  readonly data?: unknown;
  readonly errors?: readonly GraphQLErrorShape[];
  readonly extensions?: { readonly requestId?: string };
  /** HTTP's status when the transport has one. */
  readonly status?: number;
  /** Seconds to wait, when the gateway asked for it (429). */
  readonly retryAfterSeconds?: number;
};

export interface GraphQLTransport {
  execute(request: GraphQLRequest): Promise<GraphQLResult>;
}

/** The codes of the gateway's errors (its README), and two of the console's own: the gateway could not be reached, or answered nonsense. */
export type GatewayErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "BAD_USER_INPUT" | "ENGINE_UNAVAILABLE" | "RATE_LIMITED"
  | "INTERNAL_SERVER_ERROR" | "UNREACHABLE" | "BAD_RESPONSE";

const KNOWN_CODES = new Set<string>([
  "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "BAD_USER_INPUT", "ENGINE_UNAVAILABLE", "RATE_LIMITED", "INTERNAL_SERVER_ERROR",
]);

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly requestId: string;
  readonly retryAfterSeconds: number | null;

  constructor(code: GatewayErrorCode, message: string, requestId: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** Whether trying again, as it is, can help: the request did not reach a decision. */
  get transient(): boolean {
    return this.code === "UNREACHABLE" || this.code === "ENGINE_UNAVAILABLE" || this.code === "RATE_LIMITED";
  }
}

/** The transport of today: the gateway's internal endpoint over HTTP, with the session cookie. */
export function httpTransport(url: string, fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): GraphQLTransport {
  return {
    async execute(request) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        "x-request-id": request.requestId,
      };
      if (request.idempotencyKey !== undefined) headers["idempotency-key"] = request.idempotencyKey;
      if (request.csrfToken !== undefined) headers["x-csrf-token"] = request.csrfToken;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ query: request.query, variables: request.variables, operationName: request.operationName }),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        throw new GatewayError("UNREACHABLE", `The gateway at ${url} did not answer.`, request.requestId);
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new GatewayError("BAD_RESPONSE", `The gateway answered ${response.status} without a GraphQL result.`, request.requestId);
      }
      const result = typeof body === "object" && body !== null ? (body as GraphQLResult) : {};
      return {
        ...result,
        status: response.status,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      };
    },
  };
}

export type GatewayClient = {
  /** Runs an operation and returns its data, or throws a GatewayError. */
  run<TData, TVariables>(operation: Operation<TData, TVariables>, variables: TVariables, options?: RunOptions): Promise<TData>;
};

export type RunOptions = { readonly idempotencyKey?: string; readonly signal?: AbortSignal };

export function createGatewayClient(options: {
  readonly transport: GraphQLTransport;
  /** The session's CSRF token, when there is a session. */
  readonly csrfToken: () => string | null;
  readonly newRequestId: () => string;
}): GatewayClient {
  return {
    async run(operation, variables, runOptions = {}) {
      if (operation.kind === "mutation" && runOptions.idempotencyKey === undefined && operation.name !== "SignIn" && operation.name !== "SignOut") {
        // Every mutation that changes something in the engine carries a key
        // (the gateway refuses it otherwise); signing in and out do not reach the engine's writes.
        throw new Error(`${operation.name} changes something: give it the action's idempotency key`);
      }
      const requestId = options.newRequestId();
      const csrf = options.csrfToken();
      const result = await options.transport.execute({
        operationName: operation.name,
        query: operation.text,
        variables: variables ?? {},
        requestId,
        ...(runOptions.idempotencyKey !== undefined ? { idempotencyKey: runOptions.idempotencyKey } : {}),
        ...(csrf !== null && operation.kind === "mutation" ? { csrfToken: csrf } : {}),
        ...(runOptions.signal ? { signal: runOptions.signal } : {}),
      });
      const answeredId = result.extensions?.requestId ?? requestId;
      const first = result.errors?.[0];
      if (first !== undefined) {
        const code = first.extensions?.code ?? "";
        throw new GatewayError(
          KNOWN_CODES.has(code) ? (code as GatewayErrorCode) : result.status === 429 ? "RATE_LIMITED" : "INTERNAL_SERVER_ERROR",
          first.message,
          answeredId,
          result.retryAfterSeconds ?? null,
        );
      }
      if (result.data === undefined || result.data === null) {
        throw new GatewayError("BAD_RESPONSE", `The gateway answered ${operation.name} without data.`, answeredId);
      }
      return result.data as never;
    },
  };
}

/** What a person reads when a request failed: what happened, and what to do. */
export function explain(error: unknown): { title: string; detail: string; requestId: string | null } {
  if (!(error instanceof GatewayError)) {
    return { title: "Something went wrong in the console.", detail: error instanceof Error ? error.message : String(error), requestId: null };
  }
  const requestId = error.requestId;
  switch (error.code) {
    case "UNREACHABLE":
      return { title: "The gateway is not answering.", detail: "Check that it is running, then try again.", requestId };
    case "ENGINE_UNAVAILABLE":
      return { title: "The engine is not answering.", detail: "The gateway is up but the engine did not reply in time. Try again in a moment.", requestId };
    case "RATE_LIMITED":
      return {
        title: "Too many requests from this session.",
        detail: `Wait ${error.retryAfterSeconds ?? "a few"} seconds, then try again.`,
        requestId,
      };
    case "UNAUTHENTICATED":
      return { title: "The demo session has ended.", detail: "Choose a person again to carry on.", requestId };
    case "FORBIDDEN":
      return { title: "This role cannot read this.", detail: error.message, requestId };
    case "NOT_FOUND":
      return { title: "Not found.", detail: error.message, requestId };
    case "BAD_USER_INPUT":
      return { title: "The gateway refused the request as malformed.", detail: error.message, requestId };
    case "BAD_RESPONSE":
      return { title: "The gateway's answer could not be read.", detail: error.message, requestId };
    default:
      return { title: "The gateway failed on this request.", detail: error.message, requestId };
  }
}
