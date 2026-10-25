// The whole system for the site's end-to-end test, started on the check's
// ports and stopped afterwards, leaving nothing behind:
//
//   PostgreSQL 18    a throwaway cluster, the migrations applied by Flyway,
//                    the small generated data (seed 7) until the day the
//                    engine's clock starts (data.ts)
//   the engine       the real server, on a clock the test moves, with the
//                    simulated payment provider, which the test can keep
//                    from answering (services/commerce/tests/clocked_server.py)
//   the gateway      the real one, both APIs, the site's origin allowed
//   the site         its static build (apps/site/out), served as any host would
//
// Ports, each asked to the system before use: CHECK_POSTGRES_PORT,
// CHECK_ENGINE_PORT, CHECK_GATEWAY_INTERNAL_PORT, CHECK_GATEWAY_PUBLIC_PORT
// and CHECK_SITE_PORT (4602, 4612, 4621, 4622, 4632 when unset).
//
// Inside npm run check, the check's own cluster is already running: the
// check prepares a database with the data and hands its URL in
// SITE_E2E_DATABASE_URL, and the stack starts no cluster of its own.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flyway } from "../../../../tools/lib/flyway.ts";
import { commerceDir, dataDir, PORTS, repoRoot, venvPython } from "../../../../tools/lib/paths.ts";
import { assertFree } from "../../../../tools/lib/ports.ts";
import { type Cluster, createDatabase, startCluster } from "../../../../tools/lib/postgres.ts";
import { run } from "../../../../tools/lib/run.ts";
import { serveStatic } from "../../scripts/serve.ts";
import { DATA_UNTIL, GENERATOR_ARGS } from "./data.ts";

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const clockedServer = join(commerceDir, "tests", "clocked_server.py");

export const STACK_PORTS = {
  postgres: PORTS.postgresCheck,
  engine: PORTS.engineCheck,
  internal: PORTS.gatewayCheckInternal,
  public: PORTS.gatewayCheckPublic,
  site: Number(process.env["CHECK_SITE_PORT"] ?? 4632),
} as const;

const preparedDatabase = process.env["SITE_E2E_DATABASE_URL"] ?? "";

export const SITE_URL = `http://127.0.0.1:${STACK_PORTS.site}`;
export const PUBLIC_API = `http://127.0.0.1:${STACK_PORTS.public}/graphql`;
export const CONSOLE_API = `http://127.0.0.1:${STACK_PORTS.internal}/graphql`;

type LogLine = Record<string, unknown>;

export type Engine = {
  readonly log: LogLine[];
  /** Moves the engine's clock; resolves when the engine says it has. */
  at(instant: string): Promise<void>;
  /** Keeps the payment provider from answering: the payments asked for from now on stay pending. */
  holdPayments(): Promise<void>;
  /** Lets the provider answer the payments it holds, and the ones after. */
  answerPayments(): Promise<void>;
};

export type Stack = {
  readonly engine: Engine;
  readonly gatewayLog: LogLine[];
  stop(): Promise<{ engineExit: number | null }>;
};

const say = (line: string) => console.log(`[site e2e] ${line}`);

function lines(onLine: (line: string) => void): (chunk: string) => void {
  let rest = "";
  return (chunk) => {
    rest += chunk;
    const parts = rest.split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) if (part.trim()) onLine(part.trim());
  };
}

function parse(line: string): LogLine {
  if (!line.startsWith("{")) return { raw: line };
  try {
    return JSON.parse(line) as LogLine;
  } catch {
    return { raw: line };
  }
}

