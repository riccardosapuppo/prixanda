// npm start: the whole system on this machine with one command, to try it by
// hand. In order: the setup, when something it installs is missing (npm run
// setup); the development database in .data/postgres, its migrations, and the
// first time the small generated data, up to today; then the engine, the
// gateway with both APIs and the console (apps/console/scripts/stack.ts), and
// the site, each on the project's port, asked to the system before use. It
// ends by printing the two addresses to open and who can sign in. Ctrl+C
// stops everything in the reverse order: the site, the console, the gateway,
// the engine, and the database's server if this command started it; the
// data stays in .data, for the next start.
//
//   npm start
//   node tools/start.ts --cluster <folder> --database <name> --stop-on-stdin-close
//       the check's own use (suite start): a cluster that already runs, a
//       database of its own in it, and a stop when standard input closes
//
// Ports: DEV_POSTGRES_PORT (4601), ENGINE_URL (4611), GATEWAY_INTERNAL_PORT
// and GATEWAY_PUBLIC_PORT (4621, 4622), CONSOLE_PORT (4631), SITE_PORT (4632).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { STACK_PORTS, startStack } from "../apps/console/scripts/stack.ts";
import { flyway, flywayHome } from "./lib/flyway.ts";
import { commerceDir, dataDir, PORTS, repoRoot, venvPython } from "./lib/paths.ts";
import { assertFree } from "./lib/ports.ts";
import { createDatabase, isRunning, startCluster, stopIfRunning } from "./lib/postgres.ts";
import { run } from "./lib/run.ts";

const say = (line: string) => console.log(`[start] ${line}`);
const SITE_PORT = Number(process.env["SITE_PORT"] ?? 4632);
const siteDir = join(repoRoot, "apps", "site");

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const clusterDir = option("--cluster") ?? join(dataDir, "postgres");
const DATABASE = option("--database") ?? "commerce";
const stopOnStdinClose = args.includes("--stop-on-stdin-close");

/** What the setup would install and is not there; null when nothing is missing. */
function missingSetup(): string | null {
  const home = flywayHome();
  if (!existsSync(home.java) || !existsSync(home.lib)) return "Flyway and its Java runtime";
  if (!existsSync(venvPython)) return "the engine's Python environment";
  return null;
}

