// The site's end-to-end test (stage 5): the Student Autumn Pass of the
// business book's §14.1, from its launch to a student's demo subscription,
// with the whole system running and a real browser on the site's static
// build.
//
//   1. Before the launch, Italy has no campaign on the site.
//   2. The pass is created, validated, submitted, approved by finance and
//      scheduled through the console's API (the console of stage 4 takes this
//      part when the two are joined). The engine's clock crosses 09:00 in
//      Rome on 26 October, the morning after the clocks go back, and the
//      time until the open page shows the campaign is measured.
//   3. The campaign page shows the engine's prices and where they go.
//   4. A student who has not verified yet enters as a demo listener, is
//      verified by the simulated provider, and confirms the demo subscription
//      at 2,99 € a month for 3 months, then 5,79 €; the account shows it, and
//      its first month's payment settles with a demo receipt.
//   5. A student who paid before is told the pass is not for them.
//   6. The audit log holds every step, each with the request id that caused
//      it: the console's for the launch, the browser's own for the student.
//   7. A verified student takes the pass from the home on the keyboard alone,
//      and nothing moves while they do.
//   8. The home, the campaign, a listening session and the account fit 1440,
//      1280, 720 (1440 at 200 %), 390 and 320 pixels: no sideways scroll, no
//      text cut off.
//
// Every page is checked with axe (no serious or critical violation), no page
// may ask anything of another host, and none may log an error. Run by
// npm run e2e -w site, and by npm run check (suite site-e2e), which also
// reads the summary this file writes (SITE_E2E_SUMMARY).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { AxeBuilder } from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright";
import { ConsoleSession, launchOffer, studentAutumnPass } from "./support/console.ts";
import { CONSOLE_API, PUBLIC_API, SITE_URL, type Stack, startStack } from "./support/stack.ts";

/** The engine's clock at the start: the last day of the generated data. */
const START = "2026-10-24T10:00:00Z";
/** Two minutes before the pass starts. */
const BEFORE = "2026-10-26T07:58:00Z";
/** 09:00 in Rome on 26 October is 08:00 UTC: the clocks went back the night before (§3.7). */
const PAST_THE_START = "2026-10-26T08:00:05Z";
/** How long an open page may take to show a launched campaign: its refresh, the activation, a margin. */
const SITE_LIMIT_MS = 30_000;
/** The widths every page must fit: desktop, laptop, 1440 at 200 % zoom, phone, narrow phone. */
const WIDTHS = [1440, 1280, 720, 390, 320] as const;

const SUMMARY = process.env["SITE_E2E_SUMMARY"] ?? "";

type Seen = { operation: string; requestId: string; variables: Record<string, unknown> };

let stack: Stack | null = null;
let browser: Browser | null = null;
const summary = {
  activationMs: Number.NaN,
  siteMs: Number.NaN,
  paymentMs: Number.NaN,
  changeId: "",
  listenerId: "",
  auditEvents: 0,
  pagesChecked: 0,
  layoutChecks: 0,
  seriousViolations: 0,
  otherViolations: 0,
  externalRequests: 0,
  pageErrors: [] as string[],
  subscription: null as null | { price: string; months: string; then: string; fullPriceFrom: string; payment: string },
};
const consoleIds: Record<string, string> = {};
const siteRequests: Seen[] = [];

/** A browser of its own (cookies included) that counts what it must not do. */
async function newVisitor(width = 1280): Promise<{ context: BrowserContext; page: Page }> {
  assert.ok(browser);
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, locale: "en-GB", timezoneId: "Europe/Rome" });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      summary.externalRequests += 1;
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") summary.pageErrors.push(message.text());
  });
  page.on("pageerror", (error) => summary.pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.url() !== PUBLIC_API || request.method() !== "POST") return;
    const body = request.postDataJSON() as { operationName?: string; variables?: Record<string, unknown> } | null;
    siteRequests.push({ operation: body?.operationName ?? "", requestId: request.headers()["x-request-id"] ?? "", variables: body?.variables ?? {} });
  });
  return { context, page };
}

