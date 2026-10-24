// The console's end-to-end tests on the whole system, in one command:
//
//   node apps/console/e2e/run.ts            a throwaway PostgreSQL 18 on
//                                           CHECK_POSTGRES_PORT, the migrations,
//                                           the small generated data, the
//                                           engine, the gateway, the console's
//                                           static build, then Playwright.
//
// npm run check runs the same (suite console-e2e) on the check's own
// database. Everything started here is stopped here, the database too.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { flyway } from "../../../tools/lib/flyway.ts";
import { dataDir, PORTS, repoRoot } from "../../../tools/lib/paths.ts";
import { type Cluster, createDatabase, startCluster } from "../../../tools/lib/postgres.ts";
import { run } from "../../../tools/lib/run.ts";
import { type Built, buildStatic } from "../scripts/build.ts";
import { appDir, STACK_PORTS, startStack } from "../scripts/stack.ts";

const say = (line: string) => console.log(`[e2e] ${line}`);
export const GATEWAY_URL = `http://127.0.0.1:${STACK_PORTS.gatewayInternal}/graphql`;

/** Builds the console's static export for a gateway address (scripts/build.ts); returns how many pages it wrote. */
export async function buildConsole(gatewayUrl: string): Promise<Built> {
  return buildStatic({ NEXT_PUBLIC_GATEWAY_URL: gatewayUrl });
}

export type E2eOutcome = { readonly tests: number; readonly failures: number; readonly skipped: number; readonly code: number | null; readonly output: string };

/** The stack on a migrated database, then Playwright; the JUnit report goes to reports/console-e2e.xml. */
export async function runEndToEnd(cluster: Cluster, database: string, reports: string): Promise<E2eOutcome> {
  // The launch test needs a launch that meets a fault: the publish step's connection is cut once, and the step is tried again.
  const stack = await startStack({ cluster, database, seed: true, enginePort: PORTS.engineCheck, console: "static", launchFault: { step: "publish", kind: "cut" }, activationIntervalSeconds: 0.5 });
  try {
    const report = join(reports, "console-e2e.xml");
    await rm(report, { force: true });
    const tested = await run(process.execPath, [join(repoRoot, "node_modules", "@playwright", "test", "cli.js"), "test", "--config", join(appDir, "e2e", "playwright.config.ts")], {
      cwd: appDir,
      env: {
        ...process.env,
        CONSOLE_URL: stack.consoleUrl,
        GATEWAY_URL: stack.gatewayUrl,
        E2E_REPORTS: reports,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
      echo: true,
    });
    if (!existsSync(report)) return { tests: 0, failures: 0, skipped: 0, code: tested.code, output: `${tested.output}\n${stack.logs()}` };
    const xml = await readFile(report, "utf8");
    const tests = [...xml.matchAll(/<testcase\b/g)].length;
    const failures = [...xml.matchAll(/<failure\b/g)].length + [...xml.matchAll(/<error\b/g)].length;
    const skipped = [...xml.matchAll(/<skipped\b/g)].length;
    return { tests, failures, skipped, code: tested.code, output: tested.code === 0 ? tested.output : `${tested.output}\n--- the stack's last lines ---\n${stack.logs().split("\n").slice(-60).join("\n")}` };
  } finally {
    await stack.stop();
  }
}

// node apps/console/e2e/run.ts
if (process.argv[1] && resolve(process.argv[1]) === resolve(appDir, "e2e", "run.ts")) {
  const reports = join(repoRoot, "reports");
  await mkdir(reports, { recursive: true });
  say(`building the console for ${GATEWAY_URL}`);
  const built = await buildConsole(GATEWAY_URL);
  if (built.code !== 0) {
    console.log(built.output);
    process.exitCode = 1;
  } else {
    say(`a throwaway PostgreSQL 18 on 127.0.0.1:${PORTS.postgresCheck}`);
    const cluster = await startCluster({ dataDir: join(dataDir, "console-e2e"), port: PORTS.postgresCheck, ephemeral: true, fast: true });
    try {
      await createDatabase(cluster, "console_e2e");
      const migrated = await flyway("migrate", { port: cluster.port, database: "console_e2e", user: cluster.owner.user, password: cluster.owner.password });
      if (migrated.code !== 0) throw new Error(migrated.output.slice(-2000));
      const outcome = await runEndToEnd(cluster, "console_e2e", reports);
      say(`${outcome.tests} tests, ${outcome.failures} failed, ${outcome.skipped} skipped`);
      process.exitCode = outcome.code === 0 && outcome.failures === 0 && outcome.tests > 0 ? 0 : 1;
    } finally {
      await cluster.stop();
    }
  }
}
