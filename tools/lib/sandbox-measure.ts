// The measurements of the engine in the browser (stage 8): how long the
// first visit takes until the engine answers, on this machine and through a
// slower network, how many bytes it downloads, how long a call takes once it
// is ready, how quickly a second tab and a later visit get it, and how much
// memory the browser holds with two tabs open. Headless Chromium (no window),
// every host but the harness's unreachable, the engine alone in the harness's
// SharedWorker (packages/sandbox/test/engine/browser), the files of
// packages/sandbox/src/engine/build served with gzip. A first visit starts
// from an empty browser: no HTTP cache, no IndexedDB. It states numbers and
// the conditions they were taken in; it judges none. Quote them from a
// machine doing nothing else.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CatalogService } from "contracts/commerce/v1/catalog";
import { ChangeService } from "contracts/commerce/v1/changes";
import { type Browser, chromium, type Page } from "playwright";
import { buildEngineAssets } from "../../packages/sandbox/src/engine/build/assets.ts";
import { buildHarness, serve, type Served } from "../../packages/sandbox/test/engine/browser/server.ts";
import { repoRoot } from "./paths.ts";

export type SandboxMeasureOptions = {
  readonly runs: number;
  readonly port: number;
  /** The slower network: a pipe of so many megabits per second, after a latency; 0 to skip it. */
  readonly mbps: number;
  readonly latencyMs: number;
  /** The engine's files already built (the check's); built anew into reports/sandbox-engine otherwise. */
  readonly assets?: string;
};

type Visit = {
  ready_ms: number;
  worker_boot_ms: number;
  steps_ms: Record<string, number>;
  downloaded_bytes: number;
  requests: number;
};

export type SandboxReport = {
  measured_at: string;
  machine: Record<string, unknown>;
  conditions: Record<string, unknown>;
  build: { files: number; bytes: number; by_folder: Record<string, number>; snapshot_bytes: number; fingerprint: string };
  first_visit: { runs: Visit[]; median_ready_ms: number; median_downloaded_bytes: number; downloaded_by_file: Record<string, number> };
  first_visit_slow_network: { runs: Visit[]; median_ready_ms: number } | null;
  calls: { first_read_ms: number; median_read_ms: number; median_write_ms: number };
  second_tab: { median_ready_ms: number };
  later_visit: { median_ready_ms: number; median_downloaded_bytes: number };
  memory: { browser_mb_two_tabs: number | null; how: string };
};

const run = promisify(execFile);
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] as number) : 0;
};

/** What the headless browser's processes hold in memory, in MB, as the system counts it. */
async function browserMemoryMB(): Promise<number | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("powershell", ["-NoProfile", "-Command",
        "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ms-playwright' } | Measure-Object -Property WorkingSetSize -Sum).Sum"]);
      return Math.round(Number(stdout.trim()) / 1e6);
    }
    const { stdout } = await run("ps", ["-eo", "rss=,args="]);
    const kb = stdout.split("\n").filter((line) => line.includes("ms-playwright")).reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0] ?? 0), 0);
    return Math.round((kb * 1024) / 1e6);
  } catch {
    return null;
  }
}

type Info = { bootMs: number; progress: Array<[string, number]>; workerId: string; info: { loaded: boolean; steps: Record<string, number> } };
const harness = <T>(page: Page, op: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([name, rest]) => (globalThis as unknown as { harness(op: string, ...a: unknown[]): Promise<unknown> }).harness(name as string, ...(rest as unknown[])),
    [op, args] as const) as Promise<T>;

async function call(page: Page, method: { name: string; parent: { typeName: string } }, input: object, who?: [string, string]): Promise<number> {
  const m = method as unknown as { name: string; parent: { typeName: string }; input: Parameters<typeof create>[0]; output: Parameters<typeof fromBinary>[0] };
  const metadata: Record<string, string> = { "x-request-id": `measure-${crypto.randomUUID()}`, "idempotency-key": `measure-${crypto.randomUUID()}` };
  if (who) [metadata["x-actor"], metadata["x-actor-role"]] = who;
  const request = Array.from(toBinary(m.input, create(m.input, input as never)));
  const started = performance.now();
  const reply = await harness<{ ok: boolean; message?: string }>(page, "call", m.parent.typeName, m.name, metadata, request);
  const ms = performance.now() - started;
  if (!reply.ok) throw new Error(`${m.name}: ${reply.message}`);
  return ms;
}

async function visit(browser: Browser, served: Served, db: string): Promise<{ visit: Visit; page: Page; close(): Promise<void> }> {
  const context = await browser.newContext();
  served.resetBytes();
  const page = await context.newPage();
  const started = performance.now();
  await page.goto(`${served.origin}/harness.html?db=${db}`);
  const info = await harness<Info>(page, "info");
  const ready = performance.now() - started;
  const bytes = served.bytes();
  return {
    visit: {
      ready_ms: Math.round(ready), worker_boot_ms: info.bootMs, steps_ms: info.info.steps,
      downloaded_bytes: bytes.total, requests: bytes.requests,
    },
    page,
    close: () => context.close(),
  };
}

