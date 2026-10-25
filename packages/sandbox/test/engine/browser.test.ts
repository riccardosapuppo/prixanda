// The engine of the demo in the browser: headless Chromium (no window opens),
// the engine in a SharedWorker as the demo's will be, its files served from
// the page's own origin by the harness's server (browser/server.ts, on
// SANDBOX_HARNESS_PORT, 4651 by default), and every other host unreachable:
// Pyodide, its wheels, PGlite and the data come from the origin, or the
// engine does not start. What the browser adds to the engine's tests in Node
// (engine.test.ts): IndexedDB, which keeps the data when every tab closed,
// one engine for every tab, the reset, the fallback on a dedicated worker,
// and a console with no error.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CatalogService } from "contracts/commerce/v1/catalog";
import { ChangeService } from "contracts/commerce/v1/changes";
import { LaunchService, LaunchState } from "contracts/commerce/v1/launches";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { buildHarness, laterVisit, type Served, serve } from "./browser/server.ts";
import { assetsDir, FINANCE, MARKETING, ON_CALL, romeLocal, type Who } from "./support.ts";

const COMMERCIAL_LEAD: Who = ["commercial-lead-1", "commercial_lead"];

const port = Number(process.env["SANDBOX_HARNESS_PORT"] ?? 4651);
let served: Served;
let harnessDir: string;
let browser: Browser;

/** Chromium with every host but the harness's unreachable. */
export const ISOLATED = ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"];

before(async () => {
  harnessDir = await buildHarness(await mkdtemp(join(tmpdir(), "engine-harness-")));
  served = await serve({ port, assets: assetsDir(), harness: harnessDir });
  browser = await chromium.launch({ headless: true, args: ISOLATED });
});

after(async () => {
  await browser?.close();
  await served?.close();
  if (harnessDir) await rm(harnessDir, { recursive: true, force: true });
});

type Tab = { page: Page; errors: string[] };

async function open(context: BrowserContext, query = ""): Promise<Tab> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("worker", (worker) => worker.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(`worker ${message.type()}: ${message.text()}`);
  }));
  await page.goto(`${served.origin}/harness.html${query}`);
  return { page, errors };
}

type Info = { info: { loaded: boolean; applied: string[]; versions: Record<string, string>; startMs: number }; bootMs: number;
  workerId: string; ports: number; progress: Array<[string, number]> };

const harness = <T>(tab: Tab, op: string, ...args: unknown[]): Promise<T> =>
  tab.page.evaluate(([name, rest]) => (window as unknown as { harness(op: string, ...a: unknown[]): Promise<unknown> }).harness(name as string, ...(rest as unknown[])),
    [op, args] as const) as Promise<T>;

type Method = { name: string; input: never; output: never; parent: { typeName: string } };

/** A call of the contract through the page and its worker, as engine.test.ts makes it in Node. */
async function rpc(tab: Tab, method: { name: string; parent: { typeName: string } }, input: object, who: Who = null): Promise<any> {
  const m = method as unknown as Method & { input: Parameters<typeof create>[0]; output: Parameters<typeof fromBinary>[0] };
  const metadata: Record<string, string> = { "x-request-id": `test-${crypto.randomUUID()}`, "idempotency-key": `key-${crypto.randomUUID()}` };
  if (who) {
    metadata["x-actor"] = who[0];
    metadata["x-actor-role"] = who[1];
  }
  const request = Array.from(toBinary(m.input, create(m.input, input as never)));
  const reply = await harness<{ ok: boolean; response?: number[]; code?: number; message?: string }>(tab, "call", m.parent.typeName, m.name, metadata, request);
  if (!reply.ok) throw new Error(`${reply.code}: ${reply.message}`);
  return fromBinary(m.output, new Uint8Array(reply.response ?? []));
}

async function scheduledOffer(tab: Tab, market: string, title: string): Promise<string> {
  const now = new Date(await harness<string>(tab, "now"));
  const created = await rpc(tab, ChangeService.method.createChange, { content: { case: "offer", value: {
    title, plan: "student", audience: { segment: 1, needsStudentCheck: true },
    prices: [{ market, price: { case: "fixed", value: { amountMinor: 299n, currency: market === "GB" ? "GBP" : "EUR" } } }],
    monthsAtOfferPrice: 3, periods: [{ market, startsLocal: romeLocal(now, 2, 9), endsLocal: romeLocal(now, 40, 0) }],
    nonCombinabilityGroup: "student-offers",
    pages: [{ market, title, text: "Three months of Student.", terms: "New subscribers only." }],
  } } }, MARKETING);
  const id = created.outcome.value.id as string;
  await rpc(tab, ChangeService.method.validateChange, { changeId: id, version: 1 }, MARKETING);
  const submitted = await rpc(tab, ChangeService.method.submitChange, { changeId: id, version: 1, authorReason: "Autumn." }, MARKETING);
  const hash = submitted.outcome.value.versions.at(-1).contentHash;
  await rpc(tab, ChangeService.method.approveChange, { changeId: id, version: 1, contentHash: hash }, FINANCE);
  const scheduled = await rpc(tab, ChangeService.method.scheduleChange, { changeId: id }, MARKETING);
  assert.equal(scheduled.outcome.case, "change");
  return id;
}