async function until<T>(find: () => T | undefined, ms: number, child: ChildProcessWithoutNullStreams, what: string): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (child.exitCode !== null) throw new Error(`${what} ended with code ${child.exitCode}`);
    if (performance.now() > deadline) throw new Error(`${what} did not come up in ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The site's build must call the API this stack serves: the URL is written into it at build time. */
export async function assertBuiltFor(api: string): Promise<void> {
  const chunks = join(siteDir, "out", "_next", "static", "chunks");
  if (!existsSync(join(siteDir, "out", "index.html")) || !existsSync(chunks)) {
    throw new Error("apps/site/out is missing: build the site first (npm run e2e -w site builds it)");
  }
  for (const name of await readdir(chunks)) {
    if (name.endsWith(".js") && (await readFile(join(chunks, name), "utf8")).includes(api)) return;
  }
  throw new Error(`apps/site/out was built for another API than ${api}: build it again for this one (npm run e2e -w site)`);
}

function startEngine(databaseUrl: string, token: string, startAt: string): { child: ChildProcessWithoutNullStreams; engine: Engine } {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("COMMERCE_")) delete env[name];
  const child = spawn(venvPython, [clockedServer, startAt], {
    cwd: commerceDir,
    windowsHide: true,
    env: {
      ...env,
      PYTHONPATH: join(commerceDir, "src"),
      PYTHONIOENCODING: "utf-8",
      COMMERCE_DATABASE_URL: databaseUrl,
      COMMERCE_INTERNAL_TOKEN: token,
      COMMERCE_ENGINE_HOST: "127.0.0.1",
      COMMERCE_ENGINE_PORT: String(STACK_PORTS.engine),
      COMMERCE_ACTIVATION_INTERVAL_SECONDS: "0.5",
      COMMERCE_HEALTH_INTERVAL_SECONDS: "1",
      COMMERCE_SHUTDOWN_GRACE_SECONDS: "2",
    },
  });
  const log: LogLine[] = [];
  const waiting = new Map<string, () => void>();
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", lines((line) => log.push(parse(line))));
  child.stdout.on("data", lines((line) => {
    const said = /^clock (\S+)$/.exec(line)?.[1] ?? (/^payments (held|answering)$/.test(line) ? line : undefined);
    if (said) waiting.get(said)?.();
  }));
  /** Sends a command to the launcher and waits for the line that acknowledges it. */
  const command = (sent: string, acknowledged: string, what: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(acknowledged);
      reject(new Error(`the engine did not ${what}`));
    }, 10_000);
    waiting.set(acknowledged, () => {
      clearTimeout(timer);
      waiting.delete(acknowledged);
      resolve();
    });
    child.stdin.write(`${sent}\n`);
  });
  return {
    child,
    engine: {
      log,
      at: (instant) => command(`at ${instant}`, instant, `move its clock to ${instant}`),
      holdPayments: () => command("payments hold", "payments held", "hold its payment provider"),
      answerPayments: () => command("payments answer", "payments answering", "let its payment provider answer"),
    },
  };
}

function startGateway(token: string): { child: ChildProcessWithoutNullStreams; log: LogLine[] } {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GATEWAY_") || name.startsWith("COMMERCE_")) delete env[name];
  const child = spawn(process.execPath, [join(repoRoot, "services", "gateway", "src", "node", "main.ts")], {
    cwd: repoRoot,
    windowsHide: true,
    env: {
      ...env,
      ENGINE_URL: `http://127.0.0.1:${STACK_PORTS.engine}`,
      COMMERCE_INTERNAL_TOKEN: token,
      GATEWAY_SESSION_SECRET: randomBytes(32).toString("hex"),
      GATEWAY_INTERNAL_PORT: String(STACK_PORTS.internal),
      GATEWAY_PUBLIC_PORT: String(STACK_PORTS.public),
      GATEWAY_SITE_ORIGINS: SITE_URL,
      // One address drives every page of the run, the layout sweep included:
      // the per-address limit of a real deployment would count them as one visitor.
      GATEWAY_RATE_PER_ADDRESS: "3000/60",
      GATEWAY_RATE_PER_SESSION: "1200/60",
    },
  });
  const log: LogLine[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", lines((line) => log.push(parse(line))));
  child.stderr.on("data", lines((line) => log.push(parse(line))));
  return { child, log };
}

