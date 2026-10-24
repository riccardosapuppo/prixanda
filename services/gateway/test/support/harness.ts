// What the gateway's tests share: a clock they move by hand, the ports asked
// to the system before use, the fake engine and the real gateway started
// together, and an HTTP client that behaves like the console's page, or the
// site's (it keeps its API's session cookie and sends the CSRF token back).
// Everything a test starts it stops, and nothing is written to disk.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORTS as REPO_PORTS } from "../../../../tools/lib/paths.ts";
import { run } from "../../../../tools/lib/run.ts";
import { type GatewayConfig, loadConfig } from "../../src/node/config.ts";
import { type Gateway, startGateway } from "../../src/node/gateway.ts";
import { connectEngine, type EngineConnection } from "../../src/node/grpc.ts";
import { createLogger } from "../../src/node/log.ts";
import { COOKIE, SITE_COOKIE } from "../../src/node/sessions.ts";
import { FAKE_ENGINE_PORT, FakeEngine, type FakeEngineOptions } from "./fake-engine.ts";

/**
 * The ports of the gateway's tests: 4613 for the fake engine, 4621 and 4622
 * for the gateway, unless CHECK_FAKE_ENGINE_PORT, CHECK_GATEWAY_INTERNAL_PORT
 * and CHECK_GATEWAY_PUBLIC_PORT say otherwise, so that two copies of the
 * repository can run their tests side by side.
 */
export const PORTS = { engine: FAKE_ENGINE_PORT, internal: REPO_PORTS.gatewayCheckInternal, public: REPO_PORTS.gatewayCheckPublic } as const;
export const CONSOLE_ORIGIN = "http://console.test:4631";
export const SITE_ORIGIN = "http://site.test:4632";

/** A clock that only moves when a test moves it; the rate limits get its monotonic twin. */
export class TestClock {
  #ms: number;
  #monotonic = 0;
  constructor(iso = "2026-10-24T08:00:00Z") {
    this.#ms = Date.parse(iso);
  }
  readonly now = (): Date => new Date(this.#ms);
  readonly monotonic = (): number => this.#monotonic;
  advance(ms: number): void {
    this.#ms += ms;
    this.#monotonic += ms;
  }
}

/** Who listens on these ports, asked to the system once (rule 132: a bind that succeeds on Windows proves nothing). */
export async function listeners(ports: readonly number[]): Promise<string[]> {
  const found: string[] = [];
  if (process.platform === "win32") {
    const { output } = await run("netstat", ["-a", "-n", "-o"]);
    for (const line of output.split(/\r?\n/)) {
      const [protocol, local, remote, , pid] = line.trim().split(/\s+/);
      if (protocol !== "TCP" || (remote !== "0.0.0.0:0" && remote !== "[::]:0")) continue;
      const port = Number(local?.split(":").at(-1));
      if (ports.includes(port)) found.push(`${local} (PID ${pid ?? "?"})`);
    }
  } else {
    const { code, output } = await run("ss", ["-ltnH"]);
    if (code !== 0) throw new Error(`ss exited with ${code}`);
    for (const line of output.split("\n")) {
      const local = line.trim().split(/\s+/)[3];
      const port = Number(local?.split(":").at(-1));
      if (ports.includes(port)) found.push(local ?? String(port));
    }
  }
  return found;
}

export async function assertPortsFree(ports: readonly number[]): Promise<void> {
  const taken = await listeners(ports);
  if (taken.length) throw new Error(`the tests need ports ${ports.join(", ")}, and something listens on ${taken.join(", ")}`);
}

export type Answer = { status: number; headers: Record<string, string | string[] | undefined>; text: string; body: any };

/**
 * What no answer of the site's API may carry, in any field, refusals' reasons
 * first: the engine writes its sentences for the console, with numbers
 * ("Subscriber #5003 is not among..."), and with the identifiers of its log.
 */
export const INTERNAL_IN_PUBLIC: readonly RegExp[] = [
  /#\d/, // a number as the engine writes it: "offer #12", "Subscriber #5003"
  /\bSubscriber\b/, // the engine's word for the listener it names
  /\b(?:change|subscription|subscriber|launch|quote|offer|receipt|payment):\d+/, // the audit log's subjects
  /\bsubscriber-\d+/, // the audit log's actors for the site's listeners
  /\blaunch-\d+/, // a launch's run
  /\bpay_[0-9a-f]{8,}/, // a payment's identifier
];

/** The first of INTERNAL_IN_PUBLIC that a text carries, with its surroundings; null when none. */
export function internalIn(text: string): string | null {
  for (const pattern of INTERNAL_IN_PUBLIC) {
    const found = pattern.exec(text);
    if (found) return `${pattern} in …${text.slice(Math.max(0, found.index - 60), found.index + 60)}…`;
  }
  return null;
}

/**
 * An HTTP client like the console's page, or the site's: it keeps its API's
 * session cookie (`cookieName`) and sends back the CSRF token it was given.
 */
export class Client {
  readonly url: string;
  readonly cookieName: string;
  /** For the site's API: every answer is refused when it carries one of INTERNAL_IN_PUBLIC, whatever the test asked. */
  readonly guarded: boolean;
  cookie: string | null = null;
  csrf: string | null = null;

