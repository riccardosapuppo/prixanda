// The site's end-to-end test of the album release (business book §14.2): an
// offer for an artist's listeners, shown only to the listeners in its
// audience (§6.8), with the whole system running and a real browser on the
// site's static build.
//
//   1. Marketing's release offer, launched through the console's API: two
//      months of Individual at 1,99 € in Italy, for the Free listeners who
//      played Ottoline Marr for more than 2 hours in the last 30 days. It
//      reaches a fan's open home within a measured time; a visitor who has
//      not entered is told of nothing.
//   2. The fan is the student who paid before (on Free since June, nearly 3
//      hours of her in the 30 days before 26 October). On the home, the flag
//      says under it who the offer is for, in plain words; on its page, the
//      engine's prices, its months and the artists' share.
//   3. The fan's home and the campaign page fit five widths.
//   4. In one tab, leaving and entering as someone else change what the home
//      shows, without a reload: the offer never shows to the listener who is
//      not a fan, not even for a moment, and comes back with the fan.
//   5. The other two students in Italy, with under an hour of her, and the
//      Individual subscriber, a fan who pays already, are not shown it: not on
//      the home, not at its address, not by the API.
//   6. The fan takes it: 1,99 € a month for 2 months, then 10,49 €, the first
//      month settled by the simulated provider. Paying now, they are no
//      longer in its audience, and no longer shown it.
//   7. The audit log holds the launch with the console's request ids, and the
//      subscription and its payment with the browser's.
//   8. No page asked anything of another host, and none logged an error.
//
// Run by npm run e2e -w site, and by npm run check (suite site-e2e-fans),
// which reads the summary it writes (SITE_E2E_SUMMARY).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { formatSitePrice, type MoneyLike } from "design";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { siteDay } from "../src/lib/dates.ts";
import { text, Watch } from "./support/browser.ts";
import { albumRelease, ConsoleSession, launchChange } from "./support/console.ts";
import { CONSOLE_API, PUBLIC_API, SITE_URL, type Stack, startStack } from "./support/stack.ts";

/** The engine's clock at the start: the last day of the generated data, at noon in Rome. */
const START = "2026-10-24T10:00:00Z";
/** The release goes on sale at 09:00 in Rome on 26 October, until the end of 25 November. */
const STARTS_LOCAL = "2026-10-26T09:00";
const ENDS_LOCAL = "2026-11-26T00:00";
/** Two minutes before 09:00 in Rome, and just after: 08:00 UTC once the clocks went back (§3.7). */
const BEFORE = "2026-10-26T07:58:00Z";
const PAST_THE_START = "2026-10-26T08:00:05Z";
/** How long an open page may take to show an offer that went on sale: its refresh, the activation, a margin. */
const SITE_LIMIT_MS = 30_000;

/** The demo's listeners in Italy, by what the generated listening makes of them on 26 October. */
type Listener = { readonly label: RegExp; readonly id: string };
const FAN: Listener = { label: /Student in Italy who paid before/, id: "5003" };
const NOT_FANS: readonly Listener[] = [
  { label: /Student in Italy, verified/, id: "5001" },
  { label: /Student in Italy, not verified yet/, id: "5002" },
];
const PAYS_ALREADY: Listener = { label: /Individual subscriber in Italy/, id: "5006" };
const FOR_LISTENERS = "For listeners who played Ottoline Marr for more than 2 hours in the last 30 days.";

const SUMMARY = process.env["SITE_E2E_SUMMARY"] ?? "";

let stack: Stack | null = null;
let browser: Browser | null = null;
const watch = new Watch(() => {
  assert.ok(browser);
  return browser;
});
const summary = {
  activationMs: Number.NaN,
  offerOnPageMs: Number.NaN,
  paymentMs: Number.NaN,
  auditEvents: 0,
  notShownTo: [] as string[],
};
let changeId = "";
const consoleIds: Record<string, string> = {};
/** The fan's browser, signed in from test 1 on. */
let fan: { context: BrowserContext; page: Page } | null = null;

type Listed = {
  readonly id: string;
  readonly price: MoneyLike;
  readonly listening: { artistId: string; artist: string; minSeconds: number; withinDays: number } | null;
  readonly breakdown: { readonly artists: MoneyLike; readonly topUp: MoneyLike } | null;
};
const OFFERS = '{ offers(market: "IT") { id price listening { artistId artist minSeconds withinDays } breakdown { artists topUp } } }';

/** The offers in Italy as the gateway lists them to a browser's session; with none, to a visitor who has not entered. */
async function offersFor(context: BrowserContext | null): Promise<Listed[]> {
  const body = context === null
    ? await (await fetch(PUBLIC_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: OFFERS }) })).json()
    : await (await context.request.post(PUBLIC_API, { headers: { "content-type": "application/json", origin: SITE_URL }, data: { query: OFFERS } })).json();
  const answer = body as { data?: { offers?: Listed[] }; errors?: unknown };
  assert.equal(answer.errors, undefined, JSON.stringify(answer.errors));
  return answer.data?.offers ?? [];
}