async function stopChild(child: ChildProcessWithoutNullStreams, how: "stdin" | "kill"): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  if (how === "stdin") child.stdin.end();
  else child.kill();
  const timer = setTimeout(() => child.kill(), 15_000);
  const code = await exited;
  clearTimeout(timer);
  return code;
}

/** Starts everything; the engine's clock starts at `startAt`, on the day the data runs until. */
export async function startStack(startAt: string): Promise<Stack> {
  if (!startAt.startsWith(`${DATA_UNTIL}T`)) throw new Error(`the engine's clock must start on ${DATA_UNTIL}, the day the data runs until, not at ${startAt}`);
  if (!existsSync(venvPython)) throw new Error("no Python environment for the engine: npm run setup");
  if (!existsSync(clockedServer)) throw new Error(`the engine's clocked launcher is missing: ${clockedServer}`);
  await assertBuiltFor(PUBLIC_API);
  for (const [what, port] of Object.entries(STACK_PORTS)) {
    if (what === "postgres" && preparedDatabase) continue;
    await assertFree(port, `the site's end-to-end test (${what})`);
  }

  let cluster: Cluster | null = null;
  let engineChild: ChildProcessWithoutNullStreams | null = null;
  let gatewayChild: ChildProcessWithoutNullStreams | null = null;
  let site: Server | null = null;
  const stopAll = async () => {
    await new Promise<void>((resolve) => (site ? site.close(() => resolve()) : resolve()));
    if (gatewayChild) await stopChild(gatewayChild, "kill");
    const engineExit = engineChild ? await stopChild(engineChild, "stdin") : null;
    if (cluster) await cluster.stop();
    return { engineExit };
  };

  try {
    let appUrl = preparedDatabase;
    if (!appUrl) {
      say(`PostgreSQL 18 on 127.0.0.1:${STACK_PORTS.postgres}, the migrations and the small data (seed 7, until ${DATA_UNTIL})`);
      cluster = await startCluster({ dataDir: join(dataDir, "site-e2e"), port: STACK_PORTS.postgres, ephemeral: true, fast: true });
      const database = "commerce_site_e2e";
      await createDatabase(cluster, database);
      const migrated = await flyway("migrate", { port: cluster.port, database, user: cluster.owner.user, password: cluster.owner.password });
      if (migrated.code !== 0) throw new Error(`the migrations failed:\n${migrated.output.slice(-2000)}`);
      const generated = await run(venvPython, ["-m", "commerce.generate", "--url", cluster.url(database, "owner"), ...GENERATOR_ARGS], {
        cwd: commerceDir, env: { ...process.env, PYTHONPATH: join(commerceDir, "src") },
      });
      if (generated.code !== 0) throw new Error(`the generator failed:\n${generated.output.slice(-2000)}`);
      appUrl = cluster.url(database, "app");
    }

    const token = randomBytes(32).toString("hex");
    say(`the engine on 127.0.0.1:${STACK_PORTS.engine}, its clock at ${startAt}`);
    const started = startEngine(appUrl, token, startAt);
    engineChild = started.child;
    await until(() => started.engine.log.find((entry) => entry["event"] === "listening"), 60_000, started.child, "the engine");

    say(`the gateway on 127.0.0.1:${STACK_PORTS.internal} and ${STACK_PORTS.public}`);
    const gateway = startGateway(token);
    gatewayChild = gateway.child;
    await until(() => gateway.log.find((entry) => entry["msg"] === "listening"), 30_000, gateway.child, "the gateway");

    say(`the site's build on ${SITE_URL}`);
    site = await serveStatic(join(siteDir, "out"), STACK_PORTS.site);
    return { engine: started.engine, gatewayLog: gateway.log, stop: stopAll };
  } catch (error) {
    await stopAll().catch(() => undefined);
    throw error;
  }
}
