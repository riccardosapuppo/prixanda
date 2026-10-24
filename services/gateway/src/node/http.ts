// The HTTP shell around one schema: Node's http server, Apollo Server through
// its integration API, and everything that belongs to HTTP rather than to the
// schema. In order, for each request:
//   1. the request id: the client's when well formed, a new one otherwise,
//      returned in X-Request-Id and in the response's extensions;
//   2. CORS: only the console's origins reach the console's API, only the
//      site's reach the site's; any other Origin is refused outright;
//   3. rate limits per client address and per session, with 429 and
//      Retry-After;
//   4. the body: POST of JSON up to 64 KiB, or GET; the Idempotency-Key
//      header checked for its shape;
//   5. the session (console only) from its signed cookie, and the CSRF token
//      every mutation must carry while a session exists;
//   6. Apollo, with the schema's limits, no stack traces, no landing page, no
//      reporting to any outside service.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ApolloServer, type ApolloServerPlugin, HeaderMap } from "@apollo/server";
import {
  ApolloServerPluginCacheControlDisabled, ApolloServerPluginInlineTraceDisabled, ApolloServerPluginLandingPageDisabled,
  ApolloServerPluginSchemaReportingDisabled, ApolloServerPluginUsageReportingDisabled,
} from "@apollo/server/plugin/disabled";
import { GraphQLError, type GraphQLFormattedError, type GraphQLSchema } from "graphql";
import { createInternalContext, createPublicContext, type InternalContext, type PublicContext } from "../core/context.ts";
import type { CallSettings, EngineClient } from "../core/engine.ts";
import { ERROR_CODES } from "../core/errors.ts";
import { idempotencyKeyFrom, requestIdFrom } from "../core/ids.ts";
import { INTERNAL_LIMITS, limitRules, PUBLIC_LIMITS } from "../core/limits.ts";
import type { TokenBuckets } from "../core/rate-limit.ts";
import type { Endpoint, GatewayConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { cookieValueFrom, requestSessions, type SessionStore } from "./sessions.ts";

export const MAX_BODY_BYTES = 64 * 1024;
export const PATH = "/graphql";

/** What the shell knows about a request, for its plugins and its log line. */
type Record_ = {
  readonly requestId: string;
  operation: string | null;
  engineCalls: number;
  engineFailures: number;
  readonly csrf: "valid" | "wrong" | "no session";
};

type Served<C> = C & { readonly record: Record_ };

export type EndpointServer = {
  readonly endpoint: Endpoint;
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
};

export type EndpointOptions = {
  readonly endpoint: Endpoint;
  readonly schema: GraphQLSchema;
  readonly config: GatewayConfig;
  readonly engine: EngineClient;
  readonly engineHealth: () => Promise<string>;
  /** The console's sessions; absent for the site. */
  readonly sessions?: SessionStore;
  readonly limits: { readonly address: TokenBuckets; readonly session: TokenBuckets };
  readonly logger: Logger;
  readonly newId?: () => string;
  /** False only to measure what the DataLoader saves. */
  readonly batch?: boolean;
};

/** Apollo's own codes that speak to the client, kept with their message. */
const CLIENT_CODES = new Set<string>([
  ...ERROR_CODES.filter((code) => code !== "INTERNAL_SERVER_ERROR"),
  "GRAPHQL_PARSE_FAILED", "GRAPHQL_VALIDATION_FAILED", "BAD_REQUEST", "OPERATION_RESOLUTION_FAILURE", "PERSISTED_QUERY_NOT_SUPPORTED",
]);

/**
 * What an error looks like to the client: its message and code when it is
 * meant for them, a generic sentence otherwise; never a stack trace or the
 * extensions a library added.
 */
export function formatError(formatted: GraphQLFormattedError): GraphQLFormattedError {
  const code = typeof formatted.extensions?.["code"] === "string" ? formatted.extensions["code"] : "INTERNAL_SERVER_ERROR";
  const where = { ...(formatted.locations ? { locations: formatted.locations } : {}), ...(formatted.path ? { path: formatted.path } : {}) };
  if (CLIENT_CODES.has(code)) return { message: formatted.message, ...where, extensions: { code } };
  return { message: "Internal error. The gateway's log has it under this response's request id.", ...where, extensions: { code: "INTERNAL_SERVER_ERROR" } };
}

function plugins(endpoint: Endpoint, logger: Logger): ApolloServerPlugin<Served<InternalContext | PublicContext>>[] {
  return [
    ApolloServerPluginLandingPageDisabled(),
    ApolloServerPluginUsageReportingDisabled(),
    ApolloServerPluginSchemaReportingDisabled(),
    ApolloServerPluginInlineTraceDisabled(),
    ApolloServerPluginCacheControlDisabled(),
    {
      async requestDidStart() {
        return {
          async didResolveOperation({ operation, operationName, contextValue }) {
            contextValue.record.operation = operationName ?? operation?.name?.value ?? null;
            // CSRF: while a session cookie travels, a mutation must also carry
            // the token that only a page of the console could have read.
            if (endpoint === "internal" && operation?.operation === "mutation" && contextValue.record.csrf === "wrong") {
              throw new GraphQLError("This mutation needs the session's CSRF token in the X-CSRF-Token header.", {
                extensions: { code: "FORBIDDEN", http: { status: 403 } },
              });
            }
          },
          async didEncounterErrors({ errors, contextValue }) {
            for (const error of errors) {
              const code = error.extensions?.["code"];
              if (code === undefined || code === "INTERNAL_SERVER_ERROR") {
                logger.log("error", "request failed", { requestId: contextValue.record.requestId, error: error.message, path: error.path });
              }
            }
          },
          async willSendResponse({ response, contextValue }) {
            if (response.body.kind === "single") {
              response.body.singleResult.extensions = { ...response.body.singleResult.extensions, requestId: contextValue.record.requestId };
            }
          },
        };
      },
    },
  ];
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function failure(requestId: string, code: string, message: string) {
  return { errors: [{ message, extensions: { code } }], extensions: { requestId } };
}

async function readBody(request: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, status: 413, message: `The body is larger than ${MAX_BODY_BYTES} bytes.` };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, message: `The body is larger than ${MAX_BODY_BYTES} bytes.` };
    chunks.push(chunk as Buffer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    const last = forwarded.at(-1);
    if (last) return last;
  }
  return request.socket.remoteAddress ?? "unknown";
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
};

