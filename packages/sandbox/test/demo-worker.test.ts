// The demo's worker as the build ships it, with the engine's own side: the
// bundle scripts/build.ts makes from src/engine/index.ts, the engine's files
// beside it (SANDBOX_ENGINE_ASSETS, the folder src/engine/build/assets.ts
// wrote), served from one origin to headless Chromium, every other host
// unreachable. The console's tab and the site's share it: the business
// book's §14.1 from a draft to the site, through the gateway in the worker
// and the engine in Pyodide, with the signature marketing cannot give, the
// simulated fault and the skip to the launch; then the data kept when every
// tab closed, and the start over every tab hears.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { build } from "esbuild";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { buildSandbox, ENGINE } from "../scripts/build.ts";
import type { BackendStatus } from "../src/client.ts";
import type { CommandName } from "../src/protocol.ts";
import { laterVisit } from "./engine/browser/server.ts";
import { ISOLATED, type Served, serveSandbox } from "./support/serve.ts";

const here = import.meta.dirname;
const BUILD = "demo-worker-0001";
const CHANGE = "__typename ... on Change { id state currentVersion current { version fingerprint } } ... on Refusal { code reason }";

let dir = "";
let served: Served;
let browser: Browser;
/** When the engine's story starts (the manifest's story): every visit's clock starts there. */
let story = new Date(Number.NaN);

