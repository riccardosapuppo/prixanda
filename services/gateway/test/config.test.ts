// The gateway's configuration: one sign-in mode, the demonstration, said at
// every start; no console's API in production; settings refused by name when
// unknown; local secrets created once and shared, never overwritten. The last
// tests start `npm run gateway`'s own entry point as a process, the way a
// person would.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { internalToken, localSecret } from "../../../tools/lib/internal-token.ts";
import { ConfigError, loadConfig, VARIABLES } from "../src/node/config.ts";
import { FAKE_TOKEN, FakeEngine } from "./support/fake-engine.ts";
import { assertPortsFree, PORTS, TestClock } from "./support/harness.ts";

const SECRETS = { COMMERCE_INTERNAL_TOKEN: "t".repeat(64), GATEWAY_SESSION_SECRET: "ab".repeat(32) };
const NO_DIR = join(tmpdir(), "gateway-config-tests-write-nothing");

const refuses = (pattern: RegExp) => (error: unknown) => error instanceof ConfigError && pattern.test(error.message);

describe("loadConfig", () => {
  test("refuses any sign-in mode but the demonstration, and says what a real deployment needs", async () => {
    await assert.rejects(loadConfig({ ...SECRETS, GATEWAY_AUTH: "oidc" }, NO_DIR), refuses(/one sign-in mode, the demonstration.*OpenID Connect/s));
    await assert.rejects(loadConfig({ ...SECRETS, GATEWAY_AUTH: "" }, NO_DIR), refuses(/GATEWAY_AUTH=/));
  });

  test("refuses the console's API in production, however production is asked for", async () => {
    for (const env of [{ GATEWAY_ENV: "production" }, { NODE_ENV: "production" }]) {
      await assert.rejects(loadConfig({ ...SECRETS, ...env }, NO_DIR), refuses(/console's API does not run in production.*GATEWAY_ENDPOINTS=public/s));
    }
  });

  test("serves the site's API alone in production, with the token from the environment only", async () => {
    const config = await loadConfig({ ...SECRETS, GATEWAY_ENV: "production", GATEWAY_ENDPOINTS: "public" }, NO_DIR);
    assert.deepEqual({ production: config.production, endpoints: config.endpoints, sessionSecret: config.sessionSecret }, { production: true, endpoints: ["public"], sessionSecret: null });
    await assert.rejects(loadConfig({ GATEWAY_ENV: "production", GATEWAY_ENDPOINTS: "public" }, NO_DIR), refuses(/COMMERCE_INTERNAL_TOKEN must be set in production/));
  });

  test("refuses a setting it does not know, by name", async () => {
    await assert.rejects(loadConfig({ ...SECRETS, GATEWAY_COOKIE_SECUR: "true" }, NO_DIR), refuses(/unknown settings: GATEWAY_COOKIE_SECUR/));
    assert.ok(Object.hasOwn(VARIABLES, "GATEWAY_COOKIE_SECURE"));
  });

  test("refuses malformed values", async () => {
    for (const [name, value, pattern] of [
      ["GATEWAY_INTERNAL_PORT", "70000", /port number/],
      ["GATEWAY_CONSOLE_ORIGINS", "http://console.test/app", /not an origin/],
      ["GATEWAY_SITE_ORIGINS", "console.test", /not an origin/],
      ["GATEWAY_RATE_PER_ADDRESS", "100", /requests\/seconds/],
      ["GATEWAY_COOKIE_SECURE", "yes", /true or false/],
      ["GATEWAY_SESSION_SECRET", "abc", /64 or more hexadecimal digits/],
      ["GATEWAY_ENDPOINTS", "internal,internal", /once each/],
      ["ENGINE_URL", "ftp://engine", /http or https/],
    ] as const) {
      await assert.rejects(loadConfig({ ...SECRETS, [name]: value }, NO_DIR), refuses(pattern), `${name}=${value}`);
    }
  });

  test("by default: loopback, ports 4621 and 4622, both APIs, no browser origin, the engine at 4611", async () => {
    const config = await loadConfig({ ...SECRETS }, NO_DIR);
    assert.deepEqual(
      { host: config.host, ports: config.ports, endpoints: config.endpoints, origins: config.origins, engine: config.engineUrl, production: config.production, secure: config.cookieSecure },
      { host: "127.0.0.1", ports: { internal: 4621, public: 4622 }, endpoints: ["internal", "public"], origins: { internal: [], public: [] }, engine: "http://127.0.0.1:4611", production: false, secure: false },
    );
  });
});

describe("local secrets (tools/lib/internal-token.ts, shared with npm run engine)", () => {
  test("are created once, with 32 random bytes, and whoever comes second reads the same one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gateway-secret-"));
    try {
      const file = join(dir, "internal-token");
      const results = await Promise.all(Array.from({ length: 8 }, () => localSecret(file)));
      assert.match(results[0]?.secret ?? "", /^[0-9a-f]{64}$/);
      assert.equal(new Set(results.map((result) => result.secret)).size, 1);
      assert.equal(results.filter((result) => result.created).length, 1, "one of them created it");
      assert.equal((await readFile(file, "utf8")).trim(), results[0]?.secret);
      const other = await localSecret(join(dir, "gateway-session-secret"));
      assert.notEqual(other.secret, results[0]?.secret);
      assert.deepEqual((await readdir(dir)).sort(), ["gateway-session-secret", "internal-token"], "no file of a writer is left behind");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a secret another process wrote first is read, never replaced, even while it is still being written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gateway-secret-"));
    try {
      const file = join(dir, "internal-token");
      await writeFile(file, "");
      const written = "c0ffee".repeat(10) + "abcd";
      setTimeout(() => void writeFile(file, `${written}\n`), 150);
      assert.deepEqual(await localSecret(file), { secret: written, created: false });
      assert.equal((await readFile(file, "utf8")).trim(), written);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the gateway and the engine's launcher read the same token, from the environment first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gateway-secret-"));
    try {
      const launcher = await internalToken({}, dir);
      const config = await loadConfig({ GATEWAY_SESSION_SECRET: SECRETS.GATEWAY_SESSION_SECRET }, dir);
      assert.equal(config.engineToken, launcher.token);
      assert.match(launcher.from, /internal-token, created now$/);
      assert.deepEqual(await internalToken({ COMMERCE_INTERNAL_TOKEN: "from-the-environment-0123456789abcdef" }, dir), {
        token: "from-the-environment-0123456789abcdef", from: "COMMERCE_INTERNAL_TOKEN",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function cleanEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GATEWAY_") && !["COMMERCE_INTERNAL_TOKEN", "ENGINE_URL", "NODE_ENV"].includes(name)) env[name] = value;
  }
  return { ...env, ...extra };
}

const MAIN = join(import.meta.dirname, "..", "src", "node", "main.ts");

describe("npm run gateway", () => {
  test("refuses to start in another mode: exit code 1, and the reason in its log", async () => {
    const child = spawn(process.execPath, [MAIN], { env: cleanEnvironment({ ...SECRETS, GATEWAY_AUTH: "oidc" }), windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 1);
    const lines = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, string>);
    assert.equal(lines.at(-1)?.["msg"], "refusing to start");
    assert.match(lines.at(-1)?.["error"] ?? "", /OpenID Connect/);
  });

  test("starts in demonstration mode, says so before anything else, and answers its health check", async () => {
    await assertPortsFree([PORTS.engine, PORTS.internal, PORTS.public]);
    const engine = new FakeEngine({ clock: new TestClock().now });
    await engine.start();
    const gateway = await startProcess({ ...SECRETS, COMMERCE_INTERNAL_TOKEN: FAKE_TOKEN, ENGINE_URL: engine.url });
    try {
      const lines = await gateway.listening;
      assert.equal(lines[0]?.["level"], "warn");
      assert.match(String(lines[0]?.["msg"]), /^DEMONSTRATION MODE: .* is not authentication$/);
      assert.match(String(lines[0]?.["realDeploymentNeeds"]), /OpenID Connect/);
      assert.equal(lines.find((line) => line["msg"] === "engine")?.["health"], "SERVING");
      const health = await get(`http://127.0.0.1:${PORTS.internal}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(JSON.parse(health.body), { status: "ok", endpoint: "internal", engine: "SERVING", mode: "demonstration" });
      // No origin is configured: a page of any other origin is refused.
      const fromPage = await get(`http://127.0.0.1:${PORTS.public}/graphql?query=%7B__typename%7D`, { origin: "http://localhost:4632", "apollo-require-preflight": "true" });
      assert.equal(fromPage.status, 403);
      // The secrets never reach the log.
      for (const secret of [FAKE_TOKEN, SECRETS.GATEWAY_SESSION_SECRET]) assert.ok(!gateway.output().includes(secret));
      // A request target that is no URL is a 400, and the process stays up.
      const malformed = await new Promise<string>((resolve, reject) => {
        let answer = "";
        const socket = connect(PORTS.public, "127.0.0.1", () => socket.write("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
        socket.setEncoding("latin1");
        socket.on("data", (chunk: string) => (answer += chunk));
        socket.on("end", () => resolve(answer));
        socket.on("error", reject);
      });
      assert.match(malformed, /^HTTP\/1\.1 400 /);
      assert.equal((await get(`http://127.0.0.1:${PORTS.internal}/health`)).status, 200);
      assert.equal(gateway.running(), true);
    } finally {
      await gateway.stop();
      await engine.stop();
    }
    await assertPortsFree([PORTS.engine, PORTS.internal, PORTS.public]);
  });

  test("starts without the engine, says it is unreachable, and its health check says so", async () => {
    await assertPortsFree([PORTS.engine, PORTS.internal, PORTS.public]);
    const gateway = await startProcess({ ...SECRETS, ENGINE_URL: `http://127.0.0.1:${PORTS.engine}` });
    try {
      const lines = await gateway.listening;
      const engine = lines.find((line) => line["msg"] === "engine");
      assert.deepEqual({ level: engine?.["level"], health: engine?.["health"] }, { level: "warn", health: "UNREACHABLE" });
      const health = await get(`http://127.0.0.1:${PORTS.public}/health`);
      assert.equal(health.status, 503);
      assert.equal(JSON.parse(health.body).engine, "UNREACHABLE");
    } finally {
      await gateway.stop();
    }
  });

  test("does not start on a port another process holds, and says which", async () => {
    await assertPortsFree([PORTS.internal, PORTS.public]);
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(PORTS.internal, "0.0.0.0", resolve));
    try {
      const gateway = await startProcess({ ...SECRETS });
      const code = await gateway.exited;
      assert.equal(code, 1);
      const last = gateway.lines().at(-1);
      assert.equal(last?.["msg"], "could not start");
      assert.match(String(last?.["error"]), new RegExp(`port ${PORTS.internal}, needed for the gateway's internal API, is taken by`));
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

/** `npm run gateway`'s entry point as a child process on the tests' ports, its log lines read as they come. */
async function startProcess(env: Record<string, string>) {
  const ports = { GATEWAY_INTERNAL_PORT: String(PORTS.internal), GATEWAY_PUBLIC_PORT: String(PORTS.public) };
  const child = spawn(process.execPath, [MAIN], { env: cleanEnvironment({ ...ports, ...env }), windowsHide: true });
  const lines: Array<Record<string, unknown>> = [];
  let raw = "";
  let pending = "";
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const listening = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "listening" line in 20 s: ${raw}`)), 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      pending += chunk.toString("utf8");
      const complete = pending.split("\n");
      pending = complete.pop() ?? "";
      for (const line of complete) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        lines.push(entry);
        if (entry["msg"] === "listening") {
          clearTimeout(timer);
          resolve(lines);
        }
      }
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`the gateway exited with ${code}: ${raw}`));
    });
  });
  listening.catch(() => {});
  return {
    listening,
    exited,
    lines: () => lines,
    output: () => raw,
    running: () => child.exitCode === null && child.signalCode === null,
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, { agent: false, headers }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject).end();
  });
}
