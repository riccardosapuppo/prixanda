// The console in the assembled demo (stage 8; docs/business.md §13.3, §14.1,
// §14.6): dist/demo/ served on DEMO_URL (npm run demo:serve, or the check's
// suite demo), headless Chromium, one browser and two tabs, as a recruiter
// has them: the console at /console/ and the site at /, sharing the origin's
// one worker. The path is the one "Try this" gives, and each of its steps
// ticks itself on the way.
//
//   1. The first visit starts the demo in this browser: its steps, then the entry.
//   2. "Try this" opens the site in a second tab, ready at once.
//   3. Marketing writes the Student Autumn Pass and submits it, and finds no
//      way to approve it; Finance approves it; Marketing schedules its launch.
//   4. A simulated fault armed at publish, then "Skip to the launch": the
//      launch meets the fault, recovers, and its timeline shows both.
//   5. The site finds the campaign, from "Try this": every step is ticked.
//   6. The data stays after a reload.
//   7. Start over puts the demo back as it was built, in both tabs.
//   8. A wrong address in the console shows the console's own page, with the
//      demo's words and the line on where the data stays.
//   9. No request left the origin, no page logged an error, axe found nothing serious.
//
// Each step is timed, and the times are written with the machine and the
// conditions they were taken under (CONSOLE_DEMO_SUMMARY).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { after, before, describe, test } from "node:test";
import { AxeBuilder } from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright";
import { animationsEnded } from "./animations.ts";

const DEMO_URL = process.env["DEMO_URL"] ?? `http://127.0.0.1:${process.env["DEMO_PORT"] ?? 4651}`;
const SUMMARY = process.env["CONSOLE_DEMO_SUMMARY"] ?? "";
/** How long the first start may take on this machine: Python, the database and the engine, from the build's own files. */
const BOOT_LIMIT_MS = 120_000;

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let consoleTab: Page | null = null;
let siteTab: Page | null = null;
let build = "";
const seen = { externalRequests: 0, pageErrors: [] as string[], pagesChecked: 0, seriousViolations: 0, otherViolations: 0 };
const times = { coldReadyMs: Number.NaN, secondTabMs: Number.NaN, launchMs: Number.NaN, reloadMs: Number.NaN, startOverMs: Number.NaN };

/** A tab of the recruiter's browser, whose errors are kept. */
async function tab(): Promise<Page> {
  assert.ok(context);
  const page = await context.newPage();
  watch(page);
  return page;
}