export async function serveEndpoint(options: EndpointOptions): Promise<EndpointServer> {
  const { endpoint, config, logger } = options;
  const internal = endpoint === "internal";
  if (internal && options.sessions === undefined) throw new Error("the console's API needs its session store");
  const newId = options.newId ?? randomUUID;
  const allowed = new Set(config.origins[endpoint]);
  const apollo = new ApolloServer<Served<InternalContext | PublicContext>>({
    schema: options.schema,
    // The site's schema is not introspectable in production; the console's API never runs there.
    introspection: !config.production,
    hideSchemaDetailsFromClientErrors: config.production || !internal,
    includeStacktraceInErrorResponses: false,
    csrfPrevention: true,
    allowBatchedHttpRequests: false,
    persistedQueries: false,
    stopOnTerminationSignals: false,
    nodeEnv: config.production ? "production" : "development",
    validationRules: limitRules(internal ? INTERNAL_LIMITS : PUBLIC_LIMITS),
    parseOptions: { maxTokens: internal ? 5_000 : 1_500 },
    formatError,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: unknown) => logger.log("warn", String(message), { endpoint }),
      error: (message: unknown) => logger.log("error", String(message), { endpoint }),
    },
    plugins: plugins(endpoint, logger),
  });
  await apollo.start();

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const started = performance.now();
    const { id: requestId } = requestIdFrom(header(request, "x-request-id"), newId);
    const url = new URL(request.url ?? "/", "http://gateway.invalid");
    const common: Record<string, string> = {
      "x-request-id": requestId,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      vary: "Origin",
    };
    let status = 0;
    let person: string | null = null;
    let record: Record_ | null = null;
    const finish = (code: number, body: unknown, extra: Record<string, string> = {}) => {
      status = code;
      send(response, code, body, { ...common, ...extra });
    };
    try {
      // 2. CORS.
      const origin = header(request, "origin");
      if (origin !== undefined) {
        if (!allowed.has(origin)) return finish(403, failure(requestId, "FORBIDDEN", `Requests from ${origin} are not accepted here.`));
        common["access-control-allow-origin"] = origin;
        common["access-control-expose-headers"] = "X-Request-Id, Retry-After";
        if (internal) common["access-control-allow-credentials"] = "true";
        if (request.method === "OPTIONS") {
          status = 204;
          response.writeHead(204, {
            ...common,
            "access-control-allow-methods": "GET, POST",
            "access-control-allow-headers": "Content-Type, Idempotency-Key, X-Request-Id, X-CSRF-Token, Apollo-Require-Preflight",
            "access-control-max-age": "600",
          });
          response.end();
          return;
        }
      }
      // 3. Rate limits, before any work: per address always, per session when there is one.
      const store = options.sessions;
      const found = store?.read(cookieValueFrom(header(request, "cookie"))) ?? null;
      person = found?.info.viewer.personId ?? null;
      for (const verdict of [options.limits.address.take(clientAddress(request, config.trustProxy)), found ? options.limits.session.take(found.id) : null]) {
        if (verdict !== null && !verdict.allowed) {
          return finish(429, failure(requestId, "RATE_LIMITED", `Too many requests: try again in ${verdict.retryAfterSeconds} s.`), {
            "retry-after": String(verdict.retryAfterSeconds),
          });
        }
      }
      if (url.pathname === "/health" && request.method === "GET") {
        const engine = await options.engineHealth();
        return finish(engine === "SERVING" ? 200 : 503, { status: engine === "SERVING" ? "ok" : "degraded", endpoint, engine, mode: "demonstration" });
      }
      if (url.pathname !== PATH) return finish(404, failure(requestId, "NOT_FOUND", `Nothing here: the API is at ${PATH}.`));
      if (request.method !== "GET" && request.method !== "POST") {
        return finish(405, failure(requestId, "BAD_REQUEST", "Use POST, or GET for queries."), { allow: "GET, POST" });
      }

      // 4. The body and the headers that travel to the engine.
      let body: unknown;
      if (request.method === "POST") {
        const type = (header(request, "content-type") ?? "").split(";")[0]?.trim().toLowerCase();
        if (type !== "application/json") return finish(415, failure(requestId, "BAD_REQUEST", "Send the request as application/json."));
        const read = await readBody(request);
        if (!read.ok) return finish(read.status, failure(requestId, "BAD_REQUEST", read.message));
        try {
          body = JSON.parse(read.text);
        } catch {
          return finish(400, failure(requestId, "BAD_REQUEST", "The body is not JSON."));
        }
      }
      const key = idempotencyKeyFrom(header(request, "idempotency-key"));
      if (key.malformed) {
        return finish(400, failure(requestId, "BAD_USER_INPUT", "Idempotency-Key must be 8 to 100 letters, digits, dots, dashes, colons or underscores, starting with a letter or a digit."));
      }

      // 5. The context: the session, the engine bound to this request.
      const pending: string[] = [];
      record = {
        requestId,
        operation: null,
        engineCalls: 0,
        engineFailures: 0,
        csrf: found === null ? "no session" : store?.csrfMatches(found.id, header(request, "x-csrf-token")) ? "valid" : "wrong",
      };
      const kept = record;
      const settings: CallSettings = {
        requestId,
        idempotencyKey: key.key,
        detailedErrors: internal,
        timeouts: config.timeouts,
        observe: (event) => {
          kept.engineCalls += 1;
          if (!event.ok) {
            kept.engineFailures += 1;
            logger.log(event.code === "Unavailable" || event.code === "DeadlineExceeded" ? "warn" : "info", "engine call failed", {
              requestId, method: event.method, code: event.code, ms: event.ms, engine: event.message,
            });
          }
        },
      };
      const context: Served<InternalContext | PublicContext> = internal && store
        ? {
          ...createInternalContext({
            client: options.engine,
            settings,
            sessions: requestSessions(store, found, { secure: config.cookieSecure, maxAgeSeconds: Math.round(config.session.absoluteMs / 1000) }, (cookie) => pending.push(cookie)),
            ...(options.batch === undefined ? {} : { batch: options.batch }),
          }),
          record: kept,
        }
        : { ...createPublicContext({ client: options.engine, settings }), record: kept };

      // 6. Apollo.
      const headers = new HeaderMap();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const answer = await apollo.executeHTTPGraphQLRequest({
        httpGraphQLRequest: { method: request.method, headers, search: url.search, body },
        context: async () => context,
      });
      status = answer.status ?? 200;
      const out: Record<string, string | string[]> = { ...common };
      for (const [name, value] of answer.headers) out[name] = value;
      if (pending.length) out["set-cookie"] = pending;
      person = internal && "sessions" in context ? context.sessions.current()?.viewer.personId ?? null : null;
      response.writeHead(status, out);
      if (answer.body.kind === "complete") {
        response.end(answer.body.string);
      } else {
        for await (const chunk of answer.body.asyncIterator) response.write(chunk);
        response.end();
      }
    } catch (error) {
      logger.log("error", "request crashed", { requestId, error: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) finish(500, failure(requestId, "INTERNAL_SERVER_ERROR", "Internal error. The gateway's log has it under this request id."));
      else response.end();
    } finally {
      logger.log("info", "request", {
        requestId, endpoint, method: request.method, path: url.pathname, status, ms: Math.round(performance.now() - started),
        ...(record?.operation ? { operation: record.operation } : {}),
        ...(person ? { person } : {}),
        ...(record ? { engineCalls: record.engineCalls, engineFailures: record.engineFailures } : {}),
      });
    }
  };

  const server = createServer((request, response) => {
    void handle(request, response);
  });
  // Slow clients do not hold connections open for ever.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  const port = config.ports[endpoint];
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    endpoint,
    server,
    url: `http://${config.host}:${port}${PATH}`,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      await apollo.stop();
    },
  };
}
