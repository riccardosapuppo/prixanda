// The gateway's configuration: settings from the environment, secrets kept
// apart from them.
//
// There is one sign-in mode, the demonstration: a person of the demo is
// picked from the engine's list, which is not authentication, and so is one
// of the demo's listeners on the site. So the gateway refuses to start in any
// other mode, refuses to serve the console's API in production at all, and
// keeps no sessions on the site's API in production, because there the
// browser must never choose who it is. What a real deployment needs instead
// is written in REAL_AUTH.
//
// Secrets: the engine's internal token (COMMERCE_INTERNAL_TOKEN) and the key
// that signs both APIs' session cookies (GATEWAY_SESSION_SECRET). In
// development, when they are not set, each is read from a file in .data/
// (ignored by git), created once by whoever starts first, through the same
// code `npm run engine` uses (tools/lib/internal-token.ts); in production
// they must be set.
import { join } from "node:path";
import { internalToken, localSecret } from "../../../../tools/lib/internal-token.ts";

export class ConfigError extends Error {}

export const REAL_AUTH =
  "A real deployment needs OpenID Connect: an identity provider that signs ID tokens, the gateway verifying them (issuer, audience, expiry, signature), " +
  "roles taken from the provider's claims or a server-side directory and never from the browser, and sessions bound to the verified identity; " +
  "the site's listeners sign in the same way, as themselves.";

export type Endpoint = "internal" | "public";

export type RateSetting = { readonly capacity: number; readonly perSecond: number };

export type GatewayConfig = {
  readonly production: boolean;
  readonly host: string;
  readonly ports: { readonly internal: number; readonly public: number };
  readonly endpoints: readonly Endpoint[];
  readonly engineUrl: string;
  readonly engineToken: string;
  /** Null when no API keeps sessions: the console's is not served, and the site's keeps none. */
  readonly sessionSecret: Uint8Array | null;
  /** Whether the site's API keeps sessions, in which one of the demo's listeners is chosen: in development only. */
  readonly siteSessions: boolean;
  readonly origins: { readonly internal: readonly string[]; readonly public: readonly string[] };
  readonly cookieSecure: boolean;
  readonly trustProxy: boolean;
  readonly rate: { readonly address: RateSetting; readonly session: RateSetting };
  readonly timeouts: { readonly readMs: number; readonly writeMs: number };
  readonly session: { readonly absoluteMs: number; readonly idleMs: number };
};

/** Every variable the gateway reads. Any other GATEWAY_ variable is refused: a misspelt setting must not pass for a default. */
export const VARIABLES = {
  COMMERCE_INTERNAL_TOKEN: "the engine's internal token (secret); in development, .data/internal-token when unset",
  ENGINE_URL: "the engine's address, http://127.0.0.1:4611 by default",
  NODE_ENV: "production turns production on",
  GATEWAY_ENV: "development (default) or production",
  GATEWAY_AUTH: "demo, the only sign-in mode there is",
  GATEWAY_HOST: "the address to listen on, 127.0.0.1 by default",
  GATEWAY_INTERNAL_PORT: "the console's API, 4621 by default",
  GATEWAY_PUBLIC_PORT: "the site's API, 4622 by default",
  GATEWAY_ENDPOINTS: "internal,public (default), or one of them",
  GATEWAY_SESSION_SECRET: "64 or more hexadecimal digits that sign both APIs' session cookies (secret); in development, .data/gateway-session-secret when unset",
  GATEWAY_CONSOLE_ORIGINS: "the console's origins, comma separated, such as http://localhost:4631",
  GATEWAY_SITE_ORIGINS: "the site's origins, comma separated",
  GATEWAY_COOKIE_SECURE: "true to mark the session cookie Secure (needed behind HTTPS); false by default",
  GATEWAY_TRUST_PROXY: "true to take the client's address from X-Forwarded-For; false by default",
  GATEWAY_RATE_PER_ADDRESS: "requests/seconds per client address, 300/60 by default",
  GATEWAY_RATE_PER_SESSION: "requests/seconds per session, 120/60 by default",
  GATEWAY_ENGINE_READ_TIMEOUT_MS: "deadline of the engine's reads, 5000 by default",
  GATEWAY_ENGINE_WRITE_TIMEOUT_MS: "deadline of the engine's writes, 10000 by default",
} as const;

const HEX_SECRET = /^[0-9a-f]{64,}$/;

function port(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65_535) throw new ConfigError(`${name} must be a port number, not ${JSON.stringify(value)}`);
  return number;
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new ConfigError(`${name} must be a whole number of 1 or more, not ${JSON.stringify(value)}`);
  return number;
}

function flag(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new ConfigError(`${name} must be true or false, not ${JSON.stringify(value)}`);
}

function rate(value: string | undefined, fallback: string, name: string): RateSetting {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? fallback);
  const requests = Number(match?.[1]);
  const seconds = Number(match?.[2]);
  if (!match || requests < 1 || seconds < 1) throw new ConfigError(`${name} must read requests/seconds, such as ${fallback}`);
  return { capacity: requests, perSecond: requests / seconds };
}

function origins(value: string | undefined, name: string): string[] {
  const list = (value ?? "").split(",").map((origin) => origin.trim()).filter((origin) => origin !== "");
  for (const origin of list) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigError(`${name}: ${JSON.stringify(origin)} is not an origin such as http://localhost:4631`);
    }
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
      throw new ConfigError(`${name}: ${JSON.stringify(origin)} is not an origin (scheme, host and port, nothing else)`);
    }
  }
  return list;
}

