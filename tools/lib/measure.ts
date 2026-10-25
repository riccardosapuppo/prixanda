// The measurement of the queries that matter (business book §14.2) on a
// database of its own: the schema as it was before migration V16, the data
// generated, an audit log of a production's size, the queries "before"; then
// Flyway applies V16 and every migration after it, and the queries "after".
// services/commerce/src/commerce/measure.py runs the queries; this file runs
// the steps, times them, and writes the machine and the conditions beside
// the numbers, in reports/measure.json. It states numbers; it judges none.
import { cpus, arch, platform, release, totalmem } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { flyway } from "./flyway.ts";
import { commerceDir, migrationsDir, repoRoot, venvPython } from "./paths.ts";
import { type Cluster, createDatabase, dropDatabase } from "./postgres.ts";
import { run } from "./run.ts";

// The last migration before the ones measured (V16: listening by month and by
// week, the audit log's indexes).
export const MEASURED_FROM = "15";

export type MeasureOptions = {
  size: "full" | "small";
  runs: number;
  auditEvents: number;
  listeningDays?: number;
  database: string;
};

type Phase = {
  phase: string;
  runs: number;
  choices: Record<string, unknown>;
  conditions: Record<string, unknown>;
  queries: Record<string, { answer: unknown; median_execution_ms: number; execution_ms: number[]; buffers: Record<string, number>; plan: unknown; sql: string }>;
};

export type MeasureReport = {
  measured_at: string;
  machine: Record<string, unknown>;
  conditions: Record<string, unknown>;
  steps_ms: Record<string, number>;
  queries: Record<string, { same_answer: boolean; answer: unknown; before_ms: number; after_ms: number; before: unknown; after: unknown }>;
  differ: string[];
};

const reports = join(repoRoot, "reports");

async function timed<T>(steps: Record<string, number>, name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    steps[name] = Math.round(performance.now() - started);
  }
}

async function python(args: string[]): Promise<string> {
  const ran = await run(venvPython, args, { cwd: commerceDir, env: { ...process.env, PYTHONPATH: join(commerceDir, "src") } });
  if (ran.code !== 0) throw new Error(`python ${args.slice(0, 3).join(" ")} exited ${ran.code}:\n${ran.output.slice(-3000)}`);
  return ran.output;
}

function lastJson(output: string): Record<string, unknown> {
  const line = output.split(/\r?\n/).reverse().find((candidate) => candidate.trim().startsWith("{"));
  if (line === undefined) throw new Error(`no JSON in:\n${output.slice(-2000)}`);
  return JSON.parse(line) as Record<string, unknown>;
}

export async function measure(cluster: Cluster, options: MeasureOptions): Promise<MeasureReport> {
  const { database } = options;
  const steps: Record<string, number> = {};
  const owner = cluster.url(database, "owner");
  const target = { port: cluster.port, database, user: cluster.owner.user, password: cluster.owner.password };
  const before = join(reports, "measure-before.json");
  const after = join(reports, "measure-after.json");
  // A fresh clone has no reports/ yet, and the Python steps write into it.
  await mkdir(reports, { recursive: true });
  await Promise.all([rm(before, { force: true }), rm(after, { force: true })]);
  await dropDatabase(cluster, database);
  await createDatabase(cluster, database);

  const migrateTo = async (upTo?: string) => {
    const ran = await flyway("migrate", target, migrationsDir, upTo);
    if (ran.code !== 0) throw new Error(`Flyway up to ${upTo ?? "the last migration"}:\n${ran.output.slice(-3000)}`);
  };
  await timed(steps, `migrate_to_v${MEASURED_FROM}`, () => migrateTo(MEASURED_FROM));
  const generateArgs = ["-m", "commerce.generate", "--url", owner, "--size", options.size, "--seed", "7"];
  if (options.listeningDays !== undefined) generateArgs.push("--listening-days", String(options.listeningDays));
  const generated = await timed(steps, "generate", async () => JSON.parse(await python(generateArgs)) as Record<string, unknown>);
  const prepared = await timed(steps, "prepare_audit_log", async () => lastJson(await python(
    ["-m", "commerce.measure", "prepare", "--url", owner, "--audit-events", String(options.auditEvents)])));
  await timed(steps, "queries_before", () => python(
    ["-m", "commerce.measure", "before", "--url", owner, "--runs", String(options.runs), "--out", before]));
  await timed(steps, "migrate_measured", () => migrateTo());
  await timed(steps, "queries_after", () => python(
    ["-m", "commerce.measure", "after", "--url", owner, "--runs", String(options.runs), "--out", after]));

  const was = JSON.parse(await readFile(before, "utf8")) as Phase;
  const is = JSON.parse(await readFile(after, "utf8")) as Phase;
  const queries: MeasureReport["queries"] = {};
  const differ: string[] = [];
  for (const [name, then] of Object.entries(was.queries)) {
    const now = is.queries[name];
    if (now === undefined) {
      differ.push(`${name}: not measured after`);
      continue;
    }
    const same = JSON.stringify(then.answer) === JSON.stringify(now.answer);
    if (!same) differ.push(`${name}: ${JSON.stringify(then.answer).slice(0, 80)} before, ${JSON.stringify(now.answer).slice(0, 80)} after`);
    queries[name] = {
      same_answer: same, answer: now.answer, before_ms: then.median_execution_ms, after_ms: now.median_execution_ms,
      before: { execution_ms: then.execution_ms, buffers: then.buffers, plan: then.plan, sql: then.sql },
      after: { execution_ms: now.execution_ms, buffers: now.buffers, plan: now.plan, sql: now.sql },
    };
  }
  const processor = cpus();
  const report: MeasureReport = {
    measured_at: new Date().toISOString(),
    machine: {
      platform: platform(), release: release(), arch: arch(), cpu: processor[0]?.model ?? "unknown",
      logical_cpus: processor.length, memory_bytes: totalmem(), node: process.version,
    },
    conditions: {
      size: options.size, seed: 7, runs: options.runs, audit_events: prepared["audit_events"], generated,
      cache: "warm: each query ran once before its timed runs, in the same session",
      before: was.conditions, after: is.conditions, choices: is.choices,
      note: "Times are PostgreSQL's own (EXPLAIN ANALYZE, execution only); planning times are in each run's record.",
    },
    steps_ms: steps,
    queries,
    differ,
  };
  await writeFile(join(reports, "measure.json"), `${JSON.stringify(report, null, 2)}\n`);
  await Promise.all([rm(before, { force: true }), rm(after, { force: true })]);
  return report;
}
