// The site's API: the operations of src/graphql, sent through a transport,
// with the headers the gateway reads and its errors turned into one kind of
// error the pages can explain.
//
// - Every request carries a new X-Request-Id, born here (§11.1).
// - A mutation that changes something carries the Idempotency-Key of the
//   visitor's action; the caller makes one per action and sends the same one
//   again when it retries that action.
// - With a session, a mutation carries its CSRF token in X-CSRF-Token.
// - A business refusal ("this offer is not for you") is not an error: it comes
//   back as data, typed, in the operation's result. An ApiError is everything
//   else: the API unreachable, the engine down, a malformed request.
import type { SiteOperation } from "../graphql/generated.ts";
import { newRequestId } from "./ids.ts";
import { type GraphqlResponse, type Transport, TransportFailure } from "./transport.ts";

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_USER_INPUT"
  | "ENGINE_UNAVAILABLE"
  | "RATE_LIMITED"
  | "UNREACHABLE"
  | "INTERNAL";

const CODES: readonly ApiErrorCode[] = ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "BAD_USER_INPUT", "ENGINE_UNAVAILABLE"];

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: ApiErrorCode;
  /** The request's id, to find it in the gateway's log and the audit log. */
  readonly requestId: string;
  /** Seconds before asking again, when the API said so. */
  readonly retryAfter: number | null;

  constructor(code: ApiErrorCode, message: string, requestId: string, retryAfter: number | null = null) {
    super(message);
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }

  /** Worth asking again later: the API or the engine did not answer, or asked to slow down. */
  get transient(): boolean {
    return this.code === "UNREACHABLE" || this.code === "ENGINE_UNAVAILABLE" || this.code === "RATE_LIMITED";
  }
}

export type SiteApi = {
  query<Result, Variables>(operation: SiteOperation<Result, Variables, "query">, variables: Variables, signal?: AbortSignal): Promise<Result>;
  /**
   * idempotencyKey: the key of the visitor's action; null only for the
   * mutations that need none (signing in and out of the demo).
   */
  mutate<Result, Variables>(
    operation: SiteOperation<Result, Variables, "mutation">,
    variables: Variables,
    action: { readonly idempotencyKey: string | null },
  ): Promise<Result>;
};

export type SessionHeaders = {
  /** The CSRF token of the site's session, or null without one. */
  csrfToken(): string | null;
};

const NO_SESSION: SessionHeaders = { csrfToken: () => null };

export function createSiteApi(transport: Transport, session: SessionHeaders = NO_SESSION): SiteApi {
  async function send(
    operation: { readonly kind: "query" | "mutation"; readonly name: string; readonly text: string },
    variables: unknown,
    extra: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const requestId = newRequestId();
    const headers: Record<string, string> = { "X-Request-Id": requestId, ...extra };
    let response: GraphqlResponse;
    try {
      response = await transport.send({
        operationName: operation.name,
        query: operation.text,
        variables: (variables ?? {}) as Record<string, unknown>,
        headers,
      }, signal);
    } catch (error) {
      if (error instanceof TransportFailure) throw new ApiError("UNREACHABLE", error.message, requestId);
      throw error;
    }
    const answeredAs = response.requestId ?? requestId;
    if (response.status === 429) {
      throw new ApiError("RATE_LIMITED", "Too many requests from this browser for now.", answeredAs, response.retryAfter);
    }
    const [first] = response.errors;
    if (first) {
      const code = typeof first.extensions?.code === "string" && (CODES as readonly string[]).includes(first.extensions.code)
        ? first.extensions.code as ApiErrorCode
        : "INTERNAL";
      throw new ApiError(code, first.message, answeredAs);
    }
    if (response.status >= 400 || response.data === null || response.data === undefined) {
      throw new ApiError("INTERNAL", `The API answered ${response.status} without data.`, answeredAs);
    }
    return response.data;
  }

  return {
    async query<Result, Variables>(operation: SiteOperation<Result, Variables, "query">, variables: Variables, signal?: AbortSignal) {
      // The operation's text was validated against the schema when its types were generated.
      return (await send(operation, variables, {}, signal)) as Result;
    },
    async mutate<Result, Variables>(
      operation: SiteOperation<Result, Variables, "mutation">,
      variables: Variables,
      action: { readonly idempotencyKey: string | null },
    ) {
      const extra: Record<string, string> = {};
      if (action.idempotencyKey !== null) extra["Idempotency-Key"] = action.idempotencyKey;
      const csrf = session.csrfToken();
      if (csrf !== null) extra["X-CSRF-Token"] = csrf;
      return (await send(operation, variables, extra)) as Result;
    },
  };
}
