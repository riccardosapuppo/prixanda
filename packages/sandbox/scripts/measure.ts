// The demo's worker measured (stage 8): the worker the build ships, with the
// engine's own side and its files, in headless Chromium (no window), every
// host but the server's unreachable, the files served with gzip and a
// static host's cache headers by the engine's measuring server
// (test/engine/browser/server.ts), which counts what it sends. A visit is the
// site's tab of the demo:
//   - a first visit, from an empty browser (no HTTP cache, no IndexedDB),
//     until the worker says ready: how long from the page's navigation, how
//     many bytes, how long the worker itself took to start;
//   - the first read and a write through the gateway in the worker;
//   - a second tab, which finds the worker running;
//   - a later visit, once every tab closed and the worker ended: the files
//     from the browser's cache, the data from IndexedDB;
//   - the first visit again through a slower network, when asked.
// It states numbers and the conditions they were taken in, and judges none:
// quote them from a machine doing nothing else.
//
//   node packages/sandbox/scripts/measure.ts [--runs 3] [--mbps 20] [--latency 40] [--assets <folder>]
//
// --assets names the engine's files already built (the check's are in
// reports/sandbox-engine); without it they are built there first, the
// snapshot included (about half a minute). --mbps 0 skips the slower
// network. The report is reports/sandbox-worker-measure.json.
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { laterVisit, serve, type Served } from "../test/engine/browser/server.ts";
import { ISOLATED } from "../test/support/serve.ts";
import { buildSandbox, ENGINE } from "./build.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const BUILD = "measure";

type Visit = { ready_ms: number; worker_start_ms: number; downloaded_bytes: number; requests: number };

export type WorkerReport = {
  measured_at: string;
  machine: Record<string, unknown>;
  conditions: Record<string, unknown>;
  worker: { bytes: number; modules: number };
  first_visit: { runs: Visit[]; median_ready_ms: number; median_worker_start_ms: number; median_downloaded_bytes: number };
  first_visit_slow_network: { runs: Visit[]; median_ready_ms: number } | null;
  requests: { first_read_ms: number; median_read_ms: number; median_write_ms: number };
  second_tab: { median_ready_ms: number };
  later_visit: { median_ready_ms: number; median_downloaded_bytes: number };
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] as number) : 0;
};

/**
 * What the test page keeps on window (test/support/page.ts), as this script
 * reads it in the page; written here again, since the script is checked with
 * Node's types, and a page's are not among them.
 */
type Tab = {
  readonly readyAt: number | null;
  readonly demo: { status(): { readonly state: string; readonly info?: { readonly bootMs: number; readonly alreadyRunning: boolean } } };
  ask(query: string): Promise<{ readonly status: number; readonly body: unknown }>;
};

async function opened(context: BrowserContext, served: Served): Promise<{ page: Page; readyMs: number; startMs: number; alreadyRunning: boolean }> {
  const page = await context.newPage();
  await page.goto(`${served.origin}/page.html?build=${BUILD}&app=site`);
  await page.waitForFunction(() => {
    const tab = globalThis as unknown as Tab;
    return tab.readyAt !== null || tab.demo.status().state === "failed";
  }, undefined, { timeout: 300_000 });
  const seen = await page.evaluate(() => {
    const tab = globalThis as unknown as Tab;
    return { status: tab.demo.status(), readyAt: tab.readyAt };
  });
  if (seen.status.state !== "ready" || seen.readyAt === null || seen.status.info === undefined) throw new Error(`the worker did not start: ${JSON.stringify(seen.status)}`);
  return { page, readyMs: Math.round(seen.readyAt), startMs: seen.status.info.bootMs, alreadyRunning: seen.status.info.alreadyRunning };
}

/** How long a request through the tab's worker takes, in the page's milliseconds. */
function timed(page: Page, query: string): Promise<number> {
  return page.evaluate(async (text) => {
    const begun = performance.now();
    const answer = await (globalThis as unknown as Tab).ask(text);
    if (answer.status !== 200) throw new Error(JSON.stringify(answer.body));
    return Math.round(performance.now() - begun);
  }, query);
}