/** The listener of a browser's session and their subscription, as the gateway answers for its cookie. */
async function account(context: BrowserContext): Promise<any> {
  const response = await context.request.post(PUBLIC_API, {
    headers: { "content-type": "application/json", origin: SITE_URL },
    data: { query: "{ me { id account { subscription { plan paid price offerTitle fullPriceFrom fullPrice } } } }" },
  });
  return ((await response.json()) as { data?: { me?: unknown } }).data?.me;
}

/** Enters at the account's entrance as one of the demo's listeners, and waits until the session is theirs. */
async function enterAs(page: Page, who: Listener): Promise<void> {
  await page.getByLabel(who.label).check();
  await page.getByRole("button", { name: "Enter as this listener" }).click();
  await page.getByRole("button", { name: "Switch listener" }).waitFor();
  assert.equal((await account(page.context()))?.id, who.id, `the session is ${who.id}'s`);
}

/** The release's flag on the home: its link to the campaign page, whose address ends with the offer's id. */
const FLAG = () => `.offer-flag a[href$="offer=${changeId}"]`;
const flag = (page: Page) => page.locator(FLAG());

describe("the album release, shown only to the artist's listeners (§14.2, §6.8)", () => {
  before(async () => {
    stack = await startStack(START);
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
    const stopped = await stack?.stop();
    if (SUMMARY) {
      const ms = (value: number) => (Number.isNaN(value) ? null : value);
      await writeFile(SUMMARY, JSON.stringify({
        ...summary,
        activationMs: ms(summary.activationMs),
        offerOnPageMs: ms(summary.offerOnPageMs),
        paymentMs: ms(summary.paymentMs),
        pagesChecked: watch.pagesChecked,
        layoutChecks: watch.layoutChecks,
        seriousViolations: watch.seriousViolations,
        otherViolations: watch.otherViolations,
        externalRequests: watch.externalRequests,
        pageErrors: watch.pageErrors,
        engineExit: stopped?.engineExit ?? null,
      }, null, 2));
    }
  });

  test("1. launched through the console's API, the release reaches its fan's open home within a measured time, and no visitor", async () => {
    assert.ok(stack);
    fan = await watch.visitor();
    await fan.page.goto(`${SITE_URL}/account/`);
    await enterAs(fan.page, FAN);
    await fan.page.goto(`${SITE_URL}/?market=IT&plan=individual`);
    await fan.page.getByText("No campaign is running in this market today.").waitFor();

    const launched = await launchChange(CONSOLE_API, "release", albumRelease(STARTS_LOCAL, ENDS_LOCAL), "release");
    changeId = launched.changeId;
    Object.assign(consoleIds, launched.requestIds);
    await stack.engine.at(BEFORE);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.deepEqual(await offersFor(fan.context), [], "nothing before 09:00 in Rome");

    await stack.engine.at(PAST_THE_START);
    const moved = performance.now();
    const onThePage = flag(fan.page).waitFor({ timeout: SITE_LIMIT_MS }).then(() => (summary.offerOnPageMs = Math.round(performance.now() - moved)));
    for (;;) {
      if ((await offersFor(fan.context)).some((offer) => offer.id === changeId)) break;
      assert.ok(performance.now() - moved < 20_000, "the engine did not put the release on sale for its fan within 20 s");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    summary.activationMs = Math.round(performance.now() - moved);
    await onThePage;
    assert.deepEqual(await offersFor(null), [], "a visitor who has not entered is told of no release");
  });

  test("2. the fan is shown it at the engine's conditions, and who it is for in plain words", async () => {
    assert.ok(fan);
    const [listed] = (await offersFor(fan.context)).filter((offer) => offer.id === changeId);
    assert.ok(listed?.breakdown);
    assert.deepEqual(listed.price, { amountMinor: "199", currency: "EUR" });
    assert.deepEqual(listed.listening, { artistId: "2", artist: "Ottoline Marr", minSeconds: 7_200, withinDays: 30 });
    const home = await text(fan.page);
    assert.match(home, /On now: Low Tide Hymns, 1,99 € a month for 2 months/);
    assert.ok(home.includes(FOR_LISTENERS), "the flag says who it is for");
    await watch.accessible(fan.page, "the fan's home with the release");

    await flag(fan.page).click();
    await fan.page.getByRole("heading", { level: 1, name: "Low Tide Hymns" }).waitFor();
    assert.match(fan.page.url(), new RegExp(`/campaign/\\?market=IT&offer=${changeId}$`));
    const page = await text(fan.page);
    assert.match(page, /Ottoline Marr's new record is out\./);
    assert.match(page, /Usual price\s*10,49 €/);
    assert.match(page, /1,99 €\s*a month for 2 months, VAT included/);
    for (const month of [1, 2]) assert.match(page, new RegExp(`1,99 €\\s*Month ${month}`));
    assert.match(page, /10,49 €\s*Then the Individual price in force/);
    assert.match(page, /Listeners of Ottoline Marr · until 25 November/);
    assert.ok(page.includes(FOR_LISTENERS), "the details say who it is for");
    assert.match(page, /Take it by 25 November 2026\./);
    // §5.3: below the artists' minimum, the service tops 1,99 € up; the amounts are the engine's breakdown.
    const write = (money: MoneyLike) => formatSitePrice(money, "IT").replace(/[\u00a0\u202f]/g, " ");
    const topUp = write(listed.breakdown.topUp);
    const artists = write(listed.breakdown.artists);
    assert.ok(page.includes(`Your 1,99 € is below what the artists' minimum needs, so `) && page.includes(` adds ${topUp} a month and they still get ${artists}.`),
      `the artists' share, ${topUp} added for ${artists}`);
    await watch.accessible(fan.page, "the release's page");
  });

  test("3. the fan's home and the release's page fit every width, without a sideways scroll or text cut off", async () => {
    assert.ok(fan);
    await fan.page.goto(`${SITE_URL}/?market=IT&plan=individual`);
    const misfit = await watch.fits(fan.page, FLAG());
    await fan.page.goto(`${SITE_URL}/campaign/?market=IT&offer=${changeId}`);
    misfit.push(...await watch.fits(fan.page, "h1"));
    assert.deepEqual(misfit, []);
  });

  test("4. in one tab, leaving and entering as someone else: the offer never shows to the one who is not a fan, and comes back with the fan", async () => {
    const { page } = await watch.visitor();
    const plans = page.locator("#site-nav").getByRole("link", { name: "Plans", exact: true });
    const toAccount = page.getByRole("link", { name: "Account", exact: true });
    const switchListener = page.getByRole("button", { name: "Switch listener" });
    await page.goto(`${SITE_URL}/account/`);
    await enterAs(page, FAN);
    await plans.click();
    await flag(page).waitFor({ timeout: SITE_LIMIT_MS });

    // From here on, the page notes whether the release's flag is ever in the document.
    await page.evaluate((selector) => {
      const seen = window as unknown as { sameDocument: boolean; flagSeen: boolean; watching: boolean };
      seen.sameDocument = true;
      seen.flagSeen = false;
      seen.watching = false;
      const look = () => {
        if (seen.watching && document.querySelector(selector)) seen.flagSeen = true;
      };
      new MutationObserver(look).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }, FLAG());
    const noted = () => page.evaluate(() => {
      const seen = window as unknown as { sameDocument?: boolean; flagSeen?: boolean };
      return { sameDocument: seen.sameDocument === true, flagSeen: seen.flagSeen === true };
    });

    await toAccount.click();
    await switchListener.click();
    await page.getByRole("heading", { name: "Enter as a demo listener" }).waitFor();
    await page.evaluate(() => ((window as unknown as { watching: boolean }).watching = true));
    await enterAs(page, NOT_FANS[0]!);
    await plans.click();
    await page.getByText("No campaign is running in this market today.").waitFor({ timeout: SITE_LIMIT_MS });
    assert.equal(await flag(page).count(), 0);
    const notAFan = await noted();
    assert.equal(notAFan.sameDocument, true, "no reload: the same document all along");
    assert.equal(notAFan.flagSeen, false, "the release never showed to the listener who is not a fan");

    await toAccount.click();
    await switchListener.click();
    await enterAs(page, FAN);
    await plans.click();
    await flag(page).waitFor({ timeout: SITE_LIMIT_MS });
    assert.equal((await noted()).sameDocument, true, "the fan's offer came back without a reload");
  });

  test("5. the listeners outside its audience are not shown it: not on the home, not at its address, not by the API", async () => {
    for (const who of [...NOT_FANS, PAYS_ALREADY]) {
      const { context, page } = await watch.visitor();
      await page.goto(`${SITE_URL}/account/`);
      await enterAs(page, who);
      assert.deepEqual((await offersFor(context)).map((offer) => offer.id), [], `${who.id}: the API lists nothing`);
      await page.goto(`${SITE_URL}/?market=IT&plan=individual`);
      await page.getByText("No campaign is running in this market today.").waitFor();
      assert.equal(await flag(page).count(), 0, `${who.id}: no flag on the home`);
      if (who === NOT_FANS[0]) await watch.accessible(page, "the home of a listener who is not a fan");
      await page.goto(`${SITE_URL}/campaign/?market=IT&offer=${changeId}`);
      await page.getByRole("heading", { name: "This campaign isn't on sale" }).waitFor();
      assert.match(await text(page), /it has ended, it hasn't started yet, or it is only for some listeners\./);
      if (who === NOT_FANS[0]) {
        await watch.accessible(page, "the release's address, for a listener who is not a fan");
      }
      summary.notShownTo.push(who.id);
      await context.close();
    }
  });

  test("6. the fan takes it at 1,99 € for 2 months, then 10,49 €; paying now, they are no longer shown it", async () => {
    assert.ok(fan);
    const { page, context } = fan;
    await page.goto(`${SITE_URL}/campaign/?market=IT&offer=${changeId}`);
    await page.getByRole("button", { name: "Choose Individual" }).click();
    await page.getByRole("heading", { name: "Confirm your demo subscription" }).waitFor();
    const confirm = await text(page);
    assert.match(confirm, /Low Tide Hymns, Individual/);
    assert.match(confirm, /1,99 € a month for 2 months, then 10,49 € a month, the Individual price in force at that time \(VAT included\)\./);
    assert.match(confirm, /Independent personal project\. Fictional business and synthetic customer data\. No real payments are processed\./);
    await watch.accessible(page, "the release's confirmation");

    const confirmed = performance.now();
    await page.getByRole("button", { name: "Confirm demo subscription" }).click();
    await page.waitForURL(`${SITE_URL}/account/`);
    await page.locator("[data-payment-state='SUCCEEDED']").waitFor({ timeout: 30_000 });
    summary.paymentMs = Math.round(performance.now() - confirmed);
    const subscription = (await account(context)).account.subscription;
    assert.deepEqual({ plan: subscription.plan, paid: subscription.paid, price: subscription.price, offer: subscription.offerTitle },
      { plan: "individual", paid: true, price: { amountMinor: "199", currency: "EUR" }, offer: "Low Tide Hymns" });
    const shown = await text(page);
    assert.match(shown, /Plan\s*Individual, Italy/);
    assert.match(shown, /Price\s*1,99 € a month/);
    assert.match(shown, /Offer\s*Low Tide Hymns: 2 of 2 months left at this price/);
    assert.ok(shown.includes(`10,49 € a month from ${siteDay(subscription.fullPriceFrom)}`), "the full price's day is the engine's");
    assert.match(shown, /Paid\. The simulated provider took the first month\./);
    await watch.accessible(page, "the fan's account");

    assert.deepEqual((await offersFor(context)).map((offer) => offer.id), [], "a subscriber who pays is no longer in its audience");
  });

  test("7. the audit log holds the launch with the console's request ids, and the subscription with the browser's", async () => {
    const auditor = await new ConsoleSession(CONSOLE_API, "auditor-1").signIn();
    const read = async (filter: Record<string, string>) => {
      const answer = await auditor.graphql("query ($filter: AuditFilter) { auditEvents(filter: $filter, first: 50) { nodes { seq action actor actorRole requestId subject } } }", { filter });
      return [...(answer.body?.data?.auditEvents?.nodes ?? [])].reverse() as Array<{ action: string; actor: string; actorRole: string; requestId: string }>;
    };
    const launch = await read({ subject: `change:${changeId}` });
    assert.deepEqual(launch.map((event) => event.action), [
      "change.created", "change.validated", "change.submitted", "change.approved", "change.scheduled", "change.activated",
    ]);
    for (const event of launch.slice(0, -1)) assert.equal(event.requestId, consoleIds[event.action], `${event.action} carries the console's request id`);
    assert.deepEqual({ actor: launch.at(-1)?.actor, role: launch.at(-1)?.actorRole }, { actor: "activation", role: "SYSTEM" });

    const subscribed = (await read({ action: "subscription.confirmed" })).filter((event) => watch.sent("SiteConfirmSubscription").includes(event.requestId));
    assert.equal(subscribed.length, 1, "the fan's subscription carries the browser's request id");
    assert.match(subscribed[0]!.requestId, /^site-[0-9a-f-]{36}$/);
    const paid = (await read({ action: "payment.succeeded" })).find((event) => event.requestId === subscribed[0]!.requestId);
    assert.ok(paid, "payment.succeeded carries the confirmation's request id");
    summary.auditEvents = launch.length + 2;
  });

  test("8. no page asked anything of another host, and none logged an error", () => {
    assert.equal(watch.externalRequests, 0);
    assert.deepEqual(watch.pageErrors, []);
    assert.ok(watch.pagesChecked >= 6, `axe ran on ${watch.pagesChecked} pages`);
    assert.equal(watch.layoutChecks, 10);
  });
});
