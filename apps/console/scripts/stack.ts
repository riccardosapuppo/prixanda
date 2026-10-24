// The whole system the console stands on, started in order and stopped in
// reverse: PostgreSQL with the migrations and the small generated data, the
// engine (Python, gRPC), the gateway (GraphQL) and the console itself. Two
// uses:
//
//   npm run console:stack        for working on the console: the development
//                                database in .data/postgres, the engine, the
//                                gateway, and `next dev` on 127.0.0.1:4631.
//                                Ctrl+C stops everything but the database.
//   startStack() from e2e/run.ts for the end-to-end tests: a throwaway
//                                database cloned from the check's template,
//                                and the console's static build served as it
//                                would be in production.
//
// Ports come from the environment, as for the other tools: DEV_POSTGRES_PORT,
// ENGINE_URL, GATEWAY_INTERNAL_PORT, GATEWAY_PUBLIC_PORT, CONSOLE_PORT. Each
// is asked to the system before use (rule 132).
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { flyway } from "../../../tools/lib/flyway.ts";
import { internalToken } from "../../../tools/lib/internal-token.ts";
import { commerceDir, dataDir, PORTS, repoRoot, venvPython } from "../../../tools/lib/paths.ts";
import { assertFree } from "../../../tools/lib/ports.ts";
import { type Cluster, createDatabase, startCluster } from "../../../tools/lib/postgres.ts";
import { run } from "../../../tools/lib/run.ts";

export const appDir = join(repoRoot, "apps", "console");

export const STACK_PORTS = {
  gatewayInternal: Number(process.env["GATEWAY_INTERNAL_PORT"] || 4621),
  gatewayPublic: Number(process.env["GATEWAY_PUBLIC_PORT"] || 4622),
  console: Number(process.env["CONSOLE_PORT"] || 4631),
} as const;

const say = (line: string) => console.log(`[stack] ${line}`);

export type Stack = {
  readonly consoleUrl: string;
  readonly gatewayUrl: string;
  readonly engineUrl: string;
  readonly logs: () => string;
  stop(): Promise<void>;
};

/** Waits until a check passes, or fails with what it last saw. */
async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`${what} did not come up within ${Math.round(timeoutMs / 1000)} s`);
}

async function listening(port: number): Promise<boolean> {
  const { createConnection } = await import("node:net");
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

/** Stops a child and everything it started (next dev starts workers of its own). */
async function stopChild(child: ChildProcess | null, gentle?: () => void): Promise<void> {
  if (child === null || child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  gentle?.();
  const timer = setTimeout(() => {
    if (process.platform === "win32") void run("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else child.kill("SIGKILL");
  }, gentle ? 12_000 : 0);
  if (!gentle && process.platform !== "win32") child.kill("SIGTERM");
  await exited;
  clearTimeout(timer);
}

function collect(child: ChildProcess, name: string, sink: string[], echo: boolean): void {
  const take = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    sink.push(...text.split(/\r?\n/).filter(Boolean).map((line) => `[${name}] ${line}`));
    if (sink.length > 4000) sink.splice(0, sink.length - 4000);
    if (echo) process.stdout.write(text.split(/\r?\n/).filter(Boolean).map((line) => `[${name}] ${line}\n`).join(""));
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

/** A static file server for a build (the console's export, Storybook's): directories answer with their index.html. */
export async function serveStatic(root: string, port: number): Promise<{ url: string; close(): Promise<void> }> {
  const base = resolve(root);
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://static.invalid").pathname);
      let file = normalize(join(base, path));
      if (!file.startsWith(base)) {
        response.writeHead(403).end();
        return;
      }
      try {
        if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      } catch {
        // Next's export writes /campaigns/ as campaigns/index.html (trailingSlash).
        if (existsSync(`${file}.html`)) file = `${file}.html`;
      }
      try {
        const body = await readFile(file);
        response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        response.end(body);
      } catch {
        const missing = join(base, "404.html");
        response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        response.end(existsSync(missing) ? await readFile(missing) : "Not found");
      }
    })();
  });
  await assertFree(port, `the static server of ${root.split(sep).slice(-2).join("/")}`);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done());
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}

