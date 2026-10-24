// npm run check: everything the repository promises, against a throwaway
// PostgreSQL 18 that the check starts for the run and removes afterwards.
//
//   npm run check                     every suite
//   npm run check -- --only pytest    some of them, by name (comma separated)
//   npm run check -- --list           the suites
//
// A suite that needs the database reads the template the migrations suite
// builds, so selecting one brings the migrations along, and a failed
// migration stops the suites after it.
//
// Each suite counts what it checked, reading what its tool wrote (pytest's
// JUnit report, Flyway's summary, the files tsc listed), and the count must
// reach the floor written here: a suite that checked nothing has not passed.
// Exits 0 when every suite passed, 1 when one failed, and 2 when none failed
// but one could not run on this machine, which is listed and never reads as
// passed.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { flyway } from "./lib/flyway.ts";
import { dataDir, migrationsDir, PORTS, repoRoot, venvPython } from "./lib/paths.ts";
import { assertFree } from "./lib/ports.ts";
import { type Cluster, createDatabase, startCluster } from "./lib/postgres.ts";
import { run } from "./lib/run.ts";

type Outcome = "passed" | "failed" | "not run";
type Result = { suite: string; outcome: Outcome; counted: string; detail: string; seconds: number };
type Suite = { name: string; what: string; needsDatabase: boolean; run(context: Context): Promise<Omit<Result, "suite" | "seconds">> };
type Context = { cluster?: Cluster };

const TEMPLATE = "commerce_template";
const reports = join(repoRoot, "reports");
const say = (line: string) => console.log(`[check] ${line}`);
const passed = (counted: string, detail = ""): Omit<Result, "suite" | "seconds"> => ({ outcome: "passed", counted, detail });
const failed = (counted: string, detail: string): Omit<Result, "suite" | "seconds"> => ({ outcome: "failed", counted, detail });
const notRun = (detail: string): Omit<Result, "suite" | "seconds"> => ({ outcome: "not run", counted: "-", detail });

// The floors: what each suite must at least have checked.
const FLOOR = { typecheckedFiles: 12, contractFiles: 30, migrations: 10, pythonTests: 492, invariants: 10, generatedSubscribers: 5_000 };
// pytest's tests by area, read from the folder each test lives in: the
// database's own rules (tests/), the rules as plain Python (domain), the
// business book's numbers (golden), every service against PostgreSQL
// (services), the calls over gRPC with a real server (e2e), and the
// properties Hypothesis generates cases for (properties).
const AREA_FLOOR: Record<string, number> = { database: 81, domain: 144, golden: 32, services: 198, e2e: 27, properties: 10 };

