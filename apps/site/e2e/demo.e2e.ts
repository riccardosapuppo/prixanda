// The site in the assembled browser demo (stage 8):
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
//   5. Start over puts the demo back as it was built, in every tab. The
//      panel about the sandbox, and its question before starting over, fit
//      every width as they stand.
//   6. A browser that cannot run the demo (no IndexedDB here) is told so,
//      and on a phone's width the button to reload stands under the words,
//      in line with them, not under the icon.
//   7. No request left the origin, and no page logged an error.
//
// Each step is timed, and the times are written with the machine and the
// conditions they were taken under (SITE_DEMO_SUMMARY).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { after, before, describe, test } from "node:test";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { Watch } from "./support/browser.ts";
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
  /** From the same first visit until the home's campaigns are read: they come after the plans. */
  campaignsMs: Number.NaN,
  secondTabMs: Number.NaN,
  /** From the skip to the campaign's launch until the worker answered it: the launch's five steps, run in this browser. */
  launchMs: Number.NaN,
  /** From the same skip until the campaign is on the site's open tab. */
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
    // The campaigns are asked for apart from the plans, and may come later: their sentence is waited for, not read once.
    await page.getByText("No campaign is running in this market today.").waitFor({ timeout: 60_000 });
    times.campaignsMs = Math.round(performance.now() - started);
    assert.match(await page.locator("meta[name='robots']").getAttribute("content") ?? "", /noindex/);
    await page.locator("footer").getByText("Your data stays in this browser.").waitFor({ timeout: 30_000 });
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
    const moved = performance.now();
    const skipped = await demoCommand(other, "skip-to-next-launch");
    times.launchMs = Math.round(performance.now() - moved);
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
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
    assert.deepEqual(await watch.fitsHere(first), [], "the panel about the sandbox fits every width");
    await about.getByRole("button", { name: "Start over" }).click();
    assert.deepEqual(await watch.fitsHere(first), [], "the question before starting over fits every width");
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

  test("6. a browser that cannot run the demo is told so, the button to reload under the words on a phone", async () => {
    const phone = await watch.context(390);
    await phone.addInitScript(() => Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true }));
    const page = await watch.tab(phone);
    await page.goto(`${DEMO_URL}/?market=IT`);
    const bar = page.locator("[data-sandbox='failed']");
    await bar.waitFor({ timeout: 30_000 });
    assert.match(await bar.innerText(), /This browser does not offer IndexedDB/);
    const words = await bar.locator(".sandbox-bar-row > div").boundingBox();
    const button = await bar.getByRole("button", { name: "Reload" }).boundingBox();
    assert.ok(words && button);
    assert.equal(Math.round(button.x), Math.round(words.x), "the button stands under the words, in line with them");
    assert.ok(button.y >= words.y + words.height, "under them, on a line of its own");
    await watch.accessible(page, "a browser that cannot run the demo");
    await phone.close();
  });

  test("7. no request left the origin, and no page logged an error", () => {
    assert.equal(watch.externalRequests, 0);
    assert.deepEqual(watch.pageErrors, []);
    assert.ok(watch.pagesChecked >= 3, `axe ran on ${watch.pagesChecked} pages`);
  });
});