export async function measureSandbox(options: SandboxMeasureOptions): Promise<SandboxReport> {
  const assets = options.assets ?? join(repoRoot, "reports", "sandbox-engine");
  if (!options.assets) await buildEngineAssets(assets);
  const manifest = JSON.parse(await readFile(join(assets, "engine", "manifest.json"), "utf8")) as { snapshot: string; fingerprint: string };
  const files: Record<string, number> = {};
  for (const path of await readdir(assets, { recursive: true })) {
    const facts = await stat(join(assets, path));
    if (facts.isFile()) files[path.replaceAll("\\", "/")] = facts.size;
  }
  const byFolder: Record<string, number> = {};
  for (const [path, bytes] of Object.entries(files)) byFolder[path.split("/")[0] as string] = (byFolder[path.split("/")[0] as string] ?? 0) + bytes;
  const harnessDir = await buildHarness(await mkdtemp(join(tmpdir(), "engine-measure-")));
  const browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"] });
  try {
    const local = await serve({ port: options.port, assets, harness: harnessDir });
    const firstRuns: Visit[] = [];
    const laterRuns: number[] = [];
    const laterBytes: number[] = [];
    const secondTab: number[] = [];
    const reads: number[] = [];
    const writes: number[] = [];
    let firstRead = 0;
    let memory: number | null = null;
    let byFile: Record<string, number> = {};
    try {
      for (let i = 0; i < options.runs; i += 1) {
        const db = `engine-measure-${i}`;
        const first = await visit(browser, local, db);
        firstRuns.push(first.visit);
        byFile = local.bytes().paths;
        if (i === 0) firstRead = Math.round(await call(first.page, CatalogService.method.listMarkets, {}));
        for (let n = 0; n < 5; n += 1) reads.push(await call(first.page, CatalogService.method.listMarkets, {}));
        for (let n = 0; n < 3; n += 1) {
          writes.push(await call(first.page, ChangeService.method.createChange, { content: { case: "listPrice", value: {
            title: `Measured price ${n}`, plan: "family", market: "DE", amount: { amountMinor: 2099n, currency: "EUR" },
            startsLocal: "2030-01-01T00:00" } } }, ["commercial-lead-1", "commercial_lead"]));
        }
        const context = first.page.context();
        const { workerId } = await harness<Info>(first.page, "info");
        const started = performance.now();
        const second = await context.newPage();
        await second.goto(`${local.origin}/harness.html?db=${db}`);
        await harness<Info>(second, "info");
        secondTab.push(performance.now() - started);
        if (i === 0) memory = await browserMemoryMB();
        // A later visit: every tab closed, the worker gone, the files in the HTTP cache and the data in IndexedDB.
        for (const page of context.pages()) await page.close();
        local.resetBytes();
        const again = await context.newPage();
        const reopened = performance.now();
        await again.goto(`${local.origin}/harness.html?db=${db}`);
        const info = await harness<Info>(again, "info");
        if (info.info.loaded) throw new Error("the later visit did not find the data in IndexedDB");
        if (info.workerId === workerId) throw new Error("the worker outlived its tabs: the later visit would not start it");
        laterRuns.push(performance.now() - reopened);
        laterBytes.push(local.bytes().total);
        await first.close();
      }
    } finally {
      await local.close();
    }
    let slow: SandboxReport["first_visit_slow_network"] = null;
    if (options.mbps > 0) {
      const throttled = await serve({ port: options.port, assets, harness: harnessDir, mbps: options.mbps, latencyMs: options.latencyMs });
      const slowRuns: Visit[] = [];
      try {
        for (let i = 0; i < options.runs; i += 1) {
          const v = await visit(browser, throttled, `engine-measure-slow-${i}`);
          slowRuns.push(v.visit);
          await v.close();
        }
      } finally {
        await throttled.close();
      }
      slow = { runs: slowRuns, median_ready_ms: median(slowRuns.map((r) => r.ready_ms)) };
    }
    const processor = cpus();
    return {
      measured_at: new Date().toISOString(),
      machine: {
        platform: platform(), release: release(), arch: arch(), cpu: processor[0]?.model ?? "unknown", logical_cpus: processor.length,
        memory_bytes: totalmem(), node: process.version, chromium: browser.version(),
      },
      conditions: {
        browser: "headless Chromium of Playwright 1.62.1, every host but 127.0.0.1 unreachable",
        engine: "alone in the harness's SharedWorker (no gateway, no app), as startEngine runs it",
        server: "the harness's static server, gzip level 6 for text, WebAssembly and PGlite's files; HTTP/1.1 on 127.0.0.1",
        first_visit: "a new browser context each time: no HTTP cache, no IndexedDB",
        later_visit: "the same context after every tab closed: the files revalidated (304), the data from IndexedDB",
        slow_network: options.mbps > 0 ? `one pipe of ${options.mbps} Mbit/s shared by every response, ${options.latencyMs} ms before each` : "not measured",
        runs: options.runs,
        reads: "ListMarkets, a read-only call", writes: "CreateChange of a list price, saved to IndexedDB before it answers",
      },
      build: {
        files: Object.keys(files).length, bytes: Object.values(files).reduce((a, b) => a + b, 0), by_folder: byFolder,
        snapshot_bytes: files[`engine/${manifest.snapshot}`] ?? 0, fingerprint: manifest.fingerprint,
      },
      first_visit: {
        runs: firstRuns, median_ready_ms: median(firstRuns.map((r) => r.ready_ms)),
        median_downloaded_bytes: median(firstRuns.map((r) => r.downloaded_bytes)), downloaded_by_file: byFile,
      },
      first_visit_slow_network: slow,
      calls: { first_read_ms: firstRead, median_read_ms: Math.round(median(reads) * 10) / 10, median_write_ms: Math.round(median(writes) * 10) / 10 },
      second_tab: { median_ready_ms: Math.round(median(secondTab)) },
      later_visit: { median_ready_ms: Math.round(median(laterRuns)), median_downloaded_bytes: median(laterBytes) },
      memory: { browser_mb_two_tabs: memory, how: "the working set of every process of Playwright's Chromium, as the system counts it, after the first run's two tabs opened" },
    };
  } finally {
    await browser.close();
    await rm(harnessDir, { recursive: true, force: true });
  }
}

export async function writeSandboxReport(report: SandboxReport): Promise<string> {
  const file = join(repoRoot, "reports", "sandbox-measure.json");
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