const SUITES: Suite[] = [
  {
    name: "typecheck",
    what: "tsc over the tools (strict; erasable syntax only, so Node runs them unbuilt)",
    needsDatabase: false,
    async run() {
      const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
      if (!existsSync(tsc)) return notRun("typescript is not installed: npm install");
      const ran = await run(process.execPath, [tsc, "-p", "tsconfig.json", "--listFiles"], { cwd: repoRoot });
      const ours = ran.output.split(/\r?\n/).filter((line) => line.replaceAll("\\", "/").includes("/tools/") && line.endsWith(".ts")
        && !line.includes("node_modules")).length;
      const errors = ran.output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line));
      if (ran.code !== 0) return failed(`${ours} files`, errors.slice(0, 8).join("\n") || ran.output.slice(0, 2000));
      if (ours < FLOOR.typecheckedFiles) return failed(`${ours} files`, `fewer than ${FLOOR.typecheckedFiles} files of tools/ were checked`);
      return passed(`${ours} files`);
    },
  },
  {
    name: "contract",
    what: "buf lint on proto/, and the committed generated code equals a fresh generation",
    needsDatabase: false,
    async run() {
      if (!existsSync(venvPython)) return notRun("no Python environment: npm run setup");
      const ran = await run(process.execPath, [join(repoRoot, "tools", "proto.ts"), "--check"], { cwd: repoRoot });
      const compared = Number(/matches the contract \((\d+) files\)/.exec(ran.output)?.[1] ?? 0);
      if (ran.code !== 0) return failed(`${compared} files`, ran.output.slice(-3000));
      if (compared < FLOOR.contractFiles) return failed(`${compared} files`, `fewer than ${FLOOR.contractFiles} generated files compared`);
      return passed(`${compared} files`);
    },
  },
  {
    name: "migrations",
    what: "Flyway applies every migration to an empty PostgreSQL 18, then validates them",
    needsDatabase: true,
    async run({ cluster }) {
      if (!cluster) return notRun("no database");
      const files = (await readdir(migrationsDir)).filter((name) => /^V\d+__\w+\.sql$/.test(name));
      const target = { port: cluster.port, database: TEMPLATE, user: cluster.owner.user, password: cluster.owner.password };
      const migrate = await flyway("migrate", target);
      const applied = Number(/Successfully applied (\d+) migrations?/.exec(migrate.output)?.[1] ?? 0);
      if (migrate.code !== 0) return failed(`${applied} of ${files.length}`, migrate.output.slice(-3000));
      if (applied !== files.length) return failed(`${applied} of ${files.length}`, "Flyway did not apply every file of db/migrations");
      if (applied < FLOOR.migrations) return failed(`${applied}`, `fewer than ${FLOOR.migrations} migrations`);
      const validate = await flyway("validate", target);
      if (validate.code !== 0 || !new RegExp(`Successfully validated ${files.length} migrations`).test(validate.output)) {
        return failed(`${applied} applied`, validate.output.slice(-3000));
      }
      return passed(`${applied} applied, ${files.length} validated`, `Flyway ${migrate.ms} ms, validate ${validate.ms} ms`);
    },
  },
  {
    name: "pytest",
    what: "the engine against PostgreSQL: the database's rules, the domain, the golden cases, every service and call with its refusals and errors, gRPC end to end, properties",
    needsDatabase: true,
    async run({ cluster }) {
      if (!cluster) return notRun("no database");
      if (!existsSync(venvPython)) return notRun("no Python environment: npm run setup");
      // The gRPC tests start the engine's server on this port, after the system says nobody listens on it.
      await assertFree(PORTS.engineCheck, "the engine's gRPC tests");
      const commerce = join(repoRoot, "services", "commerce");
      const report = join(reports, "pytest-engine.xml");
      const ran = await run(venvPython, ["-m", "pytest", "-q", "-p", "no:cacheprovider", `--junitxml=${report}`, "tests"], {
        cwd: commerce,
        env: {
          ...process.env,
          COMMERCE_TEST_ADMIN_URL: cluster.url("postgres", "owner"),
          COMMERCE_TEST_TEMPLATE: TEMPLATE,
          COMMERCE_TEST_APP_URL: cluster.url("{database}", "app").replace("%7Bdatabase%7D", "{database}"),
          COMMERCE_TEST_ENGINE_PORT: String(PORTS.engineCheck),
        },
        echo: true,
      });
      if (ran.code === 4) return notRun("pytest could not start (code 4)");
      if (!existsSync(report)) return failed("0", `pytest wrote no report (exit ${ran.code})`);
      const xml = await readFile(report, "utf8");
      const counts = junit(xml);
      const areas = junitAreas(xml);
      const byArea = Object.keys(AREA_FLOOR).map((area) => `${area} ${areas[area] ?? 0}`).join(", ");
      const counted = `${counts.tests} tests (${byArea}), ${counts.failures + counts.errors} failed, ${counts.skipped} skipped`;
      if (ran.code !== 0 || counts.failures + counts.errors > 0) return failed(counted, `pytest exited ${ran.code}`);
      if (counts.skipped > 0) return failed(counted, "a skipped test checked nothing");
      if (counts.tests < FLOOR.pythonTests) return failed(counted, `fewer than ${FLOOR.pythonTests} tests`);
      const short = Object.entries(AREA_FLOOR).filter(([area, floor]) => (areas[area] ?? 0) < floor);
      if (short.length) return failed(counted, short.map(([area, floor]) => `${area}: fewer than ${floor} tests`).join("; "));
      const unknown = Object.keys(areas).filter((area) => !(area in AREA_FLOOR));
      if (unknown.length) return failed(counted, `tests in an area with no floor: ${unknown.join(", ")}`);
      // Rule 26: a test that writes undoes what it wrote, caches included.
      const deposits = [".hypothesis", ".pytest_cache"].filter((name) => existsSync(join(commerce, name)));
      if (deposits.length) return failed(counted, `the tests left ${deposits.join(" and ")} in services/commerce`);
      return passed(counted);
    },
  },
  {
    name: "data",
    what: "the small generated data, end to end: generator, then every invariant on what it wrote",
    needsDatabase: true,
    async run({ cluster }) {
      if (!cluster) return notRun("no database");
      if (!existsSync(venvPython)) return notRun("no Python environment: npm run setup");
      const database = "commerce_data";
      await createDatabase(cluster, database, TEMPLATE);
      const commerce = join(repoRoot, "services", "commerce");
      const env = { ...process.env, PYTHONPATH: join(commerce, "src") };
      const url = cluster.url(database, "owner");
      const generated = await run(venvPython, ["-m", "commerce.generate", "--url", url, "--size", "small", "--seed", "7"], { cwd: commerce, env });
      if (generated.code !== 0) return failed("-", generated.output.slice(-3000));
      const summary = JSON.parse(generated.output) as { counts: { subscribers: number; listening_days: number } };
      const invariants = await run(venvPython, ["-m", "commerce.invariants", "--url", url], { cwd: commerce, env });
      const report = JSON.parse(invariants.output) as { checked: number; broken: number; invariants: Array<{ name: string; violations: number }> };
      const counted = `${report.checked} invariants, ${report.broken} broken; ${summary.counts.subscribers} subscribers`;
      if (invariants.code !== 0 || report.broken > 0) {
        return failed(counted, report.invariants.filter((i) => i.violations).map((i) => `${i.name}: ${i.violations}`).join("\n"));
      }
      if (report.checked < FLOOR.invariants) return failed(counted, `fewer than ${FLOOR.invariants} invariants`);
      if (summary.counts.subscribers < FLOOR.generatedSubscribers) return failed(counted, "the generator wrote fewer subscribers than the small size declares");
      return passed(counted, `${summary.counts.listening_days} listening rows`);
    },
  },
  // The gateway (stage 3). Its tests start a fake engine on 127.0.0.1:4613
  // and the gateway on 4621 and 4622, after asking the system that nobody
  // listens there; they need no database.
  {
    name: "gw-types",
    what: "tsc over the gateway (strict, erasable), then its core again with a browser's types and none of Node's",
    needsDatabase: false,
    async run() {
      const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
      if (!existsSync(tsc)) return notRun("typescript is not installed: npm install");
      const counted: string[] = [];
      for (const [config, floor] of [["tsconfig.json", GATEWAY_FLOOR.files], ["tsconfig.core.json", GATEWAY_FLOOR.coreFiles]] as const) {
        const ran = await run(process.execPath, [tsc, "-p", config, "--listFiles"], { cwd: gatewayDir });
        const ours = ran.output.split(/\r?\n/).filter((line) => line.replaceAll("\\", "/").includes("/services/gateway/") && line.endsWith(".ts")
          && !line.includes("node_modules")).length;
        counted.push(`${ours} ${config === "tsconfig.json" ? "files" : "in the core"}`);
        if (ran.code !== 0) return failed(counted.join(", "), ran.output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line)).slice(0, 8).join("\n") || ran.output.slice(0, 2000));
        if (ours < floor) return failed(counted.join(", "), `${config}: fewer than ${floor} files of the gateway were checked`);
      }
      return passed(counted.join(", "));
    },
  },
  {
    name: "gw-codegen",
    what: "the gateway's generated types and embedded schemas equal a fresh generation from schema/*.graphql",
    needsDatabase: false,
    async run() {
      const ran = await run(process.execPath, [join(repoRoot, "tools", "graphql.ts"), "--check"], { cwd: repoRoot });
      const compared = Number(/matches the schemas \((\d+) files\)/.exec(ran.output)?.[1] ?? 0);
      if (ran.code !== 0) return failed(`${compared} files`, ran.output.slice(-3000));
      if (compared < GATEWAY_FLOOR.generated) return failed(`${compared} files`, `fewer than ${GATEWAY_FLOOR.generated} generated files compared`);
      return passed(`${compared} files`);
    },
  },
  {
    name: "gw-schemas",
    what: "the contract tests of the two GraphQL schemas: the site's exposes nothing internal",
    needsDatabase: false,
    async run() {
      return nodeTests("gw-schemas", ["test/public-contract.test.ts", "test/internal-contract.test.ts"], GATEWAY_FLOOR.schemaTests);
    },
  },
  {
    name: "gw-tests",
    what: "the gateway against a fake engine over gRPC: resolvers, roles, sessions, CSRF, idempotency, request ids, limits",
    needsDatabase: false,
    async run() {
      const files = (await readdir(join(gatewayDir, "test"))).filter((name) => name.endsWith(".test.ts") && !name.includes("contract"))
        .map((name) => `test/${name}`);
      return nodeTests("gw-tests", files, GATEWAY_FLOOR.tests);
    },
  },
  {
    name: "dataloader",
    what: "engine calls for the console's list of offers with their details, without the DataLoader and with it",
    needsDatabase: false,
    async run() {
      const ran = await run(process.execPath, [join(gatewayDir, "scripts", "measure-dataloader.ts"), "--json"], { cwd: gatewayDir });
      const line = ran.output.split(/\r?\n/).find((candidate) => candidate.startsWith("{"));
      if (line === undefined) return failed("-", ran.output.slice(-3000));
      const report = JSON.parse(line) as { offers: number; without: { calls: number }; with: { calls: number }; sameAnswer: boolean };
      const counted = `${report.without.calls} calls without, ${report.with.calls} with (${report.offers} offers)`;
      if (ran.code !== 0 || !report.sameAnswer) return failed(counted, report.sameAnswer ? ran.output.slice(-2000) : "the two answers differ");
      if (report.offers < GATEWAY_FLOOR.dataloaderOffers) return failed(counted, `fewer than ${GATEWAY_FLOOR.dataloaderOffers} offers measured`);
      if (report.without.calls !== report.offers + 1 || report.with.calls !== 2) return failed(counted, "expected N + 1 calls without batching and 2 with");
      return passed(counted);
    },
  },
];

