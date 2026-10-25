// The worker as a browser runs it: the bundle scripts/build.ts makes, with a
// canned engine in place of the engine's side, served from one origin and
// opened in Chromium by two tabs through the client the apps use. One
// SharedWorker for both: one start, the gateway answering in the browser
// (Apollo, its hashing, the transport, the internal token), one session for
// every tab, the engine's jobs told to both, a tab of another build told so,
// and not one request outside the origin.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import { buildSandbox } from "../scripts/build.ts";

const here = import.meta.dirname;
const BUILD = "chromium-0001";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json" };

let dir = "";
let server: Server;
let origin = "";
let browser: Browser;
let bundle = { bytes: 0, inputs: 0 };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "sandbox-chromium-"));
  const built = await buildSandbox({ engine: join(here, "support", "canned-engine.ts"), out: join(dir, "sandbox"), build: BUILD });
  bundle = { bytes: built.bytes, inputs: built.inputs.length };
  await build({ entryPoints: [join(here, "support", "page.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", outfile: join(dir, "page.js"), logLevel: "warning" });
  const page = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sandbox</title><script type="module" src="/page.js"></script></html>';
  server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://sandbox.invalid").pathname;
    try {
      const file = path === "/" ? null : join(dir, ...path.split("/").filter(Boolean));
      const body = file === null ? page : await readFile(file);
      const type = file === null ? TYPES[".html"] : TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": type ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

async function open(context: Awaited<ReturnType<Browser["newContext"]>>, build = BUILD): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}/?build=${build}`);
  await page.waitForFunction(() => window.demo !== undefined && window.demo.status().state !== "starting", undefined, { timeout: 30_000 });
  return page;
}

describe("the sandbox's worker in Chromium", () => {
  test("one SharedWorker for two tabs: one start, the gateway answering, one session, the jobs told to both, and nothing outside the origin", async () => {
    assert.ok(bundle.bytes > 100_000 && bundle.inputs > 100, `the bundle holds the gateway: ${bundle.bytes} bytes from ${bundle.inputs} modules`);
    const context = await browser.newContext();
    const outside: string[] = [];
    context.on("request", (request) => {
      if (!request.url().startsWith(origin)) outside.push(request.url());
    });
    const first = await open(context);
    const started = await first.evaluate(() => window.demo.status());
    assert.equal(started.state, "ready", JSON.stringify(started));
    assert.deepEqual(started.state === "ready" && [started.info.alreadyRunning, started.info.build, started.info.now], [false, BUILD, "2026-10-24T08:00:00.000Z"]);

    const markets = await first.evaluate(() => window.ask("{ markets { code } }"));
    assert.deepEqual(markets, { status: 200, body: { data: { markets: [{ code: "IT" }] }, extensions: { requestId: (markets.body as { extensions: { requestId: string } }).extensions.requestId } } });
    const entered = await first.evaluate(() => window.ask("mutation ($id: ID!) { signInAsListener(listenerId: $id) { id } }", { id: "5001" }));
    assert.equal((entered.body as { data: { signInAsListener: { id: string } } }).data.signInAsListener.id, "5001", JSON.stringify(entered));

    const second = await open(context);
    const joined = await second.evaluate(() => window.demo.status());
    assert.deepEqual(joined.state === "ready" && joined.info.alreadyRunning, true, "the second tab found the worker running");
    const me = await second.evaluate(() => window.ask("{ me { id } }"));
    assert.equal((me.body as { data: { me: { id: string } } }).data.me.id, "5001", "the listener chosen in the first tab is the second tab's too");

    // The canned engine's first run of the jobs changed the catalog: the first tab, open then, heard it.
    await first.waitForFunction(() => window.changed.some((what) => what.includes("catalog")), undefined, { timeout: 10_000 });

    // A tab of another build finds this worker, and says so.
    const stale = await open(context, "an-older-build");
    assert.equal((await stale.evaluate(() => window.demo.status())).state, "other-build");
    assert.deepEqual(outside, [], "every file came from the demo's origin");
    await context.close();
  });
});