function inherit(command: string, commandArgs: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: repoRoot, stdio: "inherit", windowsHide: true });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** The machine's date, as the data's last day: today, where this runs. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} did not come up within ${Math.round(timeoutMs / 1000)} s`);
}

/** Stops a process and the ones it started (Next.js starts workers of its own). */
async function stopTree(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") await run("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill("SIGTERM");
  const late = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(late);
}

async function main(): Promise<number> {
  if (!existsSync(join(repoRoot, "node_modules", "next"))) {
    say("the packages are not installed: npm ci first");
    return 1;
  }
  const missing = missingSetup();
  if (missing !== null) {
    say(`${missing} is not there: npm run setup`);
    if ((await inherit(process.execPath, [join(repoRoot, "tools", "setup.ts")])) !== 0) return 1;
  }

  // The database: the development cluster, or the one the check gave.
  const wasRunning = await isRunning(clusterDir);
  const cluster = await startCluster({ dataDir: clusterDir, port: PORTS.postgresDev, ephemeral: false });
  const stopDatabase = async () => {
    if (!wasRunning && (await stopIfRunning(clusterDir))) say(`the database's server stopped; its data stays in ${clusterDir}`);
  };
  try {
    const found = await cluster.sql<{ n: number }>("postgres", "select count(*)::int as n from pg_database where datname = $1", [DATABASE]);
    if (found[0]?.n !== 1) await createDatabase(cluster, DATABASE);
    const migrated = await flyway("migrate", { port: cluster.port, database: DATABASE, user: cluster.owner.user, password: cluster.owner.password });
    if (migrated.code !== 0) {
      console.log(migrated.output);
      say("the migrations failed: nothing else starts");
      await stopDatabase();
      return 1;
    }
    const people = await cluster.sql<{ n: number }>(DATABASE, "select count(*)::int as n from person");
    if (people[0]?.n === 0) {
      const until = today();
      say(`loading the small generated data, seed 7, up to ${until} (the first start only)`);
      const generated = await run(venvPython, ["-m", "commerce.generate", "--url", cluster.url(DATABASE, "owner"), "--size", "small",
        "--seed", "7", "--until", until], { cwd: commerceDir, env: { ...process.env, PYTHONPATH: join(commerceDir, "src") } });
      if (generated.code !== 0) {
        console.log(generated.output.slice(-3000));
        await stopDatabase();
        return 1;
      }
    }
  } catch (error) {
    await stopDatabase();
    throw error;
  }

  // The site's origin is the one the gateway's public API accepts.
  const siteOrigin = `http://127.0.0.1:${SITE_PORT}`;
  process.env["GATEWAY_SITE_ORIGINS"] = `${siteOrigin},http://localhost:${SITE_PORT}`;
  const publicApi = `http://127.0.0.1:${STACK_PORTS.gatewayPublic}/graphql`;
  let stack: Awaited<ReturnType<typeof startStack>> | null = null;
  let site: ChildProcess | null = null;
  const stop = async () => {
    await stopTree(site);
    await stack?.stop();
    await stopDatabase();
  };
  try {
    await assertFree(SITE_PORT, "the site");
    stack = await startStack({ cluster, database: DATABASE, seed: false, enginePort: PORTS.engine, console: "dev" });
    site = spawn(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "dev", "--hostname", "127.0.0.1", "--port", String(SITE_PORT)], {
      cwd: siteDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NEXT_PUBLIC_SITE_API: publicApi, NEXT_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
    });
    const echo = (chunk: Buffer) => process.stdout.write(chunk.toString("utf8").split(/\r?\n/).filter(Boolean).map((line) => `[site] ${line}\n`).join(""));
    site.stdout?.on("data", echo);
    site.stderr?.on("data", echo);
    await waitFor("the site's development server", () => listening(SITE_PORT), 120_000);
  } catch (error) {
    await stop();
    throw error;
  }

  const team = await cluster.sql<{ id: string; label: string; roles: string }>(DATABASE,
    "select p.id, p.label, string_agg(r.role, ', ' order by r.role) as roles from person p join person_role r on r.person_id = p.id "
    + "group by p.id, p.label order by min(array_position(array['marketing', 'commercial_lead', 'finance', 'catalog_manager', "
    + "'on_call', 'auditor'], r.role)), p.id");
  const listeners = await cluster.sql<{ title: string }>(DATABASE, "select title from demo_listener order by position");
  say("ready");
  console.log("");
  console.log(`  The console   ${stack.consoleUrl}`);
  console.log("                sign in as one of the team, by role:");
  for (const person of team) console.log(`                  ${person.label} (${person.id}): ${person.roles}`);
  console.log(`  The site      ${siteOrigin}`);
  console.log(`                enter as one of the demo's listeners, invented people with simulated data${listeners.length ? ":" : ""}`);
  for (const listener of listeners) console.log(`                  ${listener.title}`);
  console.log("");
  console.log("  The first visit of each page waits for Next.js to compile it. Ctrl+C stops everything.");
  console.log("");

  let stopping: Promise<void> | null = null;
  const stopOnce = (why: string) => {
    stopping ??= (async () => {
      say(`stopping (${why}): the site, the console, the gateway, the engine${wasRunning ? "" : ", the database's server"}`);
      await stop();
      say("stopped");
    })();
    return stopping;
  };
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.once(signal, () => void stopOnce(signal).then(resolve));
    if (stopOnStdinClose) {
      process.stdin.resume();
      process.stdin.once("end", () => void stopOnce("standard input closed").then(resolve));
    }
  });
  return 0;
}

process.exitCode = await main();