// pytest's JUnit report: the totals of its test suites.
function junit(xml: string): { tests: number; failures: number; errors: number; skipped: number } {
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/g)];
  if (suites.length === 0) throw new Error("the JUnit report holds no test suite");
  for (const [, attributes = ""] of suites) {
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[key] += Number(new RegExp(`\\b${key}="(\\d+)"`).exec(attributes)?.[1] ?? Number.NaN);
    }
  }
  if (Object.values(totals).some(Number.isNaN)) throw new Error("the JUnit report misses a count");
  return totals;
}

// The gateway's floors: what its suites must at least have checked.
const gatewayDir = join(repoRoot, "services", "gateway");
const GATEWAY_FLOOR = { files: 42, coreFiles: 19, generated: 3, schemaTests: 18, tests: 133, dataloaderOffers: 25 };

/**
 * Node's test runner over some of the gateway's test files, one file at a
 * time (they share the ports 4613, 4621 and 4622), counting the test cases
 * of its JUnit report: a file that failed to load is a failure there too.
 */
async function nodeTests(suite: string, files: string[], floor: number): Promise<Omit<Result, "suite" | "seconds">> {
  if (files.length === 0) return failed("0", "no test file found");
  const report = join(reports, `${suite}.xml`);
  const ran = await run(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=junit", `--test-reporter-destination=${report}`,
    "--test-reporter=dot", "--test-reporter-destination=stdout", ...files], { cwd: gatewayDir, echo: true });
  if (!existsSync(report)) return failed("0", `node --test wrote no report (exit ${ran.code})`);
  const xml = await readFile(report, "utf8");
  const tests = [...xml.matchAll(/<testcase\b/g)].length;
  const failures = [...xml.matchAll(/<failure\b/g)].length;
  const skipped = [...xml.matchAll(/<skipped\b/g)].length;
  const counted = `${tests} tests, ${failures} failed, ${skipped} skipped`;
  if (ran.code !== 0 || failures > 0) return failed(counted, `node --test exited ${ran.code}`);
  if (skipped > 0) return failed(counted, "a skipped test checked nothing");
  if (tests < floor) return failed(counted, `fewer than ${floor} tests`);
  return passed(counted);
}