export async function measureWorker(options: { runs: number; mbps: number; latencyMs: number; assets?: string }): Promise<WorkerReport> {
  let assets = options.assets;
  if (assets === undefined) {
    const { buildEngineAssets } = (await import(pathToFileURL(ENGINE.files).href)) as { buildEngineAssets: (out: string) => Promise<{ outDir: string }> };
    assets = (await buildEngineAssets(join(repo, "reports", "sandbox-engine"))).outDir;
  }
  const dir = await mkdtemp(join(tmpdir(), "sandbox-measure-"));
  const servers: Served[] = [];
  let browser: Browser | null = null;
  try {
    // /sandbox/ as the assembled demo serves it: the worker, and the engine's files beside it.
    const sandbox = join(dir, "sandbox");
    const worker = await buildSandbox({ engine: ENGINE.module, out: sandbox, build: BUILD });
    await cp(assets, sandbox, { recursive: true });
    const pages = join(dir, "pages");
    await mkdir(pages, { recursive: true });
    await build({ entryPoints: [join(root, "test", "support", "page.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", outfile: join(pages, "page.js"), logLevel: "warning" });
    await writeFile(join(pages, "page.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sandbox</title><script type="module" src="/page.js"></script></html>');
    const served = await serve({ port: 0, assets: sandbox, harness: pages });
    servers.push(served);
    browser = await chromium.launch({ headless: true, args: ISOLATED });

    const first: Visit[] = [];
    const reads: number[] = [];
    const writes: number[] = [];
    const seconds: number[] = [];
    const later: Array<{ ready: number; bytes: number }> = [];
    let firstRead = 0;
    for (let run = 0; run < options.runs; run += 1) {
      const context = await browser.newContext();
      try {
        served.resetBytes();
        const visit = await opened(context, served);
        const sent = served.bytes();
        first.push({ ready_ms: visit.readyMs, worker_start_ms: visit.startMs, downloaded_bytes: sent.total, requests: sent.requests });
        const read = await timed(visit.page, '{ markets { code } plans(market: "IT") { code listPrice } }');
        if (run === 0) firstRead = read;
        for (let again = 0; again < 5; again += 1) reads.push(await timed(visit.page, '{ markets { code } plans(market: "IT") { code listPrice } }'));
        for (let again = 0; again < 5; again += 1) writes.push(await timed(visit.page, 'mutation { requestQuote(plan: "individual", market: "IT") { __typename } }'));
        seconds.push((await opened(context, served)).readyMs);
        // Every tab closed: the worker ends; the next visit is the first tab to find a new one.
        const back = await laterVisit(context, async () => {
          served.resetBytes();
          return opened(context, served);
        }, (visit) => !visit.alreadyRunning);
        later.push({ ready: back.opened.readyMs, bytes: served.bytes().total });
      } finally {
        await context.close();
      }
    }

    let slow: WorkerReport["first_visit_slow_network"] = null;
    if (options.mbps > 0) {
      const throttled = await serve({ port: 0, assets: sandbox, harness: pages, mbps: options.mbps, latencyMs: options.latencyMs });
      servers.push(throttled);
      const runs: Visit[] = [];
      for (let run = 0; run < options.runs; run += 1) {
        const context = await browser.newContext();
        try {
          throttled.resetBytes();
          const visit = await opened(context, throttled);
          const sent = throttled.bytes();
          runs.push({ ready_ms: visit.readyMs, worker_start_ms: visit.startMs, downloaded_bytes: sent.total, requests: sent.requests });
        } finally {
          await context.close();
        }
      }
      slow = { runs, median_ready_ms: median(runs.map((each) => each.ready_ms)) };
    }

    const cpu = cpus();
    return {
      measured_at: new Date().toISOString(),
      machine: {
        cpu: cpu[0]?.model ?? "?", cores: cpu.length, memory_gb: Math.round(totalmem() / 2 ** 30), os: `${platform()} ${release()}`,
        node: process.version, chromium: browser.version(),
      },
      conditions: {
        browser: "headless Chromium of playwright 1.62.1, a new context per visit (no HTTP cache, no IndexedDB), every other host unreachable",
        server: "127.0.0.1, gzip for text, WebAssembly and PGlite's file system, cache headers of a static host",
        runs: options.runs, slower_network: options.mbps > 0 ? `${options.mbps} Mbit/s after ${options.latencyMs} ms` : null,
        read: 'markets and the plans of Italy', write: "a quote of Individual in Italy",
      },
      worker: { bytes: worker.bytes, modules: worker.inputs.length },
      first_visit: {
        runs: first,
        median_ready_ms: median(first.map((each) => each.ready_ms)),
        median_worker_start_ms: median(first.map((each) => each.worker_start_ms)),
        median_downloaded_bytes: median(first.map((each) => each.downloaded_bytes)),
      },
      first_visit_slow_network: slow,
      requests: { first_read_ms: firstRead, median_read_ms: median(reads), median_write_ms: median(writes) },
      second_tab: { median_ready_ms: median(seconds) },
      later_visit: { median_ready_ms: median(later.map((each) => each.ready)), median_downloaded_bytes: median(later.map((each) => each.bytes)) },
    };
  } finally {
    await browser?.close();
    for (const served of servers) await served.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const number = (name: string, fallback: number, low: number, high: number): number => {
    const at = args.indexOf(name);
    if (at < 0) return fallback;
    const parsed = Number(args[at + 1]);
    if (!Number.isFinite(parsed) || parsed < low || parsed > high) throw new Error(`${name} is a number between ${low} and ${high}`);
    return parsed;
  };
  const at = args.indexOf("--assets");
  const report = await measureWorker({
    runs: number("--runs", 3, 1, 20), mbps: number("--mbps", 20, 0, 10_000), latencyMs: number("--latency", 40, 0, 2_000),
    ...(at >= 0 && args[at + 1] ? { assets: resolve(args[at + 1] as string) } : {}),
  });
  const file = join(repo, "reports", "sandbox-worker-measure.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
  console.log(`first visit: ready in ${s(report.first_visit.median_ready_ms)} (the worker's own start ${s(report.first_visit.median_worker_start_ms)}), ${mb(report.first_visit.median_downloaded_bytes)} downloaded`);
  if (report.first_visit_slow_network) console.log(`first visit through the slower network: ready in ${s(report.first_visit_slow_network.median_ready_ms)}`);
  console.log(`a read ${report.requests.median_read_ms} ms (the first ${report.requests.first_read_ms} ms), a write ${report.requests.median_write_ms} ms; a second tab ready in ${report.second_tab.median_ready_ms} ms`);
  console.log(`a later visit: ready in ${s(report.later_visit.median_ready_ms)}, ${mb(report.later_visit.median_downloaded_bytes)} downloaded; report in ${file}`);
}