  constructor(url: string, cookieName = COOKIE) {
    this.url = url;
    this.cookieName = cookieName;
    this.guarded = cookieName === SITE_COOKIE;
  }

  async raw(options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<Answer> {
    const target = new URL(options.path ?? "", this.url);
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookie !== null && headers["cookie"] === undefined) headers["cookie"] = `${this.cookieName}=${this.cookie}`;
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(target, { method: options.method ?? "POST", headers, agent: false }, (incoming) => {
        let text = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => (text += chunk));
        incoming.on("end", () => {
          for (const line of incoming.headers["set-cookie"] ?? []) {
            const [pair = ""] = line.split(";");
            const value = pair.slice(this.cookieName.length + 1);
            if (pair.startsWith(`${this.cookieName}=`)) this.cookie = /Max-Age=0/.test(line) ? null : value;
          }
          let body: unknown = null;
          try {
            body = text === "" ? null : JSON.parse(text);
          } catch {
            body = null;
          }
          const leak = this.guarded ? internalIn(text) : null;
          if (leak !== null) reject(new Error(`the site's API answered with what is the engine's own: ${leak}`));
          else resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, text, body });
        });
      });
      outgoing.on("error", reject);
      if (options.body !== undefined) outgoing.write(options.body);
      outgoing.end();
    });
  }

  /** A GraphQL request as the console sends it; mutations get an Idempotency-Key unless `key` is false. */
  async graphql(query: string, options: { variables?: Record<string, unknown>; headers?: Record<string, string>; key?: string | false } = {}): Promise<Answer> {
    const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
    if (this.csrf !== null && headers["x-csrf-token"] === undefined) headers["x-csrf-token"] = this.csrf;
    const isMutation = /^\s*mutation\b/.test(query);
    if (isMutation && options.key !== false && headers["idempotency-key"] === undefined) headers["idempotency-key"] = options.key ?? `key-${randomUUID()}`;
    return this.raw({ headers, body: JSON.stringify({ query, ...(options.variables ? { variables: options.variables } : {}) }) });
  }

  async signIn(personId: string): Promise<Answer> {
    const answer = await this.graphql("mutation SignIn($id: ID!) { signIn(personId: $id) { csrfToken person { id } roles } }", { variables: { id: personId } });
    const token = answer.body?.data?.signIn?.csrfToken;
    if (typeof token !== "string") throw new Error(`could not sign in as ${personId}: ${answer.text}`);
    this.csrf = token;
    return answer;
  }

  /** On the site: becomes one of the demo's listeners, and keeps the session's CSRF token. */
  async signInAsListener(listenerId: string): Promise<Answer> {
    const answer = await this.graphql("mutation Enter($id: ID!) { signInAsListener(listenerId: $id) { id csrfToken } }", { variables: { id: listenerId } });
    const token = answer.body?.data?.signInAsListener?.csrfToken;
    if (typeof token !== "string") throw new Error(`could not sign in as listener ${listenerId}: ${answer.text}`);
    this.csrf = token;
    return answer;
  }
}