// The tests of each area: tests/services/test_quotes.py is reported with the
// classname tests.services.test_quotes; a module directly in tests/ is the
// database's own rules.
function junitAreas(xml: string): Record<string, number> {
  const areas: Record<string, number> = {};
  for (const [, classname = ""] of xml.matchAll(/<testcase[^>]*classname="([^"]*)"/g)) {
    const parts = classname.split(".");
    const area = parts.length > 2 && parts[0] === "tests" ? (parts[1] ?? "database") : "database";
    areas[area] = (areas[area] ?? 0) + 1;
  }
  return areas;
}

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const suite of SUITES) console.log(`${suite.name.padEnd(12)} ${suite.what}`);
  process.exit(0);
}
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? (args[onlyAt + 1] ?? "").split(",").filter(Boolean) : null;
const unknown = (only ?? []).filter((name) => !SUITES.some((suite) => suite.name === name));
if (unknown.length) {
  console.log(`no suite called ${unknown.join(", ")}; npm run check -- --list`);
  process.exit(2);
}
const wanted = new Set(only ?? SUITES.map((suite) => suite.name));
if (!wanted.has("migrations") && SUITES.some((suite) => suite.needsDatabase && wanted.has(suite.name))) {
  wanted.add("migrations");
  say("migrations added: the database suites read the template it builds");
}
const selected = SUITES.filter((suite) => wanted.has(suite.name));
await mkdir(reports, { recursive: true });