export type StackOptions = {
  /** The database: a running cluster and the name of a database in it that has the migrations. */
  readonly cluster: Cluster;
  readonly database: string;
  /** Load the small generated data (seed 7) when the database has no people. */
  readonly seed: boolean;
  readonly enginePort: number;
  /** "static": serve apps/console/out (built beforehand); "dev": run next dev. */
  readonly console: "static" | "dev";
  readonly echo?: boolean;
  /**
   * A fault armed in one launch step, for the end-to-end tests: the engine
   * then runs from its own fault-injection launcher
   * (services/commerce/tests/faults/engine_with_faults.py) on the machine's
   * time, and the first launch to reach that step has the step's database
   * connection cut inside its transaction, once.
   */
  readonly launchFault?: { readonly step: "check" | "prepare" | "publish" | "notify" | "verify"; readonly kind: "cut" };
  /** Seconds between the engine's passes of its jobs (launches, outbox); the engine's own default otherwise. */
  readonly activationIntervalSeconds?: number;
};

export async function startStack(options: StackOptions): Promise<Stack> {
  const logs: string[] = [];
  const echo = options.echo ?? false;
  const children: { engine: ChildProcess | null; gateway: ChildProcess | null; next: ChildProcess | null } = { engine: null, gateway: null, next: null };
  let staticServer: { close(): Promise<void> } | null = null;
  const consoleOrigin = `http://127.0.0.1:${STACK_PORTS.console}`;
  const engineUrl = `http://127.0.0.1:${options.enginePort}`;
  const gatewayUrl = `http://127.0.0.1:${STACK_PORTS.gatewayInternal}/graphql`;

  const stop = async () => {
    await stopChild(children.next);
    await staticServer?.close();
    await stopChild(children.gateway);
    await stopChild(children.engine, () => children.engine?.stdin?.end());
  };

  try {
    const people = await options.cluster.sql<{ n: number }>(options.database, "select count(*)::int as n from person");
    if (people[0]?.n === 0) {
      if (!options.seed) throw new Error(`the database ${options.database} has no data`);
      say("loading the small generated data, seed 7");
      const generated = await run(venvPython, ["-m", "commerce.generate", "--url", options.cluster.url(options.database, "owner"), "--size", "small", "--seed", "7"], {
        cwd: commerceDir, env: { ...process.env, PYTHONPATH: join(commerceDir, "src") },
      });
      if (generated.code !== 0) throw new Error(`the data generator failed:\n${generated.output.slice(-2000)}`);
    }

    const { token } = await internalToken();
    for (const [port, what] of [[options.enginePort, "the engine"], [STACK_PORTS.gatewayInternal, "the gateway's console API"], [STACK_PORTS.gatewayPublic, "the gateway's site API"], [STACK_PORTS.console, "the console"]] as const) {
      await assertFree(port, what);
    }

    const fault = options.launchFault;
    // The fault launcher's clock starts at this whole second and runs with the machine's.
    const wall = Math.floor(Date.now() / 1000);
    say(`engine on ${engineUrl}${fault ? `, with a fault armed: ${fault.kind} in the ${fault.step} step of the first launch` : ""}`);
    children.engine = spawn(venvPython, fault ? [join(commerceDir, "tests", "faults", "engine_with_faults.py")] : ["-m", "commerce.server"], {
      cwd: commerceDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONPATH: join(commerceDir, "src"),
        COMMERCE_DATABASE_URL: options.cluster.url(options.database, "app"),
        COMMERCE_INTERNAL_TOKEN: token,
        COMMERCE_ENGINE_HOST: "127.0.0.1",
        COMMERCE_ENGINE_PORT: String(options.enginePort),
        COMMERCE_STOP_ON_STDIN_CLOSE: "1",
        ...(options.activationIntervalSeconds !== undefined ? { COMMERCE_ACTIVATION_INTERVAL_SECONDS: String(options.activationIntervalSeconds) } : {}),
        ...(fault ? { FAULT_STEP: fault.step, FAULT_KIND: fault.kind, FAULT_CLOCK_BASE: new Date(wall * 1000).toISOString().replace(".000Z", "Z"), FAULT_CLOCK_WALL: String(wall) } : {}),
      },
    });
    collect(children.engine, "engine", logs, echo);
    await waitFor("the engine", () => listening(options.enginePort), 60_000);

    say(`gateway on ${gatewayUrl}, accepting the console from ${consoleOrigin}`);
    children.gateway = spawn(process.execPath, [join(repoRoot, "services", "gateway", "src", "node", "main.ts")], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ENGINE_URL: engineUrl,
        COMMERCE_INTERNAL_TOKEN: token,
        GATEWAY_INTERNAL_PORT: String(STACK_PORTS.gatewayInternal),
        GATEWAY_PUBLIC_PORT: String(STACK_PORTS.gatewayPublic),
        GATEWAY_CONSOLE_ORIGINS: `${consoleOrigin},http://localhost:${STACK_PORTS.console}`,
        GATEWAY_SESSION_SECRET: process.env["GATEWAY_SESSION_SECRET"] ?? randomBytes(32).toString("hex"),
      },
    });
    collect(children.gateway, "gateway", logs, echo);
    await waitFor("the gateway with the engine behind it", async () => {
      const response = await fetch(`http://127.0.0.1:${STACK_PORTS.gatewayInternal}/health`);
      return response.status === 200;
    }, 60_000);

    if (options.console === "static") {
      const out = join(appDir, "out");
      if (!existsSync(join(out, "index.html"))) throw new Error("apps/console/out has no build: npm run build -w console first");
      staticServer = await serveStatic(out, STACK_PORTS.console);
      say(`console (static build) on ${consoleOrigin}`);
    } else {
      children.next = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "dev", "--hostname", "127.0.0.1", "--port", String(STACK_PORTS.console)], {
        cwd: appDir,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, NEXT_PUBLIC_GATEWAY_URL: gatewayUrl, NEXT_TELEMETRY_DISABLED: "1" },
      });
      collect(children.next, "console", logs, true);
      await waitFor("next dev", () => listening(STACK_PORTS.console), 120_000);
      say(`console (next dev) on ${consoleOrigin}`);
    }
    return { consoleUrl: consoleOrigin, gatewayUrl, engineUrl, logs: () => logs.join("\n"), stop };
  } catch (error) {
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- last lines ---\n${logs.slice(-40).join("\n")}`);
  }
}

// npm run console:stack
if (process.argv[1] && resolve(process.argv[1]) === resolve(appDir, "scripts", "stack.ts")) {
  const DATABASE = "commerce";
  const cluster = await startCluster({ dataDir: join(dataDir, "postgres"), port: PORTS.postgresDev, ephemeral: false });
  const found = await cluster.sql<{ n: number }>("postgres", "select count(*)::int as n from pg_database where datname = $1", [DATABASE]);
  if (found[0]?.n !== 1) await createDatabase(cluster, DATABASE);
  const migrated = await flyway("migrate", { port: cluster.port, database: DATABASE, user: cluster.owner.user, password: cluster.owner.password });
  if (migrated.code !== 0) {
    console.log(migrated.output);
    process.exitCode = 1;
  } else {
    const stack = await startStack({ cluster, database: DATABASE, seed: true, enginePort: PORTS.engine, console: "dev", echo: true });
    say(`ready: open ${stack.consoleUrl} (Ctrl+C stops the console, the gateway and the engine; npm run db -- stop stops the database)`);
    process.once("SIGINT", () => void stack.stop().then(() => say("stopped")));
  }
}