/** A later visit: every tab closed, then the first tab whose worker is a new one (browser/server.ts, laterVisit). */
async function reopen(context: BrowserContext, query: string, before: string): Promise<{ tab: Tab; info: Info }> {
  const later = await laterVisit(context, async () => {
    const tab = await open(context, query);
    return { tab, info: await harness<Info>(tab, "info") };
  }, (opened) => opened.info.workerId !== before);
  return later.opened;
}

test("a first visit loads Pyodide, PGlite and the snapshot from the page's own origin, in a SharedWorker", async () => {
  const context = await browser.newContext();
  try {
    served.resetBytes();
    const tab = await open(context);
    const started = await harness<Info>(tab, "info");
    assert.equal(await tab.page.evaluate(() => (window as unknown as { harnessShared: boolean }).harnessShared), true);
    assert.equal(started.info.loaded, true);
    assert.deepEqual(started.info.applied, []);
    assert.deepEqual([started.info.versions["python"], started.info.versions["protobuf"]], ["3.13.2", "6.31.1"]);
    assert.match(started.info.versions["postgres"] ?? "", /^18\./);
    const story = JSON.parse(await readFile(join(assetsDir(), "engine", "manifest.json"), "utf8")).story as string;
    assert.ok(Math.abs(Date.parse(await harness<string>(tab, "now")) - Date.parse(story)) < 60_000, "the story's time, whatever the day");
    const markets = await rpc(tab, CatalogService.method.listMarkets, {});
    assert.equal(markets.markets.length, 4);
    const paths = Object.keys(served.bytes().paths);
    assert.ok(paths.every((path) => path.startsWith("/sandbox/") || path.startsWith("/harness")), paths.join(" "));
    assert.ok(!paths.some((path) => path.endsWith("initdb.wasm")), "no cluster is created in the browser");
    assert.deepEqual(tab.errors, []);
  } finally {
    await context.close();
  }
});

test("the data stays in the browser: a tab opened after the last one closed finds it, and no migration runs again", async () => {
  const context = await browser.newContext();
  try {
    const first = await open(context, "?db=engine-harness-kept");
    const before = await harness<Info>(first, "info");
    const id = await scheduledOffer(first, "IT", "Student Autumn Pass");
    // The clock moved on in the story; with no tab open, it stands still, whatever the machine's clock does.
    const jumped = Date.parse(await harness<string>(first, "now")) + 2 * 86_400_000;
    await harness(first, "advanceTo", new Date(jumped).toISOString());
    await harness(first, "tick"); // as the demo's worker ticks after each command
    const { tab: again, info: after } = await reopen(context, "?db=engine-harness-kept", before.workerId);
    const resumed = Date.parse(await harness<string>(again, "now"));
    assert.ok(resumed >= jumped && resumed < jumped + 60_000, `the clock resumed at ${new Date(resumed).toISOString()}`);
    assert.equal(after.info.loaded, false);
    assert.deepEqual(after.info.applied, []);
    const change = await rpc(again, ChangeService.method.getChange, { changeId: id }, MARKETING);
    assert.equal(change.change.title, "Student Autumn Pass");
    assert.deepEqual([...first.errors, ...again.errors], []);
  } finally {
    await context.close();
  }
});

test("a later visit after a second tab: the first tab with a new worker finds what the first tab wrote", async () => {
  const context = await browser.newContext();
  try {
    // As the measurements go: a tab writes, a second tab comes, every tab closes. Chromium keeps the worker of
    // the two a while after the last one closed, and a tab opened at once would find it, still running.
    const one = await open(context, "?db=engine-harness-two");
    const { workerId } = await harness<Info>(one, "info");
    const ids: string[] = [];
    for (const year of [2030, 2031, 2032]) {
      const created = await rpc(one, ChangeService.method.createChange, { content: { case: "listPrice", value: {
        title: `Family price, Germany, ${year}`, plan: "family", market: "DE", amount: { amountMinor: 2099n, currency: "EUR" },
        startsLocal: `${year}-01-01T00:00` } } }, COMMERCIAL_LEAD);
      ids.push(created.outcome.value.id as string);
    }
    const two = await open(context, "?db=engine-harness-two");
    assert.equal((await harness<Info>(two, "info")).workerId, workerId);
    const { tab: again, info } = await reopen(context, "?db=engine-harness-two", workerId);
    assert.equal(info.info.loaded, false, "the data from IndexedDB, not the snapshot");
    assert.deepEqual(info.info.applied, []);
    const change = await rpc(again, ChangeService.method.getChange, { changeId: ids.at(-1) }, MARKETING);
    assert.equal(change.change.title, "Family price, Germany, 2032");
    assert.deepEqual([...one.errors, ...two.errors, ...again.errors], []);
  } finally {
    await context.close();
  }
});

