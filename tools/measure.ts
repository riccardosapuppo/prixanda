// npm run measure: the queries that matter (business book §14.2) on the
// full data, before and after migration V16, on a PostgreSQL 18 of its own.
//
//   npm run measure                             480,000 subscribers, 5 timed runs of each query
//   npm run measure -- --size small --runs 1    the small data: to try the tool
//   npm run measure -- --listening-days 120     a longer history of listening than the demo's 35 days
//   npm run measure -- --audit-events 2000000   a larger audit log (1,000,000 by default)
//   npm run measure -- --keep                   keep the cluster in .data/measure afterwards
//
// The cluster listens on 127.0.0.1:4650 (MEASURE_POSTGRES_PORT moves it),
// with PostgreSQL's usual settings, which the report lists. The report is
// reports/measure.json: the machine, the conditions, how long each step
// took, and for each query its answer, before and after, each run's time,
// the buffers it read and its plan. A query whose answer differs before and
// after makes the command exit 1: an optimization that changes an answer is
// a bug, whatever it saves. Quote numbers from a machine doing nothing else.
import { join } from "node:path";
import { measure, type MeasureOptions } from "./lib/measure.ts";
import { dataDir, PORTS } from "./lib/paths.ts";
import { startCluster } from "./lib/postgres.ts";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const number = (name: string, fallback: number, low: number, high: number): number => {
  const text = value(name);
  if (text === undefined) return fallback;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < low || parsed > high) {
    console.error(`${name} is a whole number between ${low} and ${high}`);
    process.exit(2);
  }
  return parsed;
};

const size = value("--size") ?? "full";
if (size !== "full" && size !== "small") {
  console.error("--size is full or small");
  process.exit(2);
}
const options: MeasureOptions = {
  size,
  runs: number("--runs", 5, 1, 50),
  auditEvents: number("--audit-events", 1_000_000, 1, 20_000_000),
  database: "commerce_measure",
};
if (value("--listening-days") !== undefined) options.listeningDays = number("--listening-days", 35, 1, 730);
const keep = args.includes("--keep");

console.log(`[measure] a PostgreSQL 18 of its own on 127.0.0.1:${PORTS.postgresMeasure}${keep ? ", kept afterwards" : ""}`);
const cluster = await startCluster({ dataDir: join(dataDir, "measure"), port: PORTS.postgresMeasure, ephemeral: !keep });
try {
  console.log(`[measure] ${size} data, ${options.runs} timed runs of each query; this takes a while on the full data`);
  const report = await measure(cluster, options);
  for (const [name, q] of Object.entries(report.queries)) {
    console.log(`${name.padEnd(20)} ${q.before_ms.toFixed(2).padStart(10)} ms before ${q.after_ms.toFixed(2).padStart(10)} ms after`
      + `${q.same_answer ? "" : "   DIFFERENT ANSWER"}`);
  }
  console.log(`[measure] steps (ms): ${JSON.stringify(report.steps_ms)}`);
  console.log("[measure] reports/measure.json holds the machine, the conditions, every run and every plan");
  if (report.differ.length) {
    console.error(`[measure] answers differ:\n${report.differ.join("\n")}`);
    process.exitCode = 1;
  }
} finally {
  await cluster.stop();
}