function watch(page: Page): void {
  page.on("pageerror", (error) => seen.pageErrors.push(`${page.url()}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") seen.pageErrors.push(`${page.url()}: ${message.text()}`);
  });
}

/**
 * axe on the page as it stands, once what comes in animated is in (e2e/animations.ts): WCAG 2.2 A and AA. Serious
 * or critical violations fail the step.
 */
async function accessible(page: Page, where: string): Promise<void> {
  await animationsEnded(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  seen.pagesChecked += 1;
  seen.seriousViolations += serious.length;
  seen.otherViolations += results.violations.length - serious.length;
  assert.deepEqual(serious.map((violation) => `${violation.id}: ${violation.nodes.slice(0, 2).map((node) => node.target.join(" ")).join(" | ")}`), [], `axe on ${where}`);
}

/**
 * The page's animations at a fraction of their speed, through the browser's own protocol, until restore(): what comes
 * in fading takes that much longer, as on a machine far slower than this one.
 */
async function slowAnimations(page: Page, rate: number): Promise<{ restore: () => Promise<void> }> {
  assert.ok(context);
  const session = await context.newCDPSession(page);
  await session.send("Animation.enable");
  await session.send("Animation.setPlaybackRate", { playbackRate: rate });
  return {
    async restore() {
      await session.send("Animation.setPlaybackRate", { playbackRate: 1 });
      await session.detach();
    },
  };
}

/** The demo's words in the console's frame (business book §13.3): the beginning is enough to find them. */
const DISCLAIMER = "Independent personal project. Fictional business and synthetic customer data.";

/** In sight without scrolling anything: inside the window, and inside every box around it that clips what overflows. */
async function inSight(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || box.top < 0 || box.bottom > innerHeight) return false;
    for (let at = element.parentElement; at !== null; at = at.parentElement) {
      if (getComputedStyle(at).overflowY === "visible") continue;
      const clip = at.getBoundingClientRect();
      if (box.top < clip.top - 1 || box.bottom > clip.bottom + 1) return false;
    }
    return true;
  });
}

/** The demo has started in this tab: the start is gone. */
async function started(page: Page, timeout: number): Promise<void> {
  await page.locator("[data-sandbox='starting']").waitFor({ state: "detached", timeout });
}

const tryThis = (page: Page) => page.getByRole("region", { name: "Try this" });

/** The steps of "Try this" that are done, by number. */
async function stepsDone(page: Page): Promise<number[]> {
  const items = await tryThis(page).getByRole("listitem").allInnerTexts();
  return items.flatMap((text, index) => (text.startsWith("Done:") ? [index + 1] : []));
}

/** Waits until the steps of "Try this" up to a number are done. */
async function doneUpTo(page: Page, last: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  let done: number[] = [];
  while (Date.now() < deadline) {
    done = await stepsDone(page);
    if (Array.from({ length: last }, (_, index) => index + 1).every((step) => done.includes(step))) return;
    await page.waitForTimeout(250);
  }
  assert.fail(`"Try this" has steps ${done.join(", ") || "none"} done, not 1 to ${last}`);
}

/** Switches person from the rail's menu, as the recruiter would. */
async function switchTo(page: Page, label: string): Promise<void> {
  const menu = page.getByLabel("Signed in as");
  await menu.selectOption({ label });
  const deadline = Date.now() + 30_000;
  while ((await menu.locator("option:checked").textContent()) !== label || await menu.isDisabled()) {
    assert.ok(Date.now() < deadline, `the rail still says ${await menu.locator("option:checked").textContent()}, not ${label}`);
    await page.waitForTimeout(100);
  }
}

async function click(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await target.click();
}

describe("the console in the demo's sandbox: the recruiter's path, two tabs, one worker", () => {
  before(async () => {
    const served = await fetch(`${DEMO_URL}/demo-build.json`).catch(() => null);
    if (served === null || !served.ok) throw new Error(`no demo on ${DEMO_URL}: npm run demo:build, then npm run demo:serve`);
    build = ((await served.json()) as { build: string }).build;
    // No host but the demo's own can be reached, whatever asks: a page, a worker, the engine's Python.
    browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"] });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-GB", timezoneId: "Europe/Rome" });
    const origin = new URL(DEMO_URL).host;
    context.on("request", (request) => {
      if (!request.url().startsWith("data:") && !request.url().startsWith("blob:") && new URL(request.url()).host !== origin) seen.externalRequests += 1;
    });
  });

  after(async () => {
    await browser?.close();
    if (SUMMARY) {
      await writeFile(SUMMARY, JSON.stringify({
        ...Object.fromEntries(Object.entries(times).map(([name, ms]) => [name, Number.isNaN(ms) ? null : ms])),
        ...seen,
        machine: { platform: `${platform()} ${release()}`, cpus: cpus().length, cpu: cpus()[0]?.model ?? "", memoryGb: Math.round(totalmem() / 2 ** 30) },
        conditions: `headless Chromium (playwright ${browser?.version() ?? ""}), the demo served on ${DEMO_URL} from dist/demo, no network throttling, one browser profile`,
        build,
      }, null, 2));
    }
  });

  test("1. the first visit starts the demo in this browser, shows its steps, then the entry", async () => {
    const page = await tab();
    consoleTab = page;
    const begun = performance.now();
    await page.goto(`${DEMO_URL}/console/`);
    await page.locator("[data-sandbox='starting']").waitFor({ timeout: 30_000 });
    assert.match(await page.getByRole("status").filter({ hasText: "Starting the demo in this browser" }).innerText(), /Nothing is sent anywhere/);
    await page.getByRole("heading", { name: "Choose who you are in the demo" }).waitFor({ timeout: BOOT_LIMIT_MS });
    await started(page, BOOT_LIMIT_MS);
    times.coldReadyMs = Math.round(performance.now() - begun);
    assert.match(await page.locator("meta[name='robots']").getAttribute("content") ?? "", /noindex/);
    assert.match(await page.locator("footer").last().innerText(), /Your data stays in this browser\./);
    await accessible(page, "the entry in the sandbox");
    await click(page.getByRole("button", { name: "Enter as Marketing", exact: true }));
    await tryThis(page).waitFor();
    assert.deepEqual(await stepsDone(page), []);
    // Try this and the demo's controls make the rail taller than the window: they scroll above the person and the
    // demo's words, which stay in sight at the rail's foot.
    assert.ok(await inSight(page.getByLabel("Signed in as")), "the person's menu is in sight");
    assert.ok(await inSight(page.locator("header.rail").getByText(DISCLAIMER)), "the demo's words are in sight");
    // A shadow at the foot of what scrolls says that more of the rail is below, until its end is in sight.
    const rail = page.locator("header.rail [data-rail-scroll]");
    const cue = page.locator("header.rail .rail-cue");
    await cue.waitFor({ state: "visible", timeout: 10_000 });
    await rail.evaluate((box) => box.scrollTo({ top: box.scrollHeight }));
    await cue.waitFor({ state: "detached", timeout: 10_000 });
    await rail.evaluate((box) => box.scrollTo({ top: 0 }));
    await accessible(page, "the home in the sandbox, with Try this and the demo's controls");
  });

  test("2. Try this opens the site in a second tab, ready at once", async () => {
    assert.ok(context && consoleTab);
    const begun = performance.now();
    const [page] = await Promise.all([context.waitForEvent("page"), click(tryThis(consoleTab).getByRole("link", { name: "Open the site" }))]);
    siteTab = page;
    watch(page);
    await page.waitForLoadState();
    await started(page, 30_000);
    await page.getByRole("radio", { name: "Italy" }).waitFor({ timeout: 30_000 });
    times.secondTabMs = Math.round(performance.now() - begun);
    assert.ok(times.secondTabMs < 15_000, `the second tab took ${times.secondTabMs} ms`);
    await doneUpTo(consoleTab, 1);
  });

  test("3. Marketing writes the campaign and cannot approve it; Finance approves it; Marketing schedules its launch", async () => {
    const page = consoleTab;
    assert.ok(page);
    await page.bringToFront();
    await click(page.getByRole("link", { name: "Campaigns" }).first());
    await click(page.getByRole("link", { name: "New campaign" }));
    await click(page.getByRole("button", { name: "Fill in the Student Autumn Pass" }));
    for (const heading of ["Price", "Dates", "Page", "Check and submit"]) {
      await click(page.getByRole("button", { name: "Continue" }));
      await page.getByRole("heading", { name: heading, level: 2 }).waitFor();
    }
    await click(page.getByRole("button", { name: "Save v1 and check it" }));
    await page.getByLabel("The change in business words").waitFor({ timeout: 60_000 });
    assert.match(await page.getByLabel("The change in business words").innerText(), /Italy, Student: from €5\.79 to €2\.99 for 3 months/);
    await accessible(page, "the check of v1 in the sandbox");
    await page.getByLabel(/Why is it worth running\?/).fill("Students who join in the autumn stay: the pass pays for itself in the second year.");
    await click(page.getByRole("button", { name: "Submit v1 for approval" }));
    await page.getByText("v1 is in approval.", { exact: true }).waitFor();
    await doneUpTo(page, 2);

    // The author opens the approval page: no button, and the reason why.
    await click(page.getByRole("link", { name: "Open the approval page" }));
    await page.getByText("You wrote v1. Someone else has to approve it.").waitFor();
    assert.equal(await page.getByRole("button", { name: /^Approve/ }).count(), 0);
    await doneUpTo(page, 3);

    await switchTo(page, "Finance");
    await click(page.getByRole("button", { name: "Approve v1 as Finance" }));
    await click(page.getByRole("dialog").getByRole("button", { name: "Approve v1" }));
    await page.getByText(/Approved v1 as Finance/).waitFor();
    await doneUpTo(page, 4);

    await switchTo(page, "Marketing");
    await click(page.getByRole("button", { name: "Schedule the launch" }));
    await click(page.getByRole("dialog").getByRole("button", { name: "Schedule the launch" }));
    await page.getByText(/^Scheduled\. It starts at Italy:/).waitFor();
    await doneUpTo(page, 5);
  });

  test("4. a simulated fault at publish, then Skip to the launch: the launch meets it, recovers, and its timeline shows both", async () => {
    const page = consoleTab;
    assert.ok(page);
    const controls = page.getByRole("region", { name: "Demo controls" });
    await controls.getByLabel("Cause a fault at the step").selectOption("publish");
    await click(controls.getByRole("button", { name: "Arm" }));
    await controls.getByText("Fault armed at publish.").waitFor();
    assert.match(await controls.innerText(), /Simulated, and said so: real faults run on the full system/);
    const skip = controls.getByRole("button", { name: "Skip to the launch" });
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((each) => each.textContent?.includes("Skip to the launch"));
      return button !== undefined && !button.disabled;
    }, null, { timeout: 30_000 });
    const begun = performance.now();
    await click(skip);
    const said = controls.getByText(/met the simulated fault at publish and recovered/);
    await said.waitFor({ timeout: 120_000 });
    times.launchMs = Math.round(performance.now() - begun);
    await doneUpTo(page, 6);
    // The console's clock is the demo's: it moved on with the launch, to its change's start.
    const moved = /to (\d{1,2}) ([A-Z][a-z]{2}) \d{2}:\d{2} Rome/.exec(await said.innerText());
    assert.ok(moved, await said.innerText());
    const clock = page.getByText(/^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} in Rome$/).first();
    await page.waitForFunction(([day, month]) => [...document.querySelectorAll("p")].some((each) => new RegExp(`^[A-Z][a-z]+day ${day} ${month}`).test(each.textContent?.trim() ?? "")),
      [String(Number(moved[1])), moved[2] ?? ""], { timeout: 30_000 });
    assert.match(await clock.innerText(), new RegExp(`^[A-Z][a-z]+day ${Number(moved[1])} ${moved[2]}`));

    await click(page.getByRole("link", { name: "Launches" }).first());
    const run = page.getByRole("link", { name: /^launch-/ }).first();
    await click(run);
    await page.getByRole("heading", { name: /^Launch timeline: / }).waitFor();
    // The timeline's parts may come after its title: each is waited for, not read once.
    const main = page.locator("main");
    await main.getByText("attempt 2 of 5").first().waitFor({ timeout: 30_000 }); // the publish step's second attempt, after the fault
    await main.getByText("Student Autumn Pass v1 is live on the site.").first().waitFor({ timeout: 30_000 });
    await accessible(page, "a launch's timeline after a simulated fault");
  });

  test("5. the site finds the campaign from Try this, and every step is ticked", async () => {
    assert.ok(context && consoleTab && siteTab);
    await siteTab.close();
    const [page] = await Promise.all([context.waitForEvent("page"), click(tryThis(consoleTab).getByRole("link", { name: "Open the site again" }))]);
    siteTab = page;
    watch(page);
    await page.waitForLoadState();
    await started(page, 30_000);
    await page.getByRole("link", { name: /Student Autumn Pass/ }).first().waitFor({ timeout: 60_000 });
    await doneUpTo(consoleTab, 7);
    await tryThis(consoleTab).getByText("Every step is done. Start over to see it again from the start.").waitFor();
  });

  test("6. the data stays after a reload", async () => {
    const page = consoleTab;
    assert.ok(page);
    const begun = performance.now();
    await page.reload();
    // The site's tab keeps the worker, and with it the console's session: the page comes back as it was.
    await page.getByRole("link", { name: "Campaigns" }).first().waitFor({ timeout: 60_000 });
    await started(page, 60_000);
    await click(page.getByRole("link", { name: "Campaigns" }).first());
    await page.getByRole("row", { name: /Student Autumn Pass/ }).filter({ hasText: "Live" }).first().waitFor({ timeout: 30_000 });
    times.reloadMs = Math.round(performance.now() - begun);
    await doneUpTo(page, 7);
  });

  test("7. Start over puts the demo back as it was built, in both tabs", async () => {
    const page = consoleTab;
    assert.ok(page && siteTab);
    await click(page.getByRole("button", { name: "About this sandbox" }));
    const about = page.getByRole("region", { name: "About this sandbox" });
    await about.waitFor();
    assert.match(await about.innerText(), /IndexedDB/);
    await accessible(page, "the panel about the sandbox");
    // The confirmation comes in fading, here ten times slower than it does: measured before its animation ended, its
    // buttons would be half transparent, as they were on a slow machine. axe measures it once it is in.
    const slowed = await slowAnimations(page, 0.1);
    await click(about.getByRole("button", { name: "Start over" }));
    const dialog = page.getByRole("dialog", { name: "Start over?" });
    await dialog.waitFor();
    await accessible(page, "the confirmation of Start over");
    await slowed.restore();
    const reloads = Promise.all([page.waitForEvent("load", { timeout: 60_000 }), siteTab.waitForEvent("load", { timeout: 60_000 })]);
    const begun = performance.now();
    await click(dialog.getByRole("button", { name: "Yes, start over" }));
    await reloads;
    await started(page, 60_000);
    await started(siteTab, 60_000);
    await siteTab.getByText("No campaign is running in this market today.").waitFor({ timeout: 30_000 });
    times.startOverMs = Math.round(performance.now() - begun);
    // Back at the start: the demo's people enter again, and Try this starts from its first step.
    await page.getByRole("heading", { name: "Choose who you are in the demo" }).waitFor({ timeout: 30_000 });
    await click(page.getByRole("button", { name: "Enter as Marketing", exact: true }));
    await tryThis(page).waitFor();
    assert.deepEqual(await stepsDone(page), []);
    await click(page.getByRole("link", { name: "Campaigns" }).first());
    await page.getByRole("heading", { name: "Campaigns", level: 1 }).waitFor();
    // The list read, not still on its way: its empty state says so.
    await page.getByText("No campaign here yet.").first().waitFor({ timeout: 30_000 });
    assert.equal(await page.getByRole("row", { name: /Student Autumn Pass/ }).count(), 0, "the campaign is gone");
  });

  test("8. a wrong address in the console shows its own page, with the demo's words and the line on where the data stays", async () => {
    assert.ok(context);
    // A tab of its own, not watched: the address answers 404, which the browser logs as an error of the page.
    const page = await context.newPage();
    const answer = await page.goto(`${DEMO_URL}/console/no-such-page/`);
    assert.equal(answer?.status(), 404);
    await page.getByRole("heading", { name: "Nothing at this address", level: 1 }).waitFor({ timeout: 30_000 });
    assert.ok(await inSight(page.getByText(DISCLAIMER)), "the demo's words are in sight");
    await page.locator("footer").getByText(/^Your data stays in this browser\./).waitFor({ timeout: 30_000 });
    await accessible(page, "the console's page for a wrong address");
    await page.close();
  });

  test("9. no request left the origin, and no page logged an error", () => {
    assert.equal(seen.externalRequests, 0);
    assert.deepEqual(seen.pageErrors, []);
    assert.ok(seen.pagesChecked >= 5, `axe ran on ${seen.pagesChecked} pages`);
  });
});