export type Harness = {
  readonly engine: FakeEngine;
  readonly gateway: Gateway;
  readonly config: GatewayConfig;
  readonly clock: TestClock;
  readonly logs: Array<Record<string, any>>;
  /** A fresh client of the console's API: a new browser, with no cookie. */
  console(): Client;
  /** A fresh client of the site's API, which keeps the site's cookie. */
  site(): Client;
  close(): Promise<void>;
};

// Secrets come from the environment, so loadConfig never needs this folder;
// close() checks that nothing was written there.
const UNUSED_DATA_DIR = join(tmpdir(), `gateway-tests-write-nothing-${process.pid}`);

export async function startHarness(options: {
  engine?: Omit<FakeEngineOptions, "clock">;
  env?: Record<string, string>;
  batch?: boolean;
} = {}): Promise<Harness> {
  await assertPortsFree([PORTS.engine, PORTS.internal, PORTS.public]);
  const clock = new TestClock();
  const engine = new FakeEngine({ clock: clock.now, ...options.engine });
  await engine.start();
  let connection: EngineConnection | null = null;
  try {
    const logs: Array<Record<string, any>> = [];
    const logger = createLogger({ clock: clock.now, write: (line) => logs.push(JSON.parse(line)) });
    const config = await loadConfig({
      COMMERCE_INTERNAL_TOKEN: engine.token,
      ENGINE_URL: engine.url,
      GATEWAY_INTERNAL_PORT: String(PORTS.internal),
      GATEWAY_PUBLIC_PORT: String(PORTS.public),
      GATEWAY_SESSION_SECRET: "5e".repeat(32),
      GATEWAY_CONSOLE_ORIGINS: CONSOLE_ORIGIN,
      GATEWAY_SITE_ORIGINS: SITE_ORIGIN,
      GATEWAY_RATE_PER_ADDRESS: "100000/1",
      GATEWAY_RATE_PER_SESSION: "100000/1",
      // Short deadlines keep the tests of an engine that does not answer short.
      GATEWAY_ENGINE_READ_TIMEOUT_MS: "1000",
      GATEWAY_ENGINE_WRITE_TIMEOUT_MS: "2000",
      ...options.env,
    }, UNUSED_DATA_DIR);
    const engineConnection = connectEngine(config.engineUrl, config.engineToken);
    connection = engineConnection;
    const gateway = await startGateway(config, {
      engine: engineConnection.client,
      engineHealth: () => engineConnection.health(),
      logger,
      clock: clock.now,
      monotonic: clock.monotonic,
      ...(options.batch === undefined ? {} : { batch: options.batch }),
    });
    return {
      engine,
      gateway,
      config,
      clock,
      logs,
      console: () => new Client(gateway.internal?.url ?? "http://127.0.0.1:1/"),
      site: () => new Client(gateway.public?.url ?? "http://127.0.0.1:1/", SITE_COOKIE),
      async close() {
        await gateway.close();
        engineConnection.close();
        await engine.stop();
        if (existsSync(UNUSED_DATA_DIR)) throw new Error(`${UNUSED_DATA_DIR} was written to: a test left something behind`);
      },
    };
  } catch (error) {
    connection?.close();
    await engine.stop();
    throw error;
  }
}

/** The GraphQL errors' codes, in order. */
export function codes(answer: Answer): string[] {
  return ((answer.body?.errors ?? []) as Array<{ extensions?: { code?: string } }>).map((error) => error.extensions?.code ?? "(none)");
}
