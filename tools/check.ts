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
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildConsole, GATEWAY_URL as E2E_GATEWAY_URL, runEndToEnd } from "../apps/console/e2e/run.ts";
import { nestedSegmentFiles } from "../apps/site/scripts/segments.ts";
import { licenseInventory, writeReport } from "./licenses.ts";
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
const FLOOR = {
  typecheckedFiles: 13, contractFiles: 47, migrations: 11, pythonTests: 573, invariants: 10, generatedSubscribers: 5_000,
  faultsInjected: 12,
  // npm's lockfile lists every platform's packages; the Python environment
  // has one more on Windows (colorama, for pytest).
  licensedPackages: 570,
};
// pytest's tests by area, read from the folder each test lives in: the
// database's own rules (tests/), the rules as plain Python (domain), the
// business book's numbers (golden), every service against PostgreSQL
// (services), the calls over gRPC with a real server (e2e), the properties
// Hypothesis generates cases for (properties), and the faults injected in a
// launch with the engine's real process (faults).
const AREA_FLOOR: Record<string, number> = { database: 90, domain: 154, golden: 32, services: 245, e2e: 28, properties: 10, faults: 14 };
// What tests/faults writes: every fault injected in a launch, and what it left.
type FaultReport = { faults_injected: number; partial_activations: number; recovered: number };

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
    name: "licenses",
    what: "every npm, Python and setup package under a licence the policy accepts (docs/legal-and-licensing.md)",
    needsDatabase: false,
    async run() {
      if (!existsSync(venvPython)) return notRun("no Python environment: npm run setup");
      const inventory = await licenseInventory();
      writeReport(inventory);
      const counted = `${inventory.entries.length} packages`;
      if (inventory.notRead.length > 0) return failed(counted, inventory.notRead.join("\n"));
      if (inventory.unknown.length > 0) {
        return failed(counted, inventory.unknown.map((entry) => `${entry.source} ${entry.name} ${entry.version}: ${entry.license}`).join("\n"));
      }
      if (inventory.entries.length < FLOOR.licensedPackages) return failed(counted, `fewer than ${FLOOR.licensedPackages} packages were read`);
      const exceptions = inventory.entries.filter((entry) => entry.verdict.startsWith("exception")).length;
      return passed(counted, `${exceptions} named exceptions`);
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
    what: "the engine against PostgreSQL: the database's rules, the domain, the golden cases, every service and call with its refusals and errors, gRPC end to end, properties, faults injected in launches",
    needsDatabase: true,
    async run({ cluster }) {
      if (!cluster) return notRun("no database");
      if (!existsSync(venvPython)) return notRun("no Python environment: npm run setup");
      // The gRPC tests start the engine's server on this port, after the system says nobody listens on it.
      await assertFree(PORTS.engineCheck, "the engine's gRPC tests");
      const commerce = join(repoRoot, "services", "commerce");
      const report = join(reports, "pytest-engine.xml");
      // The faults' report of an earlier run must not stand in for this one.
      const faultsFile = join(reports, "fault-injection.json");
      await rm(faultsFile, { force: true });
      const ran = await run(venvPython, ["-m", "pytest", "-q", "-p", "no:cacheprovider", `--junitxml=${report}`, "tests"], {
        cwd: commerce,
        env: {
          ...process.env,
          COMMERCE_TEST_ADMIN_URL: cluster.url("postgres", "owner"),
          COMMERCE_TEST_TEMPLATE: TEMPLATE,
          COMMERCE_TEST_APP_URL: cluster.url("{database}", "app").replace("%7Bdatabase%7D", "{database}"),
          COMMERCE_TEST_ENGINE_PORT: String(PORTS.engineCheck),
          COMMERCE_TEST_REPORTS: reports,
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
      // The faults injected in launches: every one recovered, none left a launch half live.
      if (!existsSync(faultsFile)) return failed(counted, "the fault-injection tests wrote no report");
      const faults = JSON.parse(await readFile(faultsFile, "utf8")) as FaultReport;
      const told = `${counted}; faults: ${faults.faults_injected} injected, ${faults.partial_activations} partial activations, ${faults.recovered} recovered`;
      if (faults.faults_injected < FLOOR.faultsInjected) return failed(told, `fewer than ${FLOOR.faultsInjected} faults injected`);
      if (faults.partial_activations !== 0) return failed(told, "a fault left a launch half live (reports/fault-injection.json)");
      if (faults.recovered !== faults.faults_injected) return failed(told, "a launch did not recover from its fault");
      // Rule 26: a test that writes undoes what it wrote, caches included.
      const deposits = [".hypothesis", ".pytest_cache"].filter((name) => existsSync(join(commerce, name)));
      if (deposits.length) return failed(told, `the tests left ${deposits.join(" and ")} in services/commerce`);
      return passed(told);
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
  // and the gateway on 4621 and 4622 (CHECK_FAKE_ENGINE_PORT,
  // CHECK_GATEWAY_INTERNAL_PORT and CHECK_GATEWAY_PUBLIC_PORT move them),
  // after asking the system that nobody listens there; they need no database.
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
    what: "the gateway against a fake engine over gRPC: resolvers, roles, both APIs' sessions, CSRF, idempotency, request ids, limits, the subscriber's side",
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
  // The engine and the gateway together (end of stage 3, and the subscriber's
  // side of stage 5): the real engine on CHECK_ENGINE_PORT, the real gateway
  // on the gateway's test ports, and the Student Autumn Pass walked through
  // over HTTP only, up to a student's subscription.
  {
    name: "integration",
    what: "the real engine and the real gateway over HTTP: §14.1 from a draft to a student's subscription on the site, the audit log, idempotency",
    needsDatabase: true,
    async run({ cluster }) {
      if (!cluster) return notRun("no database");
      if (!existsSync(venvPython)) return notRun("no Python environment: npm run setup");
      const database = "commerce_integration";
      await createDatabase(cluster, database, TEMPLATE);
      try {
        const commerce = join(repoRoot, "services", "commerce");
        const generated = await run(venvPython, ["-m", "commerce.generate", "--url", cluster.url(database, "owner"), "--size", "small", "--seed", "7"], {
          cwd: commerce, env: { ...process.env, PYTHONPATH: join(commerce, "src") },
        });
        if (generated.code !== 0) return failed("-", generated.output.slice(-3000));
        const summaryFile = join(reports, "integration.json");
        await rm(summaryFile, { force: true });
        const tests = await nodeTests("integration", ["test/integration/student-autumn.test.ts"], GATEWAY_FLOOR.integrationTests, {
          INTEGRATION_DATABASE_URL: cluster.url(database, "app"),
          INTEGRATION_SUMMARY: summaryFile,
        });
        if (!existsSync(summaryFile)) return failed(tests.counted, `${tests.detail}\nthe test wrote no summary`.trim());
        const summary = JSON.parse(await readFile(summaryFile, "utf8")) as {
          activationMs: number | null;
          auditEvents: number;
          engineExit: number | null;
          subscription: { price: string; months: number; fullPrice: string; fullPriceFrom: string; payment: string; logged: boolean } | null;
          launchSteps: number;
        };
        const euros = (minor: string) => (Number(minor) / 100).toFixed(2);
        const paid = summary.subscription
          ? `subscribed at ${euros(summary.subscription.price)} × ${summary.subscription.months}, then ${euros(summary.subscription.fullPrice)} from ${summary.subscription.fullPriceFrom}, the first month ${summary.subscription.payment}`
          : "no subscription";
        const counted = `${tests.counted}; on the site ${summary.activationMs === null ? "never" : `${(summary.activationMs / 1000).toFixed(1)} s`} after 09:00; ${summary.auditEvents} audit events; ${paid}; launch read with ${summary.launchSteps} steps done`;
        if (tests.outcome !== "passed") return { ...tests, counted };
        if (summary.auditEvents < GATEWAY_FLOOR.integrationAuditEvents) return failed(counted, `fewer than ${GATEWAY_FLOOR.integrationAuditEvents} audit events of the pass were found`);
        if (!summary.subscription?.logged) return failed(counted, "the student's subscription was not found in the audit log");
        if (summary.launchSteps !== 5) return failed(counted, "the console did not read the pass's launch with its five steps done");
        if (summary.engineExit !== 0) return failed(counted, `the engine did not stop in order (exit ${summary.engineExit})`);
        return passed(counted);
      } finally {
        await cluster.sql("postgres", `drop database if exists ${database} with (force)`);
      }
    },
  },
  // The site (stage 5): apps/site, a static Next.js build. Its types, its
  // operations and its unit tests need nothing running; its build writes
  // apps/site/out, for the API of the end-to-end test.
  {
    name: "site-types",
    what: "tsc over the site: its pages and components as Next.js builds them, then what Node runs (scripts and tests)",
    needsDatabase: false,
    async run() {
      const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
      if (!existsSync(tsc)) return notRun("typescript is not installed: npm install");
      // next-env.d.ts and the route types are generated, not committed.
      const typegen = await run(process.execPath, [join(siteDir, "scripts", "next.ts"), "typegen"], { cwd: siteDir });
      if (typegen.code !== 0) return failed("-", typegen.output.slice(-3000));
      const counted: string[] = [];
      for (const [config, floor, label] of [["tsconfig.json", SITE_FLOOR.files, "in the pages"], ["tsconfig.node.json", SITE_FLOOR.nodeFiles, "run by Node"]] as const) {
        const ran = await run(process.execPath, [tsc, "-p", config, "--listFiles"], { cwd: siteDir });
        const ours = ran.output.split(/\r?\n/).filter((line) => {
          const path = line.replaceAll("\\", "/");
          return path.includes("/apps/site/") && /\.tsx?$/.test(path) && !path.includes("node_modules") && !path.includes("/.next/") && !path.endsWith("next-env.d.ts");
        }).length;
        counted.push(`${ours} ${label}`);
        if (ran.code !== 0) return failed(counted.join(", "), ran.output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line)).slice(0, 8).join("\n") || ran.output.slice(0, 2000));
        if (ours < floor) return failed(counted.join(", "), `${config}: fewer than ${floor} files of the site were checked`);
      }
      return passed(counted.join(", "));
    },
  },
  {
    name: "site-codegen",
    what: "the site's GraphQL operations validate against public.graphql, and their generated types equal a fresh generation",
    needsDatabase: false,
    async run() {
      const ran = await run(process.execPath, [join(siteDir, "scripts", "graphql.ts"), "--check"], { cwd: siteDir });
      const operations = Number(/match the schema \((\d+) operations\)/.exec(ran.output)?.[1] ?? 0);
      if (ran.code !== 0) return failed(`${operations} operations`, ran.output.slice(-3000));
      if (operations < SITE_FLOOR.operations) return failed(`${operations} operations`, `fewer than ${SITE_FLOOR.operations} operations`);
      return passed(`${operations} operations`);
    },
  },
  {
    name: "site-unit",
    what: "the site's data layer, dates, markets, drawings and build correction, without a browser",
    needsDatabase: false,
    async run() {
      const files = (await readdir(join(siteDir, "test"))).filter((name) => name.endsWith(".test.ts")).map((name) => `test/${name}`);
      return siteNodeTests("site-unit", files, SITE_FLOOR.unitTests);
    },
  },
  {
    name: "site-build",
    what: "next build: the static export in apps/site/out, every page there, no prefetch file where the router would not find it",
    needsDatabase: false,
    async run() {
      const env = { ...process.env, NEXT_PUBLIC_SITE_API: SITE_CHECK_API };
      const ran = await run(process.execPath, [join(siteDir, "scripts", "next.ts"), "build"], { cwd: siteDir, env });
      if (ran.code !== 0) return failed("-", ran.output.slice(-3000));
      const out = join(siteDir, "out");
      const pages = SITE_PAGES.filter((page) => existsSync(join(out, ...page.split("/"))));
      const counted = `${pages.length} of ${SITE_PAGES.length} pages`;
      if (pages.length !== SITE_PAGES.length) return failed(counted, `missing: ${SITE_PAGES.filter((page) => !pages.includes(page)).join(", ")}`);
      const misplaced = await nestedSegmentFiles(out);
      if (misplaced.length) return failed(counted, `prefetch files the router would not find: ${misplaced.join(", ")}`);
      // The API is written into the build: the end-to-end test needs the one it serves.
      const html = await readFile(join(out, "index.html"), "utf8");
      const scripts = await readdir(join(out, "_next", "static", "chunks"));
      const chunks = await Promise.all(scripts.filter((name) => name.endsWith(".js")).map((name) => readFile(join(out, "_next", "static", "chunks", name), "utf8")));
      if (!chunks.some((chunk) => chunk.includes(SITE_CHECK_API))) return failed(counted, `the build does not call ${SITE_CHECK_API}`);
      return passed(`${counted}, API ${SITE_CHECK_API}`, `${html.length} bytes of index.html`);
    },
  },
  // The site's end-to-end test: the real engine on CHECK_ENGINE_PORT, the real
  // gateway on the gateway's test ports, the site's build on CHECK_SITE_PORT,
  // and a headless Chromium through the Student Autumn Pass, from its launch to
  // a student's demo subscription. Needs the build of site-build.
  {
    name: "site-e2e",
    what: "the whole system and a real browser: §14.1 launched, on the site within a measured time, a student subscribed at the right price, every step in the audit log, axe on every page",
    needsDatabase: true,
    async run({ cluster }) {
      if (!cluster) return notRun("no database");
      if (!existsSync(venvPython)) return notRun("no Python environment: npm run setup");
      if (!(await chromiumInstalled())) return notRun("no Chromium for playwright 1.62.1: npx playwright install chromium (it downloads the browser)");
      const database = "commerce_site_e2e";
      await createDatabase(cluster, database, TEMPLATE);
      try {
        const commerce = join(repoRoot, "services", "commerce");
        const generated = await run(venvPython, ["-m", "commerce.generate", "--url", cluster.url(database, "owner"), "--size", "small", "--seed", "7"], {
          cwd: commerce, env: { ...process.env, PYTHONPATH: join(commerce, "src") },
        });
        if (generated.code !== 0) return failed("-", generated.output.slice(-3000));
        const summaryFile = join(reports, "site-e2e.json");
        await rm(summaryFile, { force: true });
        const report = join(reports, "site-e2e.xml");
        const ran = await run(process.execPath, ["--test", "--test-reporter=junit", `--test-reporter-destination=${report}`,
          "--test-reporter=spec", "--test-reporter-destination=stdout", join("e2e", "student-autumn.e2e.ts")], {
          cwd: siteDir,
          echo: true,
          env: { ...process.env, SITE_E2E_DATABASE_URL: cluster.url(database, "app"), SITE_E2E_SUMMARY: summaryFile },
        });
        if (!existsSync(report)) return failed("0", `node --test wrote no report (exit ${ran.code})`);
        const xml = await readFile(report, "utf8");
        const tests = [...xml.matchAll(/<testcase\b/g)].length;
        const failures = [...xml.matchAll(/<failure\b/g)].length;
        if (!existsSync(summaryFile)) return failed(`${tests} tests, ${failures} failed`, "the test wrote no summary");
        const summary = JSON.parse(await readFile(summaryFile, "utf8")) as {
          activationMs: number | null; siteMs: number | null; paymentMs: number | null; auditEvents: number; pagesChecked: number;
          layoutChecks: number; seriousViolations: number; otherViolations: number; externalRequests: number; engineExit: number | null;
        };
        const seconds = (ms: number | null) => (ms === null ? "never" : `${(ms / 1000).toFixed(1)} s`);
        const counted = `${tests} tests, ${failures} failed; published ${seconds(summary.activationMs)} and on the open page ${seconds(summary.siteMs)} after 09:00;`
          + ` paid ${seconds(summary.paymentMs)} after the confirmation; ${summary.auditEvents} audit events; axe on ${summary.pagesChecked} pages,`
          + ` ${summary.seriousViolations} serious, ${summary.otherViolations} other; ${summary.layoutChecks} pages fitted at 5 widths`;
        if (ran.code !== 0 || failures > 0) return failed(counted, `node --test exited ${ran.code}`);
        if (tests < SITE_FLOOR.e2eTests) return failed(counted, `fewer than ${SITE_FLOOR.e2eTests} tests`);
        if (summary.auditEvents < SITE_FLOOR.e2eAuditEvents) return failed(counted, `fewer than ${SITE_FLOOR.e2eAuditEvents} audit events of the journey`);
        if (summary.pagesChecked < SITE_FLOOR.e2ePagesChecked) return failed(counted, `axe ran on fewer than ${SITE_FLOOR.e2ePagesChecked} pages`);
        if (summary.layoutChecks < SITE_FLOOR.e2eLayoutChecks) return failed(counted, `fewer than ${SITE_FLOOR.e2eLayoutChecks} pages fitted to the widths`);
        if (summary.externalRequests > 0) return failed(counted, `${summary.externalRequests} requests to other hosts`);
        if (summary.engineExit !== 0) return failed(counted, `the engine did not stop in order (exit ${summary.engineExit})`);
        return passed(counted);
      } finally {
        await cluster.sql("postgres", `drop database if exists ${database} with (force)`);
      }
    },
  },
  // The console (stage 4) and the design it shares with the site. Storybook
  // and the end-to-end tests run headless Chromium, no window. The
  // end-to-end tests start the whole system on the check's database: the
  // engine on CHECK_ENGINE_PORT, the gateway on GATEWAY_INTERNAL_PORT and
  // GATEWAY_PUBLIC_PORT, the console's static build on CONSOLE_PORT;
  // Storybook's build is served on STORYBOOK_PORT. Each port is asked to the
  // system before use, and telemetry stays off (Next.js, Storybook).
  {
    name: "design",
    what: "the shared design: the generated CSS and TypeScript equal tokens.json and the icon list, and its tests (contrast pairs, money, the engine's parity)",
    needsDatabase: false,
    async run() {
      const generated = await run(process.execPath, [join(designDir, "scripts", "generate.ts"), "--check"], { cwd: repoRoot });
      const compared = Number(/the icon list \((\d+) files\)/.exec(generated.output)?.[1] ?? 0);
      if (generated.code !== 0) return failed(`${compared} files`, generated.output.slice(-3000));
      if (compared < CONSOLE_FLOOR.designFiles) return failed(`${compared} files`, `fewer than ${CONSOLE_FLOOR.designFiles} generated files compared`);
      const files = (await readdir(join(designDir, "test"))).filter((name) => name.endsWith(".test.ts")).map((name) => `test/${name}`);
      const tests = await nodeTests("design", files, CONSOLE_FLOOR.designTests, {}, designDir);
      return { ...tests, counted: `${compared} generated files, ${tests.counted}` };
    },
  },
  {
    name: "console-types",
    what: "tsc over the console and the design it imports (strict, exact optional properties, unchecked index access)",
    needsDatabase: false,
    async run() {
      const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
      if (!existsSync(tsc)) return notRun("typescript is not installed: npm install");
      const ran = await run(process.execPath, [tsc, "-p", "tsconfig.json", "--listFiles"], { cwd: consoleDir });
      // Next writes .next/types and next-env.d.ts when it builds: they are not
      // the console's files, and a fresh checkout has none of them.
      const listed = ran.output.split(/\r?\n/).map((line) => line.replaceAll("\\", "/"))
        .filter((line) => !line.includes("node_modules") && !line.includes("/.next/") && !line.endsWith("/next-env.d.ts"));
      const ours = listed.filter((line) => line.includes("/apps/console/") && /\.tsx?$/.test(line)).length;
      const design = listed.filter((line) => line.includes("/packages/design/") && /\.tsx?$/.test(line)).length;
      const counted = `${ours} files, ${design} of the design`;
      if (ran.code !== 0) return failed(counted, ran.output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line)).slice(0, 8).join("\n") || ran.output.slice(0, 2000));
      if (ours < CONSOLE_FLOOR.files) return failed(counted, `fewer than ${CONSOLE_FLOOR.files} files of the console were checked`);
      return passed(counted);
    },
  },
  {
    name: "console-codegen",
    what: "the console's typed operations equal a fresh generation from the gateway's internal schema and the console's .graphql files",
    needsDatabase: false,
    async run() {
      const ran = await run(process.execPath, [join(consoleDir, "scripts", "codegen.ts"), "--check"], { cwd: repoRoot });
      const operations = Number(/\((\d+) operations\)/.exec(ran.output)?.[1] ?? 0);
      if (ran.code !== 0) return failed(`${operations} operations`, ran.output.slice(-3000));
      if (operations < CONSOLE_FLOOR.operations) return failed(`${operations} operations`, `fewer than ${CONSOLE_FLOOR.operations} operations compared`);
      return passed(`${operations} operations`);
    },
  },
  {
    name: "console-unit",
    what: "the console's logic under Node: the gateway client and the action keys, the form of an offer, changing person, the team's table against the book and the gateway, the week",
    needsDatabase: false,
    async run() {
      const files = (await readdir(join(consoleDir, "test"))).filter((name) => name.endsWith(".test.ts")).map((name) => `test/${name}`);
      return nodeTests("console-unit", files, CONSOLE_FLOOR.unitTests, {}, consoleDir);
    },
  },
  {
    name: "storybook",
    what: "Storybook's build, then every story with an interaction test in headless Chromium and axe on what it drew; no request leaves 127.0.0.1",
    needsDatabase: false,
    async run() {
      await assertFree(Number(process.env["STORYBOOK_PORT"] || 4633), "Storybook's static build");
      const report = join(reports, "console-storybook.json");
      await rm(report, { force: true });
      const ran = await run(process.execPath, [join(consoleDir, "scripts", "storybook-test.ts"), "--build"], {
        cwd: repoRoot,
        env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: "1", NEXT_TELEMETRY_DISABLED: "1" },
        echo: true,
      });
      if (!existsSync(report)) return failed("0", `the stories wrote no report (exit ${ran.code})\n${ran.output.slice(-2000)}`);
      const stories = JSON.parse(await readFile(report, "utf8")) as { withPlay: number; passed: number; failed: { id: string; error: string | null }[]; axeSerious: number; refused: number };
      const counted = `${stories.passed} of ${stories.withPlay} stories, axe serious ${stories.axeSerious}, requests refused ${stories.refused}`;
      if (ran.code !== 0 || stories.failed.length > 0) return failed(counted, stories.failed.map((story) => `${story.id}: ${story.error ?? "axe"}`).join("\n") || ran.output.slice(-2000));
      if (stories.refused > 0) return failed(counted, "a story asked for a host other than 127.0.0.1");
      if (stories.withPlay < CONSOLE_FLOOR.stories) return failed(counted, `fewer than ${CONSOLE_FLOOR.stories} stories with an interaction test`);
      return passed(counted);
    },
  },
  {
    name: "console-build",
    what: "the console's static export (Next.js, no server), for the gateway the end-to-end tests start; no page names another host",
    needsDatabase: false,
    async run() {
      const built = await buildConsole(CONSOLE_GATEWAY_URL);
      if (built.code !== 0) return failed(`${built.pages} pages`, built.output.slice(-3000));
      if (built.pages < CONSOLE_FLOOR.pages) return failed(`${built.pages} pages`, `fewer than ${CONSOLE_FLOOR.pages} pages exported`);
      const elsewhere = await hostsNamedIn(join(consoleDir, "out"));
      if (elsewhere.length) return failed(`${built.pages} pages`, `the build names other hosts: ${elsewhere.slice(0, 8).join(", ")}`);
      consoleBuiltFor = CONSOLE_GATEWAY_URL;
      return passed(`${built.pages} pages`);
    },
  },
  {
    name: "console-e2e",
    what: "the console's static build on the whole system: the Student Autumn Pass from draft to launch, refusals by the server, the audit log, conflicts, axe on every screen, the keyboard alone, five widths",
    needsDatabase: true,
    async run({ cluster }) {
      if (!cluster) return notRun("no database");
      if (!existsSync(venvPython)) return notRun("no Python environment: npm run setup");
      if (consoleBuiltFor !== CONSOLE_GATEWAY_URL) {
        const built = await buildConsole(CONSOLE_GATEWAY_URL);
        if (built.code !== 0) return failed("-", built.output.slice(-3000));
      }
      const database = "console_e2e";
      await createDatabase(cluster, database, TEMPLATE);
      try {
        const outcome = await runEndToEnd(cluster, database, reports);
        const counted = `${outcome.tests} tests, ${outcome.failures} failed, ${outcome.skipped} skipped`;
        if (outcome.code !== 0 || outcome.failures > 0) return failed(counted, outcome.output.slice(-3000));
        if (outcome.skipped > 0) return failed(counted, "a skipped test checked nothing");
        if (outcome.tests < CONSOLE_FLOOR.e2eTests) return failed(counted, `fewer than ${CONSOLE_FLOOR.e2eTests} tests`);
        return passed(counted);
      } finally {
        await cluster.sql("postgres", `drop database if exists ${database} with (force)`);
      }
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
const GATEWAY_FLOOR = {
  files: 47, coreFiles: 19, generated: 3, schemaTests: 21, tests: 193, dataloaderOffers: 25, integrationTests: 9, integrationAuditEvents: 7,
};

/**
 * Node's test runner over some test files of the gateway (or, with cwd, of
 * another package), one file at a time (the gateway's share the fake engine's
 * and the gateway's ports), counting the test cases of its JUnit report: a
 * file that failed to load is a failure there too.
 */
async function nodeTests(suite: string, files: string[], floor: number, env: Record<string, string> = {}, cwd = gatewayDir): Promise<Omit<Result, "suite" | "seconds">> {
  if (files.length === 0) return failed("0", "no test file found");
  const report = join(reports, `${suite}.xml`);
  await rm(report, { force: true });
  const ran = await run(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=junit", `--test-reporter-destination=${report}`,
    "--test-reporter=dot", "--test-reporter-destination=stdout", ...files], { cwd, echo: true, env: { ...process.env, ...env } });
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

// The site's floors: what its suites must at least have checked, and the
// pages its static build must hold. Its build calls the gateway's public API
// where the end-to-end test starts it (CHECK_GATEWAY_PUBLIC_PORT).
const siteDir = join(repoRoot, "apps", "site");
const SITE_FLOOR = {
  files: 41, nodeFiles: 30, operations: 10, unitTests: 63, e2eTests: 9, e2eAuditEvents: 9, e2ePagesChecked: 9, e2eLayoutChecks: 20,
};
const SITE_PAGES = ["index.html", "campaign/index.html", "account/index.html", "session/index.html", "404.html"];
const SITE_CHECK_API = `http://127.0.0.1:${PORTS.gatewayCheckPublic}/graphql`;

/** Whether the Chromium of the site's Playwright is on this machine: the check never downloads it. */
async function chromiumInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** Node's test runner over the site's unit tests, counting the cases of its JUnit report. */
async function siteNodeTests(suite: string, files: string[], floor: number): Promise<Omit<Result, "suite" | "seconds">> {
  if (files.length === 0) return failed("0", "no test file found");
  const report = join(reports, `${suite}.xml`);
  const ran = await run(process.execPath, ["--test", "--test-reporter=junit", `--test-reporter-destination=${report}`,
    "--test-reporter=dot", "--test-reporter-destination=stdout", ...files], { cwd: siteDir, echo: true });
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

// The console's floors: what its suites must at least have checked.
const designDir = join(repoRoot, "packages", "design");
const consoleDir = join(repoRoot, "apps", "console");
const CONSOLE_FLOOR = {
  designFiles: 4, designTests: 77, files: 88, operations: 29, unitTests: 60, stories: 27, pages: 13, e2eTests: 26,
};
/** The gateway the console is built for: the one its end-to-end tests start. */
const CONSOLE_GATEWAY_URL = E2E_GATEWAY_URL;
let consoleBuiltFor: string | null = null;

/**
 * Every host other than this machine that the built pages would load from:
 * a src or href in the HTML, a url() in the CSS. (The scripts carry other
 * hosts only inside messages; what they request is watched by the
 * end-to-end tests, which refuse and count every request leaving 127.0.0.1.)
 */
async function hostsNamedIn(dir: string): Promise<string[]> {
  const found = new Set<string>();
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(html|css)$/.test(entry.name)) {
        const text = await readFile(path, "utf8");
        for (const [, host = ""] of text.matchAll(/(?:(?:src|href)=["']?|url\(["']?)(?:https?:)?\/\/([a-z0-9.-]+)/gi)) {
          if (!["127.0.0.1", "localhost"].includes(host.toLowerCase())) found.add(host);
        }
      }
    }
  };
  if (existsSync(dir)) await visit(dir);
  return [...found];
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
  for (const suite of SUITES) console.log(`${suite.name.padEnd(16)} ${suite.what}`);
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
  console.log(`${result.outcome.toUpperCase().padEnd(8)} ${result.suite.padEnd(16)} ${result.counted.padEnd(40)} ${result.seconds}s`);
  if (result.detail && result.outcome !== "passed") console.log(`         ${result.detail.split("\n").join("\n         ")}`);
}
const missing = selected.filter((suite) => !results.some((result) => result.suite === suite.name));
for (const suite of missing) console.log(`NOT RUN  ${suite.name.padEnd(16)} (an earlier suite failed)`);
const anyFailed = results.some((result) => result.outcome === "failed");
const anyNotRun = missing.length > 0 || results.some((result) => result.outcome === "not run");
console.log(`\n[check] ${anyFailed ? "FAILED" : anyNotRun ? "INCOMPLETE: some suites did not run here" : "all suites passed"}`
  + ` (reports in ${relative(repoRoot, reports)}/)`);
process.exitCode = anyFailed ? 1 : anyNotRun ? 2 : 0;