before(async () => {
  const assets = process.env["SANDBOX_ENGINE_ASSETS"];
  if (!assets) throw new Error("SANDBOX_ENGINE_ASSETS names the engine's files (node packages/sandbox/src/engine/build/assets.ts <folder>)");
  story = new Date((JSON.parse(await readFile(join(assets, "engine", "manifest.json"), "utf8")) as { story: string }).story);
  dir = await mkdtemp(join(tmpdir(), "sandbox-demo-worker-"));
  await buildSandbox({ engine: ENGINE.module, out: join(dir, "worker"), build: BUILD });
  await build({ entryPoints: [join(here, "support", "page.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", outfile: join(dir, "page.js"), logLevel: "warning" });
  // The worker the build wrote, then the engine's files: /sandbox/ as the assembled demo serves it.
  served = await serveSandbox([["/sandbox/", join(dir, "worker")], ["/sandbox/", assets], ["/", dir]]);
  browser = await chromium.launch({ headless: true, args: ISOLATED });
});

after(async () => {
  await browser?.close();
  await served?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

type Tab = { readonly page: Page; readonly errors: string[] };
type Answer = { status: number; body: any };

async function open(context: BrowserContext, app: "site" | "console"): Promise<Tab> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.goto(`${served.origin}/?app=${app}&build=${BUILD}`);
  await page.waitForFunction(() => window.demo !== undefined && window.demo.status().state !== "starting", undefined, { timeout: 180_000 });
  return { page, errors };
}

const status = (tab: Tab): Promise<BackendStatus> => tab.page.evaluate(() => window.demo.status());
const ask = (tab: Tab, query: string, variables?: Record<string, unknown>): Promise<Answer> =>
  tab.page.evaluate(([q, v]) => window.ask(q, v), [query, variables] as const) as Promise<Answer>;
const command = (tab: Tab, name: CommandName, args?: unknown): Promise<Answer> =>
  tab.page.evaluate(([n, a]) => window.command(n, a), [name, args] as const) as Promise<Answer>;

async function ready(tab: Tab) {
  const now = await status(tab);
  assert.equal(now.state, "ready", JSON.stringify(now));
  if (now.state !== "ready") throw new Error("not ready");
  return now.info;
}

/** "YYYY-MM-DDTHH:MM" in Rome, `days` after the day of `from` there, at `hour`. */
function romeLocal(from: Date, days: number, hour: number): string {
  const day = new Date(from.getTime() + days * 86_400_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(day);
  return `${date}T${String(hour).padStart(2, "0")}:00`;
}

/** The instant a local time in Rome is: one or two hours before the same digits in UTC. */
function inRome(local: string): Date {
  for (const hours of [1, 2]) {
    const instant = new Date(new Date(`${local}:00Z`).getTime() - hours * 3_600_000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(instant);
    const part = (type: string) => parts.find((each) => each.type === type)?.value;
    if (`${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}` === local) return instant;
  }
  throw new Error(`${local} is no time in Rome`);
}

function offer(now: Date) {
  return {
    title: "Student Autumn Pass", plan: "student", audience: { segment: "NEVER_PAID", needsStudentCheck: true },
    prices: [{ market: "IT", fixed: { amountMinor: "299", currency: "EUR" } }], monthsAtOfferPrice: 3,
    periods: [{ market: "IT", startsLocal: romeLocal(now, 1, 9), endsLocal: romeLocal(now, 36, 0) }],
    nonCombinabilityGroup: "student-offers",
    pages: [{ market: "IT", title: "Student Autumn Pass", text: "Three months of Student for 2,99 €.", terms: "New subscribers only. One pass per verified student.", treatment: "autumn" }],
  };
}

describe("the demo's worker with the engine's own side, in Chromium", () => {
  test("§14.1 through it: the console's campaign, the signature marketing cannot give, finance's, the fault and the skip to the launch, the offer on the site", async () => {
    const context = await browser.newContext();
    const outside: string[] = [];
    context.on("request", (request) => {
      if (!request.url().startsWith(served.origin)) outside.push(request.url());
    });
    try {
      const console = await open(context, "console");
      const info = await ready(console);
      assert.deepEqual([info.alreadyRunning, info.build], [false, BUILD]);
      const now = new Date(info.now);
      assert.ok(now >= story && now.getTime() - story.getTime() < 10 * 60_000, `the clock starts at the story's ${story.toISOString()}: ${info.now}`);
      const steps = await console.page.evaluate(() => window.progress);
      assert.ok(steps.length >= 6 && steps.at(-1)?.step === "Starting the gateway", JSON.stringify(steps));
      assert.deepEqual(steps.map((step) => step.done), steps.map((_, at) => at + 1), "the steps counted one by one");

      const site = await open(context, "site");
      assert.equal((await ready(site)).alreadyRunning, true, "the site's tab found the console's worker");
      const markets = await ask(site, "{ markets { code } }");
      assert.deepEqual(markets.body.data.markets.map((market: { code: string }) => market.code).sort(), ["DE", "FR", "GB", "IT"], JSON.stringify(markets.body));

      // Marketing writes the pass, validates it and submits it.
      assert.equal((await ask(console, 'mutation { signIn(personId: "marketing-1") { person { id } csrfToken } }')).body.data.signIn.person.id, "marketing-1");
      const created = await ask(console, `mutation ($o: OfferInput!) { createOffer(offer: $o) { ${CHANGE} } }`, { o: offer(now) });
      const id = created.body.data?.createOffer?.id as string;
      assert.equal(created.body.data?.createOffer?.state, "DRAFT", JSON.stringify(created.body));
      assert.equal((await ask(console, `mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { ${CHANGE} } }`, { id })).body.data.validateChange.state, "VALIDATED");
      const submitted = await ask(console, `mutation ($id: ID!) { submitChange(changeId: $id, version: 1, authorReason: "We are buying students for the autumn.") { ${CHANGE} } }`, { id });
      assert.equal(submitted.body.data.submitChange.state, "IN_APPROVAL", JSON.stringify(submitted.body));
      const fingerprint = submitted.body.data.submitChange.current.fingerprint as string;

      // Marketing cannot sign its own pass below the floor; finance can, in the same tab, as the demo's change of person.
      const own = await ask(console, `mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { ${CHANGE} } }`, { id, fp: fingerprint });
      assert.deepEqual(own.body.data.approveChange.__typename === "Refusal" && own.body.data.approveChange.code, "ROLE_NOT_ALLOWED", JSON.stringify(own.body));
      await ask(console, 'mutation { signIn(personId: "finance-1") { person { id } csrfToken } }');
      const approved = await ask(console, `mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { ${CHANGE} } }`, { id, fp: fingerprint });
      assert.equal(approved.body.data.approveChange.state, "APPROVED", JSON.stringify(approved.body));
      await ask(console, 'mutation { signIn(personId: "marketing-1") { person { id } csrfToken } }');
      assert.equal((await ask(console, `mutation ($id: ID!) { scheduleChange(changeId: $id) { ${CHANGE} } }`, { id })).body.data.scheduleChange.state, "SCHEDULED");

      // The launch is due a minute before 09:00 in Rome tomorrow; the fault armed on its publish step; the skip to it.
      const start = inRome(romeLocal(now, 1, 9));
      const waiting = await command(console, "status");
      assert.deepEqual(waiting, { status: 200, body: { build: BUILD, now: waiting.body.now, nextDue: new Date(start.getTime() - 60_000).toISOString(), armed: null, shared: true } });
      assert.deepEqual(await command(console, "arm-fault", { step: "publish" }), { status: 200, body: { armed: "publish" } });
      const skipped = await command(console, "skip-to-next-launch");
      assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
      assert.ok(new Date(skipped.body.to) >= start, `the clock stopped at the pass's start or after: ${skipped.body.to}`);
      assert.deepEqual(skipped.body.changed, ["catalog", "changes", "launches", "audit"], "what the launch changed, all of it in the skip's answer");
      await site.page.waitForFunction(() => window.changed.some((what) => what.includes("catalog")), undefined, { timeout: 10_000 });

      // The site shows the pass at €2.99; the console reads its launch, done after the simulated fault.
      const offers = await ask(site, '{ offers(market: "IT") { id title price } }');
      assert.deepEqual(offers.body.data.offers.filter((each: { id: string }) => each.id === id),
        [{ id, title: "Student Autumn Pass", price: { amountMinor: "299", currency: "EUR" } }], JSON.stringify(offers.body));
      const launched = await ask(console, `{ change(id: "${id}") { state } launches(filter: { changeId: "${id}" }, first: 5) { nodes { id state } } }`);
      assert.equal(launched.body.data.change.state, "ACTIVE", JSON.stringify(launched.body));
      const [run] = launched.body.data.launches.nodes as Array<{ id: string; state: string }>;
      assert.equal(run?.state, "DONE");
      const steps2 = (await ask(console, `{ launch(id: "${run?.id}") { steps { name state attempts facts { name value } } } }`)).body.data.launch.steps as Array<{ name: string; state: string; attempts: number; facts: Array<{ name: string; value: string }> }>;
      const publish = steps2.find((step) => step.name === "publish");
      assert.ok(publish && publish.attempts >= 2 && publish.facts.some((fact) => /simulated/.test(fact.value)), JSON.stringify(publish));
      const after = await command(console, "status");
      assert.equal(after.body.armed, null, "the fault went with the launch it broke");

      assert.deepEqual(outside, [], "every file and every answer came from the demo's origin");
      assert.deepEqual([...console.errors, ...site.errors], [], "no red line in the tabs");
    } finally {
      await context.close();
    }
  });

  test("the data stays when every tab closed, a new worker opens it, and the start over reaches every tab", async () => {
    const context = await browser.newContext();
    try {
      const first = await open(context, "console");
      const now = new Date((await ready(first)).now);
      await ask(first, 'mutation { signIn(personId: "marketing-1") { person { id } csrfToken } }');
      const created = await ask(first, `mutation ($o: OfferInput!) { createOffer(offer: $o) { ${CHANGE} } }`, { o: { ...offer(now), title: "Student Winter Pass" } });
      const id = created.body.data?.createOffer?.id as string;
      assert.ok(id, JSON.stringify(created.body));

      // Every tab closed: the worker ends, and its lock on the data goes with it. A tab opened while it ends
      // finds it still there, so the next visit is the first tab to find a new one.
      const later = await laterVisit(context, async () => {
        const tab = await open(context, "console");
        return { tab, info: await ready(tab) };
      }, (opened) => !opened.info.alreadyRunning);
      const again = later.opened.tab;
      assert.equal((await ask(again, "{ session { person { id } } }")).body.data.session, null, "the sessions ended with their worker");
      await ask(again, 'mutation { signIn(personId: "marketing-1") { person { id } csrfToken } }');
      const kept = await ask(again, `{ change(id: "${id}") { state } }`);
      assert.equal(kept.body.data.change?.state, "DRAFT", JSON.stringify(kept.body));

      const site = await open(context, "site");
      const reset = await command(again, "reset");
      assert.equal(reset.status, 200, JSON.stringify(reset.body));
      assert.ok(Math.abs(new Date(reset.body.now).getTime() - story.getTime()) < 60_000, `back to the story's start: ${reset.body.now}`);
      for (const tab of [again, site]) await tab.page.waitForFunction(() => window.resets === 1, undefined, { timeout: 10_000 });
      assert.equal((await ask(again, "{ session { person { id } } }")).body.data.session, null, "the start over ended the sessions");
      await ask(again, 'mutation { signIn(personId: "marketing-1") { person { id } csrfToken } }');
      assert.equal((await ask(again, `{ change(id: "${id}") { state } }`)).body.data.change, null, "the draft went with the start over");
      assert.deepEqual([...first.errors, ...again.errors, ...site.errors], []);
    } finally {
      await context.close();
    }
  });
});
