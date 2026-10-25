// What both shells do with a GraphQL request once it is theirs: Apollo
// Server through its integration API, with the schema's limits, no stack
// traces, no landing page and no reporting to any outside service; the CSRF
// token every mutation must carry while a session exists; the request id in
// every response's extensions; and the errors told to the client in its words
// or as a generic sentence. The Node shell (src/node/http.ts) reaches this
// over HTTP, the browser's (src/browser/gateway.ts) over the sandbox worker's
// messages. Nothing here imports Node: it runs in the browser of stage 8.
import { ApolloServer, type ApolloServerPlugin, HeaderMap } from "@apollo/server";
import {
  ApolloServerPluginCacheControlDisabled, ApolloServerPluginInlineTraceDisabled, ApolloServerPluginLandingPageDisabled,
  ApolloServerPluginSchemaReportingDisabled, ApolloServerPluginUsageReportingDisabled,
} from "@apollo/server/plugin/disabled";
import { GraphQLError, type GraphQLFormattedError, type GraphQLSchema } from "graphql";
import type { InternalContext, PublicContext } from "../core/context.ts";
import { ERROR_CODES } from "../core/errors.ts";
import { INTERNAL_LIMITS, limitRules, PUBLIC_LIMITS } from "../core/limits.ts";

/** The largest body either shell reads. */
export const MAX_BODY_BYTES = 64 * 1024;

export type Endpoint = "internal" | "public";

/** What a shell knows about a request, for the plugins and its log line. */
export type RequestRecord = {
  readonly requestId: string;
  operation: string | null;
  engineCalls: number;
  engineFailures: number;
  readonly csrf: "valid" | "wrong" | "no session";
};

export type Served<C> = C & { readonly record: RequestRecord };

/** A shell's log: a level, a message and fields. */
export type ShellLogger = { log(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void };

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

/** An answer of the shell's own, before Apollo: the same shape as Apollo's errors, with the request id. */
export function failure(requestId: string, code: string, message: string) {
  return { errors: [{ message, extensions: { code } }], extensions: { requestId } };
}

function plugins(logger: ShellLogger): ApolloServerPlugin<Served<InternalContext | PublicContext>>[] {
  return [
    ApolloServerPluginLandingPageDisabled(),
    ApolloServerPluginUsageReportingDisabled(),
    ApolloServerPluginSchemaReportingDisabled(),
    ApolloServerPluginInlineTraceDisabled(),
    ApolloServerPluginCacheControlDisabled(),
    {
      // What broke inside Apollo before or outside the operation: the client gets a generic 500, the log the reason.
      async unexpectedErrorProcessingRequest({ error }) {
        logger.log("error", "request crashed inside Apollo", { error: error.message });
      },
      async requestDidStart() {
        return {
          async didResolveOperation({ operation, operationName, contextValue }) {
            contextValue.record.operation = operationName ?? operation?.name?.value ?? null;
            // CSRF: while a session travels, a mutation must also carry the
            // token that only a page of the console, or of the site, could have read.
            if (operation?.operation === "mutation" && contextValue.record.csrf === "wrong") {
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

/** One schema's GraphQL server, started. */
export type GraphqlServer = {
  /** Runs a request that passed the shell's own checks, with its context; the body as Apollo answers it, read whole. */
  execute(request: {
    readonly method: string;
    readonly headers: Iterable<readonly [string, string]>;
    readonly search: string;
    readonly body: unknown;
    readonly context: Served<InternalContext | PublicContext>;
  }): Promise<{ readonly status: number; readonly headers: ReadonlyMap<string, string>; readonly body: string }>;
  stop(): Promise<void>;
};

export async function startGraphqlServer(options: {
  readonly endpoint: Endpoint;
  readonly schema: GraphQLSchema;
  /** The site's schema is not introspectable in production; the console's API never runs there. */
  readonly production: boolean;
  readonly logger: ShellLogger;
}): Promise<GraphqlServer> {
  const { endpoint, logger } = options;
  const internal = endpoint === "internal";
  const apollo = new ApolloServer<Served<InternalContext | PublicContext>>({
    schema: options.schema,
    introspection: !options.production,
    hideSchemaDetailsFromClientErrors: options.production || !internal,
    includeStacktraceInErrorResponses: false,
    csrfPrevention: true,
    allowBatchedHttpRequests: false,
    persistedQueries: false,
    stopOnTerminationSignals: false,
    nodeEnv: options.production ? "production" : "development",
    validationRules: limitRules(internal ? INTERNAL_LIMITS : PUBLIC_LIMITS),
    parseOptions: { maxTokens: internal ? 5_000 : 1_500 },
    formatError: (formatted, original) => {
      const told = formatError(formatted);
      // What broke outside the operation's fields (they have a path, and their own log line in didEncounterErrors):
      // Apollo answers 500 and logs nothing itself, so the reason is logged here.
      if (told.extensions?.["code"] === "INTERNAL_SERVER_ERROR" && formatted.path === undefined) {
        logger.log("error", "request failed outside the operation", { error: original instanceof Error ? original.message : String(original) });
      }
      return told;
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: unknown) => logger.log("warn", String(message), { endpoint }),
      error: (message: unknown) => logger.log("error", String(message), { endpoint }),
    },
    plugins: plugins(logger),
  });
  await apollo.start();
  return {
    async execute(request) {
      const headers = new HeaderMap();
      for (const [name, value] of request.headers) headers.set(name, value);
      const answer = await apollo.executeHTTPGraphQLRequest({
        httpGraphQLRequest: { method: request.method, headers, search: request.search, body: request.body },
        context: async () => request.context,
      });
      let body = "";
      if (answer.body.kind === "complete") body = answer.body.string;
      else for await (const chunk of answer.body.asyncIterator) body += chunk;
      return { status: answer.status ?? 200, headers: new Map(answer.headers), body };
    },
    stop: () => apollo.stop(),
  };
}
