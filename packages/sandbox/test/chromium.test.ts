// The worker as a browser runs it: the bundle scripts/build.ts makes, with a
// canned engine in place of the engine's side, served from one origin to
// headless Chromium, every other host unreachable, and opened by the client
// the apps use. One SharedWorker for every tab: one start, the gateway
// answering in the browser (Apollo, its hashing, the transport, the internal
// token), one session for every tab, the engine's jobs told to all, a tab of
// another build told so. Where SharedWorker
// is missing, a dedicated worker for each tab, and the data one worker's at a
// time: the second tab waits for the first to close.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { build } from "esbuild";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { buildSandbox } from "../scripts/build.ts";
import type { BackendStatus } from "../src/client.ts";
import type { CommandName } from "../src/protocol.ts";
import { WAITING_FOR_DATA } from "../src/worker.ts";
import { ISOLATED, type Served, serveSandbox } from "./support/serve.ts";

const here = import.meta.dirname;
const BUILD = "chromium-0001";

let dir = "";
let served: Served;
let browser: Browser;
let bundle = { bytes: 0, inputs: 0 };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "sandbox-chromium-"));
  const built = await buildSandbox({ engine: join(here, "support", "canned-engine.ts"), out: join(dir, "sandbox"), build: BUILD });
  bundle = { bytes: built.bytes, inputs: built.inputs.length };
  await build({ entryPoints: [join(here, "support", "page.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", outfile: join(dir, "page.js"), logLevel: "warning" });
  served = await serveSandbox([["/", dir]]);
  browser = await chromium.launch({ headless: true, args: ISOLATED });
});

after(async () => {
  await browser?.close();
  await served?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

type Answer = { status: number; body: any };

async function open(context: BrowserContext, query = "", wait = true): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${served.origin}/?build=${BUILD}${query}`);
  if (wait) await page.waitForFunction(() => window.demo !== undefined && window.demo.status().state !== "starting", undefined, { timeout: 30_000 });
  return page;
}

const status = (page: Page): Promise<BackendStatus> => page.evaluate(() => window.demo.status());
const ask = (page: Page, query: string, variables?: Record<string, unknown>): Promise<Answer> =>
  page.evaluate(([q, v]) => window.ask(q, v), [query, variables] as const) as Promise<Answer>;
const command = (page: Page, name: CommandName): Promise<Answer> => page.evaluate((n) => window.command(n), name) as Promise<Answer>;

describe("the sandbox's worker in Chromium", () => {
  test("one SharedWorker for every tab: one start, the gateway answering, one session, the jobs told to all, and nothing outside the origin", async () => {
    assert.ok(bundle.bytes > 100_000 && bundle.inputs > 100, `the bundle holds the gateway: ${bundle.bytes} bytes from ${bundle.inputs} modules`);
    const context = await browser.newContext();
    const outside: string[] = [];
    context.on("request", (request) => {
      if (!request.url().startsWith(served.origin)) outside.push(request.url());
    });
    try {
      const first = await open(context);
      const started = await status(first);
      assert.equal(started.state, "ready", JSON.stringify(started));
      assert.deepEqual(started.state === "ready" && [started.info.alreadyRunning, started.info.build, started.info.now], [false, BUILD, "2026-10-24T08:00:00.000Z"]);
      assert.deepEqual(await first.evaluate(() => window.progress.map((step) => step.step)), ["Opening the canned engine", "Starting the gateway"]);

      const markets = await ask(first, "{ markets { code } }");
      assert.deepEqual(markets, { status: 200, body: { data: { markets: [{ code: "IT" }] }, extensions: { requestId: markets.body.extensions.requestId } } });
      const entered = await ask(first, "mutation ($id: ID!) { signInAsListener(listenerId: $id) { id csrfToken } }", { id: "5001" });
      assert.equal(entered.body.data.signInAsListener.id, "5001", JSON.stringify(entered.body));

      const second = await open(context);
      const joined = await status(second);
      assert.deepEqual(joined.state === "ready" && joined.info.alreadyRunning, true, "the second tab found the worker running");
      assert.equal((await ask(second, "{ me { id } }")).body.data.me.id, "5001", "the listener chosen in the first tab is the second tab's too");

      // The canned engine's first run of the jobs changed the catalog: the first tab, open then, heard it.
      await first.waitForFunction(() => window.changed.some((what) => what.includes("catalog")), undefined, { timeout: 10_000 });

      // A tab of another build finds this worker, and says so.
      const stale = await context.newPage();
      await stale.goto(`${served.origin}/?build=an-older-build`);
      await stale.waitForFunction(() => window.demo !== undefined && window.demo.status().state !== "starting", undefined, { timeout: 30_000 });
      assert.equal((await status(stale)).state, "other-build");
      assert.deepEqual(outside, [], "every file came from the demo's origin");
    } finally {
      await context.close();
    }
  });

  test("where SharedWorker is missing, each tab has a dedicated worker, and the second waits for the first to close", async () => {
    const context = await browser.newContext();
    try {
      const first = await open(context, "&dedicated");
      const alone = await command(first, "status");
      assert.equal(alone.body.shared, false, JSON.stringify(alone.body));
      const second = await open(context, "&dedicated", false);
      await second.waitForFunction((step) => window.progress.some((each) => each.step === step), WAITING_FOR_DATA, { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal((await status(second)).state, "starting", "it waits while the first tab's worker holds the data");
      await first.close();
      await second.waitForFunction(() => window.demo.status().state === "ready", undefined, { timeout: 10_000 });
      const own = await status(second);
      assert.deepEqual(own.state === "ready" && own.info.alreadyRunning, false, "a worker of its own, started once the first had gone");
      assert.equal((await ask(second, "{ markets { code } }")).status, 200);
    } finally {
      await context.close();
    }
  });
});
