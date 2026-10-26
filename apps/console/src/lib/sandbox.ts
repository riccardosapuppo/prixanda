// The console in the demo's sandbox (stage 8; docs/business.md §13.3, §14.6).
// Built with SANDBOX=1, the console sends its requests to the sandbox's
// worker instead of the gateway over HTTP: the same internal schema, the
// engine's own Python code and the same migrations, running in this browser
// for every tab of the origin (the site at /, the console at /console/).
// Nothing above the transport changes: the gateway client of gateway.ts
// receives the same results.
//
// The tab's side of the worker is the sandbox's own client (sandbox/client:
// openBackend, the same for the site and the console): it says hello as the
// console, shows the worker's steps while it starts, sends each request to
// the internal API and passes on what the engine's jobs changed and a start
// over. Here: the console's requests as the worker's messages, the demo's
// commands with their answers, and what the console reads again after a
// change.
import { type Backend, BackendFailure, type BackendStatus, droppedConnection, openBackend, type Reply } from "sandbox/client";
import type { Changed, CommandArgs, CommandName, CommandResults } from "sandbox/protocol";
import { GatewayError, type GraphQLResult, type GraphQLTransport } from "./gateway.ts";

/** The demo's worker, as this tab sees it. */
export type Sandbox = Backend;
export type SandboxStatus = BackendStatus;
export { droppedConnection };

/** Built for the demo's sandbox (SANDBOX=1): the requests go to the worker in this browser, not to a gateway. */
export const SANDBOX_MODE: boolean = process.env["CONSOLE_SANDBOX"] === "1";

/** The demo build's fingerprint (SANDBOX_BUILD): a tab whose worker belongs to another build reloads once. */
export const SANDBOX_BUILD: string = process.env["CONSOLE_SANDBOX_BUILD"] || "dev";

/** The origin's worker for the console's tab: the internal API. */
export function openSandbox(build: string): Sandbox {
  return openBackend({ app: "console", build });
}

/**
 * The console's requests as messages to the worker, with the headers the
 * gateway reads over HTTP, and its replies read as httpTransport reads the
 * gateway's answers. A demo that could not start is a gateway that does not
 * answer, said in the demo's words.
 */
export function sandboxTransport(sandbox: Sandbox): GraphQLTransport {
  return {
    async execute(request) {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", "x-request-id": request.requestId };
      if (request.idempotencyKey !== undefined) headers["idempotency-key"] = request.idempotencyKey;
      if (request.csrfToken !== undefined) headers["x-csrf-token"] = request.csrfToken;
      const body = JSON.stringify({ query: request.query, variables: request.variables, operationName: request.operationName });
      let reply: Reply;
      try {
        reply = await sandbox.graphql(headers, body, request.signal);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        const why = error instanceof BackendFailure || error instanceof Error ? error.message : String(error);
        throw new GatewayError("UNREACHABLE", `The demo's engine in this browser did not answer: ${why}.`, request.requestId);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(reply.body);
      } catch {
        throw new GatewayError("BAD_RESPONSE", `The demo's engine answered ${reply.status} without a GraphQL result.`, request.requestId);
      }
      const retryAfter = Number(reply.headers["retry-after"]);
      const result = typeof parsed === "object" && parsed !== null ? (parsed as GraphQLResult) : {};
      return { ...result, status: reply.status, ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}) };
    },
  };
}

/** A command's answer: its result, or the worker's words when it cannot be done now (409) or was malformed (400). */
export async function runCommand<N extends CommandName>(sandbox: Sandbox, name: N, ...args: CommandArgs[N] extends undefined ? [] : [CommandArgs[N]]): Promise<
  { readonly ok: true; readonly result: CommandResults[N] } | { readonly ok: false; readonly status: number; readonly error: string }
> {
  const reply = await sandbox.command(name, ...args);
  let body: unknown = null;
  try {
    body = JSON.parse(reply.body);
  } catch {
    body = null;
  }
  if (reply.status === 200 && body !== null) return { ok: true, result: body as CommandResults[N] };
  const error = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : reply.body;
  return { ok: false, status: reply.status, error };
}

/**
 * What the console reads again after the engine's jobs changed something:
 * the operations whose answers it touches, by name (a query's key starts
 * with its operation's name). The site reads its own (apps/site).
 */
export const READ_AGAIN: Readonly<Record<Changed, readonly string[]>> = {
  catalog: ["PriceList", "Plans", "Markets", "Home", "Week"],
  changes: ["Change", "Changes", "Home", "Week", "Launches"],
  launches: ["LaunchRuns", "LaunchRun", "Launches", "Home", "Change", "Changes"],
  accounts: ["Home"],
  audit: ["AuditEvents"],
};