test("two tabs share one engine: what one writes, the other reads, and the skip runs through a fault", async () => {
  const context = await browser.newContext();
  try {
    const one = await open(context, "?db=engine-harness-shared");
    const two = await open(context, "?db=engine-harness-shared");
    const [a, b] = [await harness<Info>(one, "info"), await harness<Info>(two, "info")];
    assert.equal(a.workerId, b.workerId);
    assert.equal(b.ports, 2);
    const id = await scheduledOffer(one, "FR", "Student Autumn Pass, France");
    assert.equal((await rpc(two, ChangeService.method.getChange, { changeId: id }, MARKETING)).change.title, "Student Autumn Pass, France");
    assert.equal(await harness(two, "arm", "publish"), "publish");
    const skipped = await harness<{ from: string; to: string; changed: string[] }>(one, "skip");
    assert.ok(skipped.changed.includes("catalog"), JSON.stringify(skipped));
    const [listed] = (await rpc(two, LaunchService.method.listLaunches, { changeId: id }, ON_CALL)).launches;
    const run = (await rpc(two, LaunchService.method.getLaunch, { launchId: listed.launchId }, ON_CALL)).launch;
    assert.equal(run.state, LaunchState.DONE);
    assert.match(run.steps.find((s: { name: string }) => s.name === "publish").facts["last failure"], /simulated by the demo/);
    const offers = await rpc(two, CatalogService.method.listOffers, { market: "FR" });
    assert.deepEqual(offers.offers.map((o: { offerId: string }) => o.offerId), [id]);
    assert.deepEqual([...one.errors, ...two.errors], []);
  } finally {
    await context.close();
  }
});

test("a reset starts again from the build's snapshot, and the next visit keeps that", async () => {
  const context = await browser.newContext();
  try {
    const tab = await open(context, "?db=engine-harness-reset");
    const { workerId } = await harness<Info>(tab, "info");
    await scheduledOffer(tab, "DE", "Studenten-Herbstpass");
    const reset = await harness<{ info: Info["info"] }>(tab, "reset");
    assert.equal(reset.info.loaded, true);
    assert.equal((await rpc(tab, ChangeService.method.listChanges, {}, MARKETING)).changes.length, 0);
    const { tab: again, info } = await reopen(context, "?db=engine-harness-reset", workerId);
    assert.equal(info.info.loaded, false);
    assert.equal((await rpc(again, ChangeService.method.listChanges, {}, MARKETING)).changes.length, 0);
    assert.deepEqual([...tab.errors, ...again.errors], []);
  } finally {
    await context.close();
  }
});

test("a first visit cut short, which left IndexedDB's database empty, is a first visit again", async () => {
  const context = await browser.newContext();
  try {
    const other = await open(context, "?db=engine-harness-other");
    // What IDBFS leaves when the tab closes before the first saving ends: its database, and no file in it.
    await other.page.evaluate(() => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("/pglite/engine-harness-empty", 21);
      request.onupgradeneeded = () => request.result.createObjectStore("FILE_DATA");
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    }));
    const tab = await open(context, "?db=engine-harness-empty");
    const started = await harness<Info>(tab, "info");
    assert.equal(started.info.loaded, true);
    assert.equal((await rpc(tab, CatalogService.method.listMarkets, {})).markets.length, 4);
    assert.deepEqual(tab.errors, []);
  } finally {
    await context.close();
  }
});

test("where SharedWorker is missing, a dedicated worker serves the tab, with nothing red in its console", async () => {
  const context = await browser.newContext();
  try {
    const tab = await open(context, "?dedicated&db=engine-harness-dedicated");
    assert.equal(await tab.page.evaluate(() => (window as unknown as { harnessShared: boolean }).harnessShared), false);
    const started = await harness<Info>(tab, "info");
    assert.equal(started.info.loaded, true);
    // A refusal the rules expect, and an error of the contract: answers, not red lines.
    const refused = await rpc(tab, ChangeService.method.approveChange, { changeId: "1", version: 1, contentHash: new Uint8Array(32) }, MARKETING)
      .catch((error: Error) => error.message);
    assert.match(String(refused), /^5: /);
    assert.deepEqual(tab.errors, []);
  } finally {
    await context.close();
  }
});
