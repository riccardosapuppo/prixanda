// npm run measure:sandbox: the engine in the browser (stage 8), measured in
// headless Chromium: the first visit until the engine answers, on this
// machine and through a slower network, the bytes it downloads, a call once
// ready, a second tab, a later visit, the browser's memory with two tabs.
//
//   npm run measure:sandbox                      3 runs, and a network of 20 Mbit/s with 40 ms of latency
//   npm run measure:sandbox -- --runs 1          one run: to try the tool
//   npm run measure:sandbox -- --mbps 0          no slower network
//   npm run measure:sandbox -- --mbps 10 --latency 80
//   npm run measure:sandbox -- --assets <folder>  the engine's files already built there
//
// It builds the engine's files into reports/sandbox-engine first (the
// snapshot included, about half a minute), and serves them on
// 127.0.0.1:4651 (SANDBOX_PORT moves it), after asking the system that
// nobody listens there. The report is reports/sandbox-measure.json, with the
// machine and the conditions. Quote numbers from a machine doing nothing else.
import { PORTS } from "./lib/paths.ts";
import { assertFree } from "./lib/ports.ts";
import { measureSandbox, writeSandboxReport } from "./lib/sandbox-measure.ts";

const args = process.argv.slice(2);
const number = (name: string, fallback: number, low: number, high: number): number => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const parsed = Number(args[at + 1]);
  if (!Number.isFinite(parsed) || parsed < low || parsed > high) {
    console.error(`${name} is a number between ${low} and ${high}`);
    process.exit(2);
  }
  return parsed;
};

const at = args.indexOf("--assets");
const assets = at >= 0 ? args[at + 1] : undefined;
const port = PORTS.sandbox;
await assertFree(port, "the measurements' static server");
const report = await measureSandbox({
  runs: number("--runs", 3, 1, 20),
  port,
  mbps: number("--mbps", 20, 0, 10_000),
  latencyMs: number("--latency", 40, 0, 2_000),
  ...(assets ? { assets } : {}),
});
const file = await writeSandboxReport(report);
const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
console.log(`first visit: ready in ${(report.first_visit.median_ready_ms / 1000).toFixed(1)} s, ${mb(report.first_visit.median_downloaded_bytes)} MB downloaded`);
if (report.first_visit_slow_network) {
  console.log(`first visit through the slower network: ready in ${(report.first_visit_slow_network.median_ready_ms / 1000).toFixed(1)} s`);
}
console.log(`a read ${report.calls.median_read_ms} ms, a write ${report.calls.median_write_ms} ms; a second tab ${report.second_tab.median_ready_ms} ms; `
  + `a later visit ${(report.later_visit.median_ready_ms / 1000).toFixed(1)} s, ${mb(report.later_visit.median_downloaded_bytes)} MB`);
console.log(`memory with two tabs: ${report.memory.browser_mb_two_tabs ?? "?"} MB; report in ${file}`);