const context: Context = {};
const results: Result[] = [];
try {
  if (selected.some((suite) => suite.needsDatabase)) {
    say(`starting a throwaway PostgreSQL 18 on 127.0.0.1:${PORTS.postgresCheck}`);
    context.cluster = await startCluster({ dataDir: join(dataDir, "check"), port: PORTS.postgresCheck, ephemeral: true, fast: true });
    await createDatabase(context.cluster, TEMPLATE);
  }
  for (const suite of selected) {
    say(`${suite.name}: ${suite.what}`);
    const started = performance.now();
    let result: Omit<Result, "suite" | "seconds">;
    try {
      result = await suite.run(context);
    } catch (error) {
      result = failed("-", error instanceof Error ? error.message : String(error));
    }
    results.push({ suite: suite.name, ...result, seconds: Math.round((performance.now() - started) / 100) / 10 });
    if (suite.name === "migrations" && result.outcome !== "passed") break;
  }
} finally {
  if (context.cluster) await context.cluster.stop();
}

console.log("");
for (const result of results) {
  console.log(`${result.outcome.toUpperCase().padEnd(8)} ${result.suite.padEnd(12)} ${result.counted.padEnd(40)} ${result.seconds}s`);
  if (result.detail && result.outcome !== "passed") console.log(`         ${result.detail.split("\n").join("\n         ")}`);
}
const missing = selected.filter((suite) => !results.some((result) => result.suite === suite.name));
for (const suite of missing) console.log(`NOT RUN  ${suite.name.padEnd(12)} (an earlier suite failed)`);
const anyFailed = results.some((result) => result.outcome === "failed");
const anyNotRun = missing.length > 0 || results.some((result) => result.outcome === "not run");
console.log(`\n[check] ${anyFailed ? "FAILED" : anyNotRun ? "INCOMPLETE: some suites did not run here" : "all suites passed"}`
  + ` (reports in ${relative(repoRoot, reports)}/)`);
process.exitCode = anyFailed ? 1 : anyNotRun ? 2 : 0;