/** A development secret read from .data/, a failure reported as the configuration's. */
async function developmentSecret(read: () => Promise<string>): Promise<string> {
  try {
    return await read();
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
}

export async function loadConfig(env: NodeJS.ProcessEnv, dataDir: string): Promise<GatewayConfig> {
  const unknown = Object.keys(env).filter((name) => name.startsWith("GATEWAY_") && !Object.hasOwn(VARIABLES, name));
  if (unknown.length) {
    throw new ConfigError(`unknown settings: ${unknown.join(", ")}. The gateway reads ${Object.keys(VARIABLES).filter((name) => name.startsWith("GATEWAY_")).join(", ")}`);
  }
  const auth = env["GATEWAY_AUTH"] ?? "demo";
  if (auth !== "demo") {
    throw new ConfigError(`GATEWAY_AUTH=${auth}: the gateway has one sign-in mode, the demonstration, and it is not authentication. ${REAL_AUTH}`);
  }
  const mode = env["GATEWAY_ENV"] ?? (env["NODE_ENV"] === "production" ? "production" : "development");
  if (mode !== "development" && mode !== "production") throw new ConfigError(`GATEWAY_ENV must be development or production, not ${JSON.stringify(mode)}`);
  const production = mode === "production" || env["NODE_ENV"] === "production";

  const endpoints = (env["GATEWAY_ENDPOINTS"] ?? "internal,public").split(",").map((name) => name.trim()).filter(Boolean);
  if (endpoints.length === 0 || endpoints.some((name) => name !== "internal" && name !== "public") || new Set(endpoints).size !== endpoints.length) {
    throw new ConfigError("GATEWAY_ENDPOINTS must list internal, public or both, once each");
  }
  if (production && endpoints.includes("internal")) {
    throw new ConfigError(
      "the console's API does not run in production: its sign-in is a demonstration that lets the browser pick a person and their roles, and this gateway has no real authentication. "
        + `${REAL_AUTH} Set GATEWAY_ENDPOINTS=public to serve the site's API alone.`,
    );
  }

  const engineUrl = env["ENGINE_URL"] ?? "http://127.0.0.1:4611";
  try {
    const parsed = new URL(engineUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("scheme");
  } catch {
    throw new ConfigError(`ENGINE_URL must be an http or https address, not ${JSON.stringify(engineUrl)}`);
  }

  if (!env["COMMERCE_INTERNAL_TOKEN"] && production) {
    throw new ConfigError("COMMERCE_INTERNAL_TOKEN must be set in production: the local token file is for development only");
  }
  const engineToken = await developmentSecret(async () => (await internalToken(env, dataDir)).token);

  // The site's sessions let the browser pick a listener: a demonstration, so never in production.
  const siteSessions = endpoints.includes("public") && !production;
  let sessionSecret: Uint8Array | null = null;
  if (endpoints.includes("internal") || siteSessions) {
    const configured = env["GATEWAY_SESSION_SECRET"] ?? "";
    if (configured !== "" && !HEX_SECRET.test(configured)) throw new ConfigError("GATEWAY_SESSION_SECRET must be 64 or more hexadecimal digits (32 bytes or more)");
    const hex = configured || (await developmentSecret(async () => (await localSecret(join(dataDir, "gateway-session-secret"))).secret));
    sessionSecret = Uint8Array.from(Buffer.from(hex, "hex"));
  }

  const ports = {
    internal: port(env["GATEWAY_INTERNAL_PORT"], 4621, "GATEWAY_INTERNAL_PORT"),
    public: port(env["GATEWAY_PUBLIC_PORT"], 4622, "GATEWAY_PUBLIC_PORT"),
  };
  if (endpoints.length === 2 && ports.internal === ports.public) throw new ConfigError("the console's and the site's APIs need two different ports");

  return {
    production,
    host: env["GATEWAY_HOST"] || "127.0.0.1",
    ports,
    endpoints: endpoints as Endpoint[],
    engineUrl,
    engineToken,
    sessionSecret,
    siteSessions,
    origins: {
      internal: origins(env["GATEWAY_CONSOLE_ORIGINS"], "GATEWAY_CONSOLE_ORIGINS"),
      public: origins(env["GATEWAY_SITE_ORIGINS"], "GATEWAY_SITE_ORIGINS"),
    },
    cookieSecure: flag(env["GATEWAY_COOKIE_SECURE"], "GATEWAY_COOKIE_SECURE"),
    trustProxy: flag(env["GATEWAY_TRUST_PROXY"], "GATEWAY_TRUST_PROXY"),
    rate: {
      address: rate(env["GATEWAY_RATE_PER_ADDRESS"], "300/60", "GATEWAY_RATE_PER_ADDRESS"),
      session: rate(env["GATEWAY_RATE_PER_SESSION"], "120/60", "GATEWAY_RATE_PER_SESSION"),
    },
    timeouts: {
      readMs: positive(env["GATEWAY_ENGINE_READ_TIMEOUT_MS"], 5_000, "GATEWAY_ENGINE_READ_TIMEOUT_MS"),
      writeMs: positive(env["GATEWAY_ENGINE_WRITE_TIMEOUT_MS"], 10_000, "GATEWAY_ENGINE_WRITE_TIMEOUT_MS"),
    },
    // A working day, and an hour without a request ends it.
    session: { absoluteMs: 8 * 3_600_000, idleMs: 3_600_000 },
  };
}