/** axe on the page as it is now: serious and critical violations fail the test. */
async function accessible(page: Page, where: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  summary.pagesChecked += 1;
  const serious = result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  summary.seriousViolations += serious.length;
  summary.otherViolations += result.violations.length - serious.length;
  assert.deepEqual(serious.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`), [], `axe on ${where}`);
}

async function publicOffers(): Promise<Array<{ id: string }>> {
  const response = await fetch(PUBLIC_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: '{ offers(market: "IT") { id } }' }),
  });
  const body = await response.json() as { data?: { offers?: Array<{ id: string }> } };
  return body.data?.offers ?? [];
}

/** The page's main text, with the no-break spaces a price is written with read as spaces. */
const text = async (page: Page) => (await page.locator("main").innerText()).replace(/[  ]/g, " ");

/** Presses Tab until the target has the focus, as a visitor on the keyboard would. */
async function tabTo(page: Page, target: Locator, most = 80): Promise<void> {
  for (let presses = 0; presses < most; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  assert.fail(`${String(target)} is not reached with Tab in ${most} presses`);
}

/** What does not fit the window: a sideways scroll, text past its edge, text cut off by its box. */
async function misfits(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const found: string[] = [];
    if (root.scrollWidth > root.clientWidth) found.push(`the page scrolls sideways by ${root.scrollWidth - root.clientWidth} px`);
    const name = (element: Element) => `${element.tagName.toLowerCase()}${[...element.classList].map((each) => `.${each}`).join("")}`;
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      if (element.closest("svg, [class*='sr-only']")) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const words = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
      if (!words) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > root.clientWidth + 1 || box.left < -1) found.push(`past the edge: ${name(element)} "${(element.textContent ?? "").trim().slice(0, 40)}"`);
      const hidesX = style.overflowX === "hidden" || style.overflowX === "clip";
      const hidesY = style.overflowY === "hidden" || style.overflowY === "clip";
      if ((hidesX && element.scrollWidth > element.clientWidth + 1) || (hidesY && element.scrollHeight > element.clientHeight + 1)) {
        found.push(`cut off: ${name(element)} "${(element.textContent ?? "").trim().slice(0, 40)}"`);
      }
    }
    return found;
  });
}

describe("the Student Autumn Pass from its launch to a student's demo subscription (§14.1)", () => {
  before(async () => {
    stack = await startStack(START);
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
    const stopped = await stack?.stop();
    if (SUMMARY) {
      await writeFile(SUMMARY, JSON.stringify({
        ...summary,
        engineExit: stopped?.engineExit ?? null,
        activationMs: Number.isNaN(summary.activationMs) ? null : summary.activationMs,
        siteMs: Number.isNaN(summary.siteMs) ? null : summary.siteMs,
        paymentMs: Number.isNaN(summary.paymentMs) ? null : summary.paymentMs,
      }, null, 2));
    }
  });

  let watcher: Page | null = null;

  test("1. before the launch, the site has no campaign in Italy", async () => {
    const { page } = await newVisitor();
    watcher = page;
    await page.goto(`${SITE_URL}/?market=IT`);
    await page.getByText("No campaign is running in this market today.").waitFor();
    await page.getByRole("radio", { name: "Italy" }).waitFor();
    assert.equal(await page.getByRole("radio", { name: "Italy" }).isChecked(), true);
    await accessible(page, "the plans before the launch");
  });

  test("2. launched through the console's API, the pass is on the open page within a measured time", async () => {
    assert.ok(stack && watcher);
    const launched = await launchOffer(CONSOLE_API, studentAutumnPass("2026-10-26T09:00", "2026-11-30T00:00"), "site");
    summary.changeId = launched.changeId;
    Object.assign(consoleIds, launched.requestIds);

    // Two minutes before 09:00 in Rome the engine has nothing to activate.
    await stack.engine.at(BEFORE);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.deepEqual(await publicOffers(), []);

    await stack.engine.at(PAST_THE_START);
    const moved = performance.now();
    const onTheSite = watcher.getByRole("link", { name: /Student Autumn Pass/ }).waitFor({ timeout: SITE_LIMIT_MS })
      .then(() => (summary.siteMs = Math.round(performance.now() - moved)));
    for (;;) {
      if ((await publicOffers()).some((offer) => offer.id === launched.changeId)) break;
      assert.ok(performance.now() - moved < 20_000, "the engine did not publish the pass within 20 s");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    summary.activationMs = Math.round(performance.now() - moved);
    await onTheSite;
    assert.ok(summary.siteMs < SITE_LIMIT_MS, `on the site after ${summary.siteMs} ms`);
    const auditor = await new ConsoleSession(CONSOLE_API, "auditor-1").signIn();
    const change = await auditor.graphql("query ($id: ID!) { change(id: $id) { state } }", { id: launched.changeId });
    assert.equal(change.body?.data?.change?.state, "ACTIVE", change.text);
  });

  test("3. the campaign page shows the engine's prices, its months and where the price goes", async () => {
    assert.ok(watcher);
    await watcher.getByRole("link", { name: /Student Autumn Pass/ }).click();
    await watcher.getByRole("heading", { level: 1, name: "Student Autumn Pass" }).waitFor();
    assert.match(watcher.url(), new RegExp(`/campaign/\\?market=IT&offer=${summary.changeId}$`));
    const page = await text(watcher);
    assert.match(page, /Three months of Student for 2,99 € a month\./);
    assert.match(page, /Usual price\s*5,79 €/);
    assert.match(page, /2,99 €\s*a month for 3 months, VAT included/);
    for (const month of [1, 2, 3]) assert.match(page, new RegExp(`2,99 €\\s*Month ${month}`));
    assert.match(page, /5,79 €\s*Then the Student price in force/);
    assert.match(page, /Students in Italy · until 29 November/);
    // §5.3: the pool's share of 2,99 € is 1,47 €; the service adds 1,53 € to reach the 3,00 € minimum.
    assert.match(page, /Your 2,99 € is below what the artists' minimum needs, so \S+ adds 1,53 € a month and they still get 3,00 €\./);
    assert.match(page, /1,47 €\s*from your 2,99 €/);
    assert.match(page, /Take it by 29 November 2026\./);
    await accessible(watcher, "the campaign page");
  });

  test("4. a student who has not verified yet is verified, subscribes at 2,99 € for 3 months, then 5,79 €, and the first month settles", async () => {
    const { page } = await newVisitor();
    await page.goto(`${SITE_URL}/campaign/?market=IT&offer=${summary.changeId}`);
    await page.getByRole("button", { name: "Check I'm a student" }).click();
    await page.getByRole("heading", { name: "Enter as a demo listener" }).waitFor();
    await accessible(page, "the entrance");
    await page.getByLabel(/Student in Italy, not verified yet/).check();
    await page.getByRole("button", { name: "Enter as this listener" }).click();

    await page.getByRole("heading", { name: "Student check" }).waitFor();
    summary.listenerId = String(siteRequests.find((seen) => seen.operation === "SiteSignIn")?.variables["listenerId"] ?? "");
    await accessible(page, "the student check");
    await page.getByRole("button", { name: "Check with the provider" }).click();

    await page.getByRole("heading", { name: "Confirm your demo subscription" }).waitFor();
    const confirm = await text(page);
    assert.match(confirm, /Verified as a student by the simulated provider, valid until 25 October 2027\./);
    assert.match(confirm, /2,99 € a month for 3 months, then 5,79 € a month, the Student price in force at that time \(VAT included\)\./);
    assert.match(confirm, /Independent personal project\. Fictional business and synthetic customer data\. No real payments are processed\./);
    await accessible(page, "the confirmation");

    const confirmed = performance.now();
    await page.getByRole("button", { name: "Confirm demo subscription" }).click();
    await page.waitForURL(`${SITE_URL}/account/`);
    await page.getByRole("heading", { level: 1, name: "Account" }).waitFor();
    await page.locator("[data-payment-state='SUCCEEDED']").waitFor({ timeout: 30_000 });
    summary.paymentMs = Math.round(performance.now() - confirmed);
    const account = await text(page);
    assert.match(account, /Plan\s*Student, Italy/);
    assert.match(account, /Price\s*2,99 € a month/);
    assert.match(account, /Offer\s*Student Autumn Pass: 3 of 3 months left at this price/);
    assert.match(account, /After the offer\s*5,79 € a month from 26 January 2027/);
    assert.match(account, /Student check\s*Valid until 25 October 2027, simulated provider/);
    assert.match(account, /Paid\. The simulated provider took the first month\./);
    assert.match(account, /Demo receipt: No money moved\./);
    await accessible(page, "the account");

    summary.subscription = { price: "2,99 €", months: "3", then: "5,79 €", fullPriceFrom: "26 January 2027", payment: "SUCCEEDED" };
  });

  test("5. a student who paid before is told the pass is not for them, and offered the plan's own price", async () => {
    const { page } = await newVisitor();
    await page.goto(`${SITE_URL}/campaign/?market=IT&offer=${summary.changeId}`);
    await page.getByRole("button", { name: "Check I'm a student" }).click();
    await page.getByLabel(/Student in Italy who paid before/).check();
    await page.getByRole("button", { name: "Enter as this listener" }).click();
    await page.getByRole("heading", { name: "This offer isn't for this listener" }).waitFor();
    const refused = await text(page);
    assert.match(refused, /It is for: verified students in Italy who have never had a paid plan\./);
    assert.match(refused, /Student is still there at 5,79 € a month\./);
    assert.doesNotMatch(refused, /Confirm demo subscription/);
    await accessible(page, "the refusal");
  });

  test("6. the audit log holds every step with the request id that caused it, and its chain holds", async () => {
    const auditor = await new ConsoleSession(CONSOLE_API, "auditor-1").signIn();
    const read = async (filter: Record<string, string>) => {
      const answer = await auditor.graphql("query ($filter: AuditFilter) { auditEvents(filter: $filter, first: 50) { nodes { seq action actor actorRole requestId subject } } }", { filter });
      return [...(answer.body?.data?.auditEvents?.nodes ?? [])].reverse() as Array<{ action: string; actor: string; actorRole: string; requestId: string; subject: string }>;
    };

    const launch = await read({ subject: `change:${summary.changeId}` });
    assert.deepEqual(launch.map((event) => event.action), [
      "change.created", "change.validated", "change.submitted", "change.approved", "change.scheduled", "change.activated",
    ]);
    for (const event of launch.slice(0, -1)) assert.equal(event.requestId, consoleIds[event.action], `${event.action} carries the console's request id`);
    const activated = launch.at(-1);
    assert.deepEqual({ actor: activated?.actor, role: activated?.actorRole }, { actor: "activation", role: "SYSTEM" });

    const sent = (operation: string) => siteRequests.filter((seen) => seen.operation === operation).map((seen) => seen.requestId);
    const student = await read({ actor: `subscriber-${summary.listenerId}` });
    const verified = student.find((event) => event.action === "student.verified");
    const subscribed = student.find((event) => event.action === "subscription.confirmed");
    assert.ok(verified && subscribed, JSON.stringify(student));
    assert.ok(sent("SiteVerifyStudent").includes(verified.requestId), "student.verified carries the browser's request id");
    assert.ok(sent("SiteConfirmSubscription").includes(subscribed.requestId), "subscription.confirmed carries the browser's request id");
    assert.match(subscribed.requestId, /^site-[0-9a-f-]{36}$/);
    const paid = (await read({ action: "payment.succeeded" })).find((event) => event.requestId === subscribed.requestId);
    assert.ok(paid, "payment.succeeded carries the confirmation's request id");
    summary.auditEvents = launch.length + 2 + 1;

    const exported = await auditor.graphql("mutation { exportAuditHead { __typename ... on ChainHead { seq hash } } }");
    const head = exported.body?.data?.exportAuditHead;
    assert.equal(head?.__typename, "ChainHead", exported.text);
    const verifiedChain = await auditor.graphql("query ($anchor: ChainHeadInput) { verifyAuditChain(anchor: $anchor) { ok brokenAt } }", { anchor: { seq: head.seq, hash: head.hash } });
    assert.deepEqual(verifiedChain.body?.data?.verifyAuditChain, { ok: true, brokenAt: null }, verifiedChain.text);
  });

  test("7. on the keyboard alone, a verified student takes the pass from the home, and nothing moves", async () => {
    const { page } = await newVisitor();
    await page.goto(`${SITE_URL}/?market=IT`);
    const flag = page.getByRole("link", { name: /Student Autumn Pass/ });
    await flag.waitFor();
    await tabTo(page, flag);
    assert.equal(await page.evaluate(() => document.documentElement.dataset["input"]), "keyboard");
    await page.keyboard.press("Enter");

    await page.getByRole("heading", { level: 1, name: "Student Autumn Pass" }).waitFor();
    await tabTo(page, page.getByRole("button", { name: "Check I'm a student" }));
    await page.keyboard.press("Enter");
    const entrance = page.getByRole("heading", { name: "Enter as a demo listener" });
    await entrance.waitFor();
    assert.ok(await entrance.evaluate((element) => element === document.activeElement), "the entrance takes the focus");
    // The steps' panel has an entrance; on the keyboard it does not move.
    assert.equal(await page.locator(".is-entering").first().evaluate((element) => getComputedStyle(element).animationDuration), "0s");
    assert.equal(await page.getByLabel(/Student in Italy, verified/).isChecked(), true, "the market's first listener is preselected");
    await tabTo(page, page.getByRole("button", { name: "Enter as this listener" }));
    await page.keyboard.press("Enter");

    const confirmTitle = page.getByRole("heading", { name: "Confirm your demo subscription" });
    await confirmTitle.waitFor();
    assert.ok(await confirmTitle.evaluate((element) => element === document.activeElement), "the confirmation takes the focus");
    await tabTo(page, page.getByRole("button", { name: "Confirm demo subscription" }));
    await page.keyboard.press("Enter");
    await page.waitForURL(`${SITE_URL}/account/`);
    await page.locator("[data-payment-state='SUCCEEDED']").waitFor({ timeout: 30_000 });
    const account = await text(page);
    assert.match(account, /Plan\s*Student, Italy/);
    assert.match(account, /Price\s*2,99 € a month/);
    assert.match(account, /Offer\s*Student Autumn Pass: 3 of 3 months left at this price/);
  });

  test("8. the home, the campaign, a listening session and the account fit every width, without a sideways scroll or text cut off", async () => {
    const pages = [
      { path: "/?market=IT&plan=student", ready: ".plan.is-open .decision", axe: "the home with the pass on sale" },
      { path: `/campaign/?market=IT&offer=${summary.changeId}`, ready: "h1", axe: null },
      { path: "/session/?label=coldframe-records", ready: ".player", axe: "a listening session" },
      { path: "/account/", ready: "h1", axe: null },
    ];
    const misfit: string[] = [];
    for (const width of WIDTHS) {
      const { context, page } = await newVisitor(width);
      for (const each of pages) {
        await page.goto(`${SITE_URL}${each.path}`);
        await page.locator(each.ready).first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        for (const problem of await misfits(page)) misfit.push(`${width} px, ${each.path}: ${problem}`);
        summary.layoutChecks += 1;
        if (width === 1440 && each.axe !== null) await accessible(page, each.axe);
      }
      await context.close();
    }
    assert.deepEqual(misfit, []);
  });

  test("9. no page asked anything of another host, and none logged an error", () => {
    assert.equal(summary.externalRequests, 0);
    assert.deepEqual(summary.pageErrors, []);
    assert.ok(summary.pagesChecked >= 9, `axe ran on ${summary.pagesChecked} pages`);
    assert.equal(summary.layoutChecks, WIDTHS.length * 4);
  });
});
