// The site in the assembled demo (stage 8, BRIEF-TAPPA-8-DEMO.md, part 3):
// dist/demo/ served on DEMO_URL (npm run demo:serve, or the check's suite
// demo), headless Chromium, one browser with its tabs, as a visitor has.
//
//   1. The first visit starts the demo in this browser: the bar shows the
//      worker's steps, the page is there meanwhile, and the home fills in.
//   2. A second tab is ready at once: the worker is the one of the origin.
//   3. A campaign launched from another tab, through the console's API on
//      the worker and the demo's "skip to the launch", reaches the site.
//   4. The data stays: after a reload, and after every tab was closed and
//      the worker started again from this browser's storage.
//   5. Start over puts the demo back as it was built, in every tab.
//   6. No request left the origin, and no page logged an error.
//
// Each step is timed, and the times are written with the machine and the
// conditions they were taken under (SITE_DEMO_SUMMARY).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { after, before, describe, test } from "node:test";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { text, Watch } from "./support/browser.ts";
import { launchOffer, studentAutumnPass } from "./support/console.ts";
import { connectWorker, demoCommand, romeLocal, workerSession } from "./support/demo.ts";

const DEMO_URL = process.env["DEMO_URL"] ?? `http://127.0.0.1:${process.env["DEMO_PORT"] ?? 4651}`;
const SUMMARY = process.env["SITE_DEMO_SUMMARY"] ?? "";
/** How long the first start may take on this machine: Python, the database and the engine, from the build's own files. */
const BOOT_LIMIT_MS = 120_000;

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let build = "";
const watch = new Watch(() => {
  assert.ok(browser);
  return browser;
});
const times = {
  coldReadyMs: Number.NaN,
  secondTabMs: Number.NaN,
  offerOnSiteMs: Number.NaN,
  reloadMs: Number.NaN,
  restartMs: Number.NaN,
  startOverMs: Number.NaN,
};

/** The home is ready: the demo started, and the plans of Italy are there. */
async function homeReady(page: Page, timeout: number): Promise<void> {
  await page.locator("[data-sandbox='starting']").waitFor({ state: "detached", timeout });
  await page.getByRole("radio", { name: "Italy" }).waitFor({ timeout });
  await page.locator(".plan-row, .plan").first().waitFor({ timeout });
}

const offerFlag = (page: Page) => page.getByRole("link", { name: /Student Autumn Pass/ });

