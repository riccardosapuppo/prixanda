// Both endpoints, each on its own port: the console's API and the site's API
// never share a server, so the site's port cannot even reach the console's
// schema.
import { buildInternalSchema, buildPublicSchema } from "../core/schemas.ts";
import { TokenBuckets } from "../core/rate-limit.ts";
import type { EngineClient } from "../core/engine.ts";
import type { GatewayConfig } from "./config.ts";
import { type EndpointServer, serveEndpoint } from "./http.ts";
import type { Logger } from "./log.ts";
import { SessionStore } from "./sessions.ts";

export type Gateway = {
  readonly internal: EndpointServer | null;
  readonly public: EndpointServer | null;
  close(): Promise<void>;
};

export async function startGateway(config: GatewayConfig, deps: {
  engine: EngineClient;
  engineHealth: () => Promise<string>;
  logger: Logger;
  clock: () => Date;
  /** A clock for the rate limits that never goes back. */
  monotonic?: () => number;
  newId?: () => string;
  batch?: boolean;
}): Promise<Gateway> {
  const monotonic = deps.monotonic ?? (() => performance.now());
  const limits = {
    address: new TokenBuckets({ ...config.rate.address, maxKeys: 50_000, now: monotonic }),
    session: new TokenBuckets({ ...config.rate.session, maxKeys: 50_000, now: monotonic }),
  };
  const common = {
    config,
    engine: deps.engine,
    engineHealth: deps.engineHealth,
    limits,
    logger: deps.logger,
    ...(deps.newId ? { newId: deps.newId } : {}),
    ...(deps.batch === undefined ? {} : { batch: deps.batch }),
  };
  const started: EndpointServer[] = [];
  try {
    let internal: EndpointServer | null = null;
    let site: EndpointServer | null = null;
    if (config.endpoints.includes("internal")) {
      if (config.sessionSecret === null) throw new Error("the console's API needs a session key");
      const sessions = new SessionStore({ secret: config.sessionSecret, clock: deps.clock, ...config.session });
      internal = await serveEndpoint({ ...common, endpoint: "internal", schema: buildInternalSchema(), sessions });
      started.push(internal);
    }
    if (config.endpoints.includes("public")) {
      site = await serveEndpoint({ ...common, endpoint: "public", schema: buildPublicSchema() });
      started.push(site);
    }
    return {
      internal,
      public: site,
      async close() {
        await Promise.all(started.map((endpoint) => endpoint.close()));
      },
    };
  } catch (error) {
    await Promise.all(started.map((endpoint) => endpoint.close()));
    throw error;
  }
}
