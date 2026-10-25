// The gateway in the browser (stage 8): the shell beside src/node/ that the
// sandbox's worker runs, with the same core, schemas, limits, errors and
// demonstration sessions. A request comes as the HTTP shell would get it at
// POST /graphql, its headers and its JSON body, and goes back with the status,
// headers and body the HTTP shell would send; what both shells do with it once
// it is theirs is src/shell/graphql.ts. In order, for each request:
//   1. the request id: the tab's when well formed, a new one otherwise;
//   2. the body: JSON of 64 KiB at most; the Idempotency-Key header checked
//      for its shape;
//   3. the session from the API's jar, which the worker keeps as a browser
//      keeps an origin's cookies, and the CSRF token every mutation must carry
//      while a session exists;
//   4. Apollo.
// What HTTP alone needs stays on Node: no Origin to check, the tabs being of
// the demo's own origin; no cookies, the jar being the worker's; no limits per
// client address, every request being the browser's own. The engine is the one
// in the page, behind the EngineClient the worker gives (packages/sandbox).
import { buildInternalSchema, buildPublicSchema } from "../core/schemas.ts";
import {
  createInternalContext, createPublicContext, type InternalContext, type Listener, type PublicContext, type Viewer,
} from "../core/context.ts";
import type { CallSettings, EngineClient } from "../core/engine.ts";
import { idempotencyKeyFrom, requestIdFrom } from "../core/ids.ts";
import { type Endpoint, failure, type GraphqlServer, MAX_BODY_BYTES, type RequestRecord, type Served, type ShellLogger, startGraphqlServer } from "../shell/graphql.ts";
import { jarSessions, SessionJar } from "./jar.ts";

/** A request to one of the APIs: header names in lower case, the body as JSON text. */
export type BrowserRequest = { readonly headers: Readonly<Record<string, string>>; readonly body: string };
export type BrowserReply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string };

export type BrowserGateway = {
  request(api: Endpoint, request: BrowserRequest): Promise<BrowserReply>;
  /** The demo started over: every session ends, as an origin's cookies cleared. */
  reset(): void;
  stop(): Promise<void>;
};

export type BrowserGatewayOptions = {
  readonly engine: EngineClient;
  /** The sessions' clock: the browser's own time, not the demo's, which skips ahead to launches. */
  readonly clock?: () => Date;
  readonly newId?: () => string;
  readonly logger?: ShellLogger;
  /** A working day, or an hour without a request, as on Node. */
  readonly session?: { readonly absoluteMs: number; readonly idleMs: number };
  /** The engine in the page shares its thread with the gateway: generous deadlines. */
  readonly timeouts?: { readonly readMs: number; readonly writeMs: number };
};

const SILENT: ShellLogger = { log: () => {} };
const encoder = new TextEncoder();

export async function startBrowserGateway(options: BrowserGatewayOptions): Promise<BrowserGateway> {
  const clock = options.clock ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const logger = options.logger ?? SILENT;
  const session = options.session ?? { absoluteMs: 8 * 60 * 60 * 1000, idleMs: 60 * 60 * 1000 };
  const timeouts = options.timeouts ?? { readMs: 15_000, writeMs: 30_000 };
  const jars = { internal: new SessionJar<Viewer>({ clock, ...session }), public: new SessionJar<Listener>({ clock, ...session }) };
  const servers: Record<Endpoint, GraphqlServer> = {
    internal: await startGraphqlServer({ endpoint: "internal", schema: buildInternalSchema(), production: false, logger }),
    public: await startGraphqlServer({ endpoint: "public", schema: buildPublicSchema(), production: false, logger }),
  };

  async function request(api: Endpoint, given: BrowserRequest): Promise<BrowserReply> {
    const header = (name: string): string | undefined => given.headers[name];
    const { id: requestId } = requestIdFrom(header("x-request-id"), newId);
    const common: Record<string, string> = { "x-request-id": requestId, "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };
    const finish = (status: number, body: unknown): BrowserReply => ({ status, headers: common, body: JSON.stringify(body) });
    try {
      // 2. The body and the headers that travel to the engine.
      const type = (header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") return finish(415, failure(requestId, "BAD_REQUEST", "Send the request as application/json."));
      if (encoder.encode(given.body).length > MAX_BODY_BYTES) {
        return finish(413, failure(requestId, "BAD_REQUEST", `The body is larger than ${MAX_BODY_BYTES} bytes.`));
      }
      let body: unknown;
      try {
        body = JSON.parse(given.body);
      } catch {
        return finish(400, failure(requestId, "BAD_REQUEST", "The body is not JSON."));
      }
      const key = idempotencyKeyFrom(header("idempotency-key"));
      if (key.malformed) {
        return finish(400, failure(requestId, "BAD_USER_INPUT", "Idempotency-Key must be 8 to 100 letters, digits, dots, dashes, colons or underscores, starting with a letter or a digit."));
      }
      // 3. The session, as the jar holds it for every tab, and the CSRF token.
      const internal = api === "internal";
      const token = header("x-csrf-token");
      const csrfOf = (found: { id: string } | null, matches: (id: string) => boolean) => (found === null ? "no session" : matches(found.id) ? "valid" : "wrong");
      const settings = (record: RequestRecord): CallSettings => ({
        requestId,
        idempotencyKey: key.key,
        detailedErrors: internal,
        timeouts,
        observe: (event) => {
          record.engineCalls += 1;
          if (!event.ok) record.engineFailures += 1;
        },
      });
      let context: Served<InternalContext | PublicContext>;
      if (internal) {
        const found = jars.internal.read();
        const record: RequestRecord = {
          requestId, operation: null, engineCalls: 0, engineFailures: 0, csrf: csrfOf(found, (id) => jars.internal.csrfMatches(id, token)),
        };
        context = { ...createInternalContext({ client: options.engine, settings: settings(record), sessions: jarSessions(jars.internal, found) }), record };
      } else {
        const found = jars.public.read();
        const record: RequestRecord = {
          requestId, operation: null, engineCalls: 0, engineFailures: 0, csrf: csrfOf(found, (id) => jars.public.csrfMatches(id, token)),
        };
        context = { ...createPublicContext({ client: options.engine, settings: settings(record), sessions: jarSessions(jars.public, found) }), record };
      }
      const record = context.record;
      // 4. Apollo.
      const headers = Object.entries(given.headers);
      const answer = await servers[api].execute({ method: "POST", headers, search: "", body, context });
      const out: Record<string, string> = { ...common };
      for (const [name, value] of answer.headers) out[name] = value;
      logger.log("info", "request", { requestId, endpoint: api, status: answer.status, operation: record.operation, engineCalls: record.engineCalls });
      return { status: answer.status, headers: out, body: answer.body };
    } catch (error) {
      logger.log("error", "request crashed", { requestId, error: error instanceof Error ? error.message : String(error) });
      return finish(500, failure(requestId, "INTERNAL_SERVER_ERROR", "Internal error. The gateway's log has it under this request id."));
    }
  }

  return {
    request,
    reset() {
      jars.internal.clear();
      jars.public.clear();
    },
    async stop() {
      await Promise.all([servers.internal.stop(), servers.public.stop()]);
    },
  };
}
