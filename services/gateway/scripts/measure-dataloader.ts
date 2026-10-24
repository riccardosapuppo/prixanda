// What the DataLoader saves: how many calls reach the engine for the
// console's list of offers with their details, without batching and with it.
//
//   npm run measure -w gateway                 the table
//   npm run measure -w gateway -- --offers 50  another page size (1 to 100)
//   npm run measure -w gateway -- --json       one JSON line, for tools/check.ts
//
// The gateway runs for real, over HTTP, in front of the fake engine of the
// tests on 127.0.0.1:4613 (gRPC); the calls are counted where they arrive, in
// that engine. The counts do not depend on the machine. The times next to
// them do, and say on what machine and under what load they were taken.
import { cpus, totalmem } from "node:os";
import { startHarness } from "../test/support/harness.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const at = args.indexOf("--offers");
const offers = at >= 0 ? Number(args[at + 1]) : 25;
if (!Number.isInteger(offers) || offers < 1 || offers > 100) {
  console.error("--offers takes a page size from 1 to 100");
  process.exitCode = 2;
} else {
  const query = `{ changes(filter: { kind: OFFER }, first: ${offers}) { nodes { id title state details { sentence current { version fingerprint } requiredSignatures { role signed } } } } }`;
  const rounds = 15;
  type Mode = { calls: Record<string, number>; total: number; medianMs: number; answer: string };
  const measure = async (batch: boolean): Promise<Mode> => {
    const harness = await startHarness({ engine: { offers }, batch });
    try {
      const client = harness.console();
      await client.signIn("marketing-1");
      harness.engine.clearCalls();
      const first = await client.graphql(query);
      if (first.body?.errors) throw new Error(`the list failed: ${first.text}`);
      const calls: Record<string, number> = {};
      for (const call of harness.engine.calls) calls[call.method] = (calls[call.method] ?? 0) + 1;
      const total = harness.engine.count();
      const times: number[] = [];
      for (let round = 0; round < rounds; round += 1) {
        const started = performance.now();
        await client.graphql(query);
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      return { calls, total, medianMs: Math.round((times[Math.floor(rounds / 2)] ?? 0) * 10) / 10, answer: JSON.stringify(first.body.data) };
    } finally {
      await harness.close();
    }
  };
  const without = await measure(false);
  const withBatches = await measure(true);
  const machine = `${cpus().length} logical CPUs, ${Math.round(totalmem() / 2 ** 30)} GB, ${process.platform}, Node ${process.versions.node}`;
  const report = {
    offers,
    without: { calls: without.total, byMethod: without.calls, medianMs: without.medianMs },
    with: { calls: withBatches.total, byMethod: withBatches.calls, medianMs: withBatches.medianMs },
    sameAnswer: without.answer === withBatches.answer,
    machine,
  };
  if (json) {
    console.log(JSON.stringify(report));
  } else {
    const methods = (calls: Record<string, number>) => Object.entries(calls).map(([method, count]) => `${method} ${count}`).join(", ");
    console.log(`The console's list of ${offers} offers with their details, through the gateway, counted at the engine:`);
    console.log(`  without batching:     ${String(without.total).padStart(3)} calls (${methods(without.calls)})`);
    console.log(`  with BatchGetChanges: ${String(withBatches.total).padStart(3)} calls (${methods(withBatches.calls)})`);
    console.log(`  the same answer both ways: ${report.sameAnswer ? "yes" : "NO"}`);
    console.log(`  median time of the request over ${rounds} rounds: ${without.medianMs} ms without, ${withBatches.medianMs} ms with`);
    console.log(`  (times only: ${machine}; the engine is the in-memory fake on the same machine, so they show the`);
    console.log("   gateway's share alone, and they were not taken on an idle machine: do not quote them as a benchmark)");
  }
  if (!report.sameAnswer || withBatches.total !== 2 || without.total !== offers + 1) process.exitCode = 1;
}