describe("the site in the demo's sandbox: one browser, its tabs, one worker", () => {
  before(async () => {
    const served = await fetch(`${DEMO_URL}/demo-build.json`).catch(() => null);
    if (served === null || !served.ok) throw new Error(`no demo on ${DEMO_URL}: npm run demo:build, then npm run demo:serve`);
    build = ((await served.json()) as { build: string }).build;
    // No host but the demo's own can be reached, whatever asks: a page, a worker, the engine's Python.
    browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"] });
    context = await watch.context();
  });

  after(async () => {
    await browser?.close();
    if (SUMMARY) {
      await writeFile(SUMMARY, JSON.stringify({
        ...Object.fromEntries(Object.entries(times).map(([name, ms]) => [name, Number.isNaN(ms) ? null : ms])),
        pagesChecked: watch.pagesChecked,
        seriousViolations: watch.seriousViolations,
        otherViolations: watch.otherViolations,
        externalRequests: watch.externalRequests,
        pageErrors: watch.pageErrors,
        machine: { platform: `${platform()} ${release()}`, cpus: cpus().length, cpu: cpus()[0]?.model ?? "", memoryGb: Math.round(totalmem() / 2 ** 30) },
        conditions: `headless Chromium (playwright ${browser?.version() ?? ""}), the demo served on ${DEMO_URL} from dist/demo, no network throttling, one browser profile`,
        build,
      }, null, 2));
    }
  });

  let first: Page | null = null;

  test("1. the first visit starts the demo in this browser, shows its steps, and the home fills in", async () => {
    assert.ok(context);
    const page = await watch.tab(context);
    first = page;
    const started = performance.now();
    await page.goto(`${DEMO_URL}/?market=IT`);
    // The page is there before the demo is ready: the records need no figure.
    await page.locator("#releases").waitFor();
    await homeReady(page, BOOT_LIMIT_MS);
    times.coldReadyMs = Math.round(performance.now() - started);
    assert.match(await text(page), /No campaign is running in this market today\./);
    assert.match(await page.locator("meta[name='robots']").getAttribute("content") ?? "", /noindex/);
    assert.match(await page.locator("footer").innerText(), /Your data stays in this browser\./);
    await watch.accessible(page, "the home in the sandbox");
  });

  test("2. a second tab is ready at once: the worker is the one of the origin", async () => {
    assert.ok(context);
    const page = await watch.tab(context);
    const started = performance.now();
    await page.goto(`${DEMO_URL}/?market=IT`);
    await homeReady(page, 30_000);
    times.secondTabMs = Math.round(performance.now() - started);
    assert.ok(times.secondTabMs < 10_000, `the second tab took ${times.secondTabMs} ms`);
    await page.close();
  });

  test("3. a campaign launched from another tab reaches the site", async () => {
    assert.ok(context && first);
    const other = await watch.tab(context);
    await other.goto(`${DEMO_URL}/404.html`);
    await connectWorker(other, build);
    const status = await demoCommand(other, "status");
    assert.equal(status.status, 200, JSON.stringify(status.body));
    const now = new Date(status.body.now as string);
    const starts = romeLocal(new Date(now.getTime() + 2 * 86_400_000));
    const ends = romeLocal(new Date(now.getTime() + 40 * 86_400_000));
    await launchOffer((person) => workerSession(other, person), studentAutumnPass(starts, ends), "demo");
    const skipped = await demoCommand(other, "skip-to-next-launch");
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
    const moved = performance.now();
    await offerFlag(first).waitFor({ timeout: 90_000 });
    times.offerOnSiteMs = Math.round(performance.now() - moved);
    await other.close();
  });

  test("4. the data stays: after a reload, and after every tab closed and the worker started again", async () => {
    assert.ok(context && first);
    const reloaded = performance.now();
    await first.reload();
    await homeReady(first, 60_000);
    await offerFlag(first).waitFor({ timeout: 30_000 });
    times.reloadMs = Math.round(performance.now() - reloaded);

    for (const page of context.pages()) await page.close();
    // The origin's worker ends with its last tab; the next one starts it from this browser's storage.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const page = await watch.tab(context);
    first = page;
    const restarted = performance.now();
    await page.goto(`${DEMO_URL}/?market=IT`);
    await homeReady(page, BOOT_LIMIT_MS);
    await offerFlag(page).waitFor({ timeout: 30_000 });
    times.restartMs = Math.round(performance.now() - restarted);
  });

  test("5. Start over puts the demo back as it was built, in every tab", async () => {
    assert.ok(context && first);
    const second = await watch.tab(context);
    await second.goto(`${DEMO_URL}/?market=IT`);
    await homeReady(second, 30_000);
    await offerFlag(second).waitFor({ timeout: 30_000 });

    await first.getByRole("button", { name: "About this sandbox" }).click();
    const about = first.getByRole("region", { name: "About this sandbox" });
    await about.waitFor();
    assert.match(await about.innerText(), /IndexedDB/);
    await watch.accessible(first, "the panel about the sandbox");
    await about.getByRole("button", { name: "Start over" }).click();
    const reloads = Promise.all([first.waitForEvent("load", { timeout: 60_000 }), second.waitForEvent("load", { timeout: 60_000 })]);
    const started = performance.now();
    await about.getByRole("button", { name: "Yes, start over" }).click();
    await reloads;
    for (const page of [first, second]) {
      await homeReady(page, 60_000);
      await page.getByText("No campaign is running in this market today.").waitFor({ timeout: 30_000 });
    }
    times.startOverMs = Math.round(performance.now() - started);
    assert.equal(await offerFlag(second).count(), 0, "the campaign is gone in the other tab too");
  });

  test("6. no request left the origin, and no page logged an error", () => {
    assert.equal(watch.externalRequests, 0);
    assert.deepEqual(watch.pageErrors, []);
    assert.ok(watch.pagesChecked >= 2, `axe ran on ${watch.pagesChecked} pages`);
  });
});
