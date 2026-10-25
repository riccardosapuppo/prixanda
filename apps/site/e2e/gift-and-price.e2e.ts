// The site's end-to-end test of stage 7: the gift pass of the business book's
// §14.4 and the price changes of §14.3, with the whole system running and a
// real browser on the site's static build.
//
//   1. Before its launch no pass is on sale: the home has no gift section, and
//      the header no way to one.
//   2. The commercial lead's gift pass, launched through the console's API,
//      reaches the open home within a measured time.
//   3. A listener in Italy buys a code: the entrance, the confirmation with
//      the disclaimer, the payment the simulated provider settles, the demo
//      receipt with the code; the account lists it.
//   4. Another listener activates the code: three months of Individual, never
//      charged and never renewed, then Free; a third cannot use it again; the
//      code is in no line the engine or the gateway logged.
//   5. A second code, bought while the payment provider has not answered
//      yet: after thirty seconds of asking, the page of the purchase and then
//      the account say the provider has not answered, and each check again
//      asks for thirty seconds more and says so again at their end. Sent
//      meanwhile, the code is refused; once the payment settled, the same
//      code, sent again from the same page without a reload, is activated: an
//      answer, success or refusal, spends the key it was asked with, and the
//      next attempt takes a new one, which the engine answers afresh.
//   6. A third code, and the reading of the account that follows its
//      purchase fails once: the code bought stays on the page, which reads
//      the account again and shows the code ready, and never offers the
//      purchase again. One purchase, never two.
//   7. Two price migrations launched: Family in Germany, Individual in Italy.
//      The engine's clock reaches the morning the subscribers are told.
//   8. The Family subscriber in Germany is asked: two answers of the same
//      weight, silence counted as no, the law and the service's choice in two
//      blocks; the panel fits five widths; the answer is no, and the page
//      says what follows with the engine's date.
//   9. The Individual subscriber in Italy is told in advance, and leaves
//      before the new price, on the engine's date.
//  10. The audit log holds every step of the listeners with the request id
//      their browser sent.
//
// Every page and state is checked with axe, no page may ask anything of
// another host, and none may log an error. Run by npm run e2e -w site, and by
// npm run check (suite site-e2e-7), which reads the summary it writes
// (SITE_E2E_SUMMARY).
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { PAYMENT_POLL_LIMIT_MS } from "../src/data/config.ts";
import { siteDay } from "../src/lib/dates.ts";
import { failedAnswer, operationOf, text, Watch } from "./support/browser.ts";
import { ConsoleSession, giftPass, launchChange, priceMigration } from "./support/console.ts";
import { CONSOLE_API, PUBLIC_API, SITE_URL, type Stack, startStack } from "./support/stack.ts";

/** The engine's clock at the start: the last day of the generated data, at noon in Rome. */
const START = "2026-10-24T10:00:00Z";
/** The gift pass goes on sale at 13:00 in Rome on 24 October. */
const PASS_STARTS_LOCAL = "2026-10-24T13:00";
const PAST_THE_PASS = "2026-10-24T11:00:05Z";
/** The subscribers are asked or told at 09:00 on 2 November, in Berlin and in Rome alike (08:00 UTC once the clocks went back). */
const NOTICES_LOCAL = "2026-11-02T09:00";
const PAST_THE_NOTICES = "2026-11-02T08:00:05Z";
/** How long an open page may take to show a pass that went on sale: its refresh, the launch, a margin. */
const SITE_LIMIT_MS = 30_000;
const CODE_SHAPE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

const SUMMARY = process.env["SITE_E2E_SUMMARY"] ?? "";

let stack: Stack | null = null;
let browser: Browser | null = null;
const watch = new Watch(() => {
  assert.ok(browser);
  return browser;
});
const summary = {
  passOnPageMs: Number.NaN,
  codeReadyMs: Number.NaN,
  auditEvents: 0,
  codeInLogs: true,
};
let passId = "";
// The code bought in test 3, typed by the other listeners in test 4, and the one of test 5. They are never printed.
let code = "";
let second = "";

/** The prepaid codes a listener bought, the latest first, as the gateway answers for their cookie. */
async function codesOf(context: BrowserContext): Promise<Array<{ code: string; state: string }>> {
  const response = await context.request.post(PUBLIC_API, {
    headers: { "content-type": "application/json", origin: SITE_URL },
    data: { query: "{ me { account { prepaidCodes { code state } } } }" },
  });
  const body = await response.json() as { data?: { me?: { account?: { prepaidCodes?: Array<{ code: string; state: string }> } } } };
  return body.data?.me?.account?.prepaidCodes ?? [];
}

/**
 * Two rounds of asking for a payment the provider keeps pending, on a page
 * whose clock the test moves: at the end of each, the page says the provider
 * has not answered yet, and its check again asks for another round.
 */
async function slowRounds(page: Page): Promise<void> {
  const slow = page.getByText("The payment provider hasn't answered yet.");
  for (let round = 1; round <= 2; round += 1) {
    await page.clock.fastForward(PAYMENT_POLL_LIMIT_MS);
    await slow.waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Check again" }).click();
    await slow.waitFor({ state: "hidden", timeout: 10_000 });
  }
}

/** The listener of a visitor's session, as the gateway answers for its cookie. */
async function account(context: BrowserContext): Promise<any> {
  const response = await context.request.post(PUBLIC_API, {
    headers: { "content-type": "application/json", origin: SITE_URL },
    data: {
      query: `{ me { id account { subscription { plan paid endsOn prepaidCode nextBillingOn }
        priceChanges { id kind state appliesFrom ifNoLeavesOn leavesOn newPriceFrom legalBasis ifNoAnswer windowEnds { local } } } } }`,
    },
  });
  const body = await response.json() as { data?: { me?: unknown } };
  return body.data?.me;
}

async function enterAs(page: Page, who: RegExp): Promise<void> {
  await page.getByLabel(who).check();
  await page.getByRole("button", { name: "Enter as this listener" }).click();
}

async function passesOnSale(): Promise<Array<{ id: string }>> {
  const response = await fetch(PUBLIC_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: '{ prepaidPasses(market: "IT") { id } }' }),
  });
  const body = await response.json() as { data?: { prepaidPasses?: Array<{ id: string }> } };
  return body.data?.prepaidPasses ?? [];
}

describe("the gift pass and the price changes, on the site (§14.3, §14.4)", () => {
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
        passOnPageMs: Number.isNaN(summary.passOnPageMs) ? null : summary.passOnPageMs,
        codeReadyMs: Number.isNaN(summary.codeReadyMs) ? null : summary.codeReadyMs,
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

  let home: Page | null = null;

  test("1. before its launch no pass is on sale, and the site offers none", async () => {
    const { page } = await watch.visitor();
    home = page;
    await page.goto(`${SITE_URL}/?market=IT`);
    await page.getByRole("radio", { name: "Italy" }).waitFor();
    await page.locator("#sessions").waitFor();
    assert.equal(await page.locator("#gift").count(), 0, "no gift section");
    assert.equal(await page.getByRole("link", { name: "Gift a pass" }).count(), 0, "no way to a pass in the header");
  });

  test("2. launched through the console's API, the pass reaches the open home within a measured time", async () => {
    assert.ok(stack && home);
    const launched = await launchChange(CONSOLE_API, "prepaid", giftPass(PASS_STARTS_LOCAL), "gift");
    passId = launched.changeId;
    await stack.engine.at(PAST_THE_PASS);
    const moved = performance.now();
    const onThePage = home.locator("#gift").waitFor({ timeout: SITE_LIMIT_MS }).then(() => (summary.passOnPageMs = Math.round(performance.now() - moved)));
    for (;;) {
      if ((await passesOnSale()).some((pass) => pass.id === passId)) break;
      assert.ok(performance.now() - moved < 20_000, "the engine did not put the pass on sale within 20 s");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await onThePage;
    const page = await text(home);
    assert.match(page, /Three-month gift pass/);
    assert.match(page, /Three months of Individual, 29,99 € paid once\./);
    assert.match(page, /29,99 €\s*paid once, VAT included/);
    assert.match(page, /The code never renews/);
    await watch.accessible(home, "the home with the gift pass");
  });

  test("3. a listener in Italy buys a code: the confirmation, the simulated payment, the demo receipt", async () => {
    const { page } = await watch.visitor();
    await page.goto(`${SITE_URL}/?market=IT#gift`);
    await page.getByRole("button", { name: "Get a demo gift code" }).click();
    await page.getByRole("heading", { name: "Enter as a demo listener" }).waitFor();
    await enterAs(page, /Student in Italy, not verified yet/);
    await page.getByRole("heading", { name: "Confirm your demo purchase" }).waitFor();
    const confirm = await text(page);
    assert.match(confirm, /Three-month gift pass, Italy/);
    assert.match(confirm, /29,99 € once, VAT included/);
    assert.match(confirm, /3 months of Individual from the day the code is activated, never charged and never renewed\./);
    assert.match(confirm, /Independent personal project\. Fictional business and synthetic customer data\. No real payments are processed\./);
    await watch.accessible(page, "the gift pass's confirmation");

    const bought = performance.now();
    await page.getByRole("button", { name: "Confirm the demo purchase" }).click();
    await page.locator("[data-code-state='READY']").waitFor({ timeout: 30_000 });
    summary.codeReadyMs = Math.round(performance.now() - bought);
    code = (await page.locator(".gift-code .code").textContent())?.trim() ?? "";
    assert.ok(CODE_SHAPE.test(code), "the receipt shows a code of the engine's shape");
    assert.match(await text(page), /Demo receipt: no money moved\./);
    await watch.accessible(page, "the gift pass's receipt");

    await page.goto(`${SITE_URL}/account/`);
    await page.locator("[data-code-state='READY']").waitFor();
    assert.equal((await page.locator("[data-code-state='READY'] .code").textContent())?.trim() === code, true, "the account lists the code");
    assert.match(await text(page), /Ready to give or activate/);
    await watch.accessible(page, "the account with its codes");
  });

  test("4. another listener activates the code: three months never charged, then Free; nobody can use it again", async () => {
    assert.ok(stack && code);
    const { context, page } = await watch.visitor();
    await page.goto(`${SITE_URL}/account/`);
    await enterAs(page, /Student in Italy, verified/);
    const field = page.getByRole("textbox", { name: "Code" });
    await field.waitFor();
    await field.fill("NOT-A-CODE");
    await page.getByRole("button", { name: "Activate" }).click();
    await page.getByText("A code is three groups of four letters and digits").waitFor();
    assert.equal(watch.sent("SiteActivatePrepaidPass").length, 0, "a code of the wrong shape is never sent");

    // Typed the way a person might: lower case, spaces for dashes.
    await field.fill(code.toLowerCase().replaceAll("-", " "));
    await page.getByRole("button", { name: "Activate" }).click();
    await page.getByText(/^Activated: Individual until /).waitFor({ timeout: 20_000 });
    const me = await account(context);
    assert.equal(me?.account?.subscription?.plan, "individual");
    assert.equal(me?.account?.subscription?.nextBillingOn, null, "never charged");
    const endsOn: string = me?.account?.subscription?.endsOn ?? "";
    assert.ok(endsOn !== "", "the engine says when the pass's months end");
    const after = await text(page);
    assert.match(after, /Prepaid: 29,99 €, paid once/);
    assert.match(after, /Never charged, never renewed/);
    assert.ok(after.includes(`${siteDay(endsOn)}, then Free`), "the end is the engine's day");
    await watch.accessible(page, "the account after the activation");

    const third = await watch.visitor();
    await third.page.goto(`${SITE_URL}/account/`);
    await enterAs(third.page, /Student in Italy who paid before/);
    await third.page.getByRole("textbox", { name: "Code" }).fill(code);
    await third.page.getByRole("button", { name: "Activate" }).click();
    await third.page.getByText("This code can't be activated").waitFor({ timeout: 20_000 });

    const logged = [...stack.engine.log, ...stack.gatewayLog].filter((line) => JSON.stringify(line).includes(code)).length;
    summary.codeInLogs = logged > 0;
    assert.equal(logged, 0, "the code is in no line the engine or the gateway logged");
  });

  test("5. a code sent while its payment is pending is refused, and the same code goes through once it settled, without a reload", async () => {
    assert.ok(stack);
    // The provider keeps its answer: the code bought now stays pending.
    await stack.engine.holdPayments();
    let answering = false;
    try {
      const buyer = await watch.visitor();
      // The buyer's page keeps a clock the test moves, to skip the thirty seconds a round of asking lasts.
      await buyer.page.clock.install();
      await buyer.page.goto(`${SITE_URL}/?market=IT#gift`);
      await buyer.page.getByRole("button", { name: "Get a demo gift code" }).click();
      await buyer.page.getByRole("heading", { name: "Enter as a demo listener" }).waitFor();
      await enterAs(buyer.page, /Student in Italy, not verified yet/);
      await buyer.page.getByRole("button", { name: "Confirm the demo purchase" }).click();
      await buyer.page.locator("[data-code-state='PENDING']").waitFor({ timeout: 20_000 });
      const held = (await codesOf(buyer.context)).find((each) => each.state === "PENDING");
      assert.ok(held, "the code bought is pending while the provider keeps its answer");
      second = held.code;
      // The provider still silent: the page of the purchase, then the account, ask a limited time after each check.
      await slowRounds(buyer.page);
      await buyer.page.goto(`${SITE_URL}/account/`);
      await buyer.page.locator("[data-code-state='PENDING']").first().waitFor();
      await slowRounds(buyer.page);

      // The code reaches someone else before its payment settled.
      const { page } = await watch.visitor();
      await page.goto(`${SITE_URL}/account/`);
      await enterAs(page, /Student in Italy who paid before/);
      const field = page.getByRole("textbox", { name: "Code" });
      await field.waitFor();
      await field.fill(second);
      await page.getByRole("button", { name: "Activate" }).click();
      await page.getByText("This code can't be activated").waitFor({ timeout: 20_000 });

      // The provider answers; the payment settles and the code is ready.
      await stack.engine.answerPayments();
      answering = true;
      const deadline = performance.now() + 20_000;
      while ((await codesOf(buyer.context)).find((each) => each.code === second)?.state !== "READY") {
        assert.ok(performance.now() < deadline, "the code was not ready within 20 s of the provider's answer");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // The same code from the same page, sent again: a new attempt, with a new key, which the engine answers afresh.
      await page.getByRole("button", { name: "Activate" }).click();
      await page.getByText(/^Activated: Individual until /).waitFor({ timeout: 20_000 });
      const sent = watch.siteRequests.filter((seen) => seen.operation === "SiteActivatePrepaidPass" && seen.variables["code"] === second);
      assert.equal(sent.length, 2, "the code was sent twice");
      assert.notEqual(sent[0]?.idempotencyKey, sent[1]?.idempotencyKey, "the refusal spent the first key");
      await watch.accessible(page, "a code activated once its payment settled");
      const logged = [...stack.engine.log, ...stack.gatewayLog].filter((line) => JSON.stringify(line).includes(second)).length;
      assert.equal(logged, 0, "the second code is in no line the engine or the gateway logged");
    } finally {
      if (!answering) await stack.engine.answerPayments();
    }
  });

  test("6. a reading of the account that fails after a purchase takes nothing away: the code stays, and nothing is bought twice", async () => {
    const { page } = await watch.visitor();
    await page.goto(`${SITE_URL}/?market=IT#gift`);
    await page.getByRole("button", { name: "Get a demo gift code" }).click();
    await page.getByRole("heading", { name: "Enter as a demo listener" }).waitFor();
    await enterAs(page, /Student in Italy, not verified yet/);
    const confirm = page.getByRole("button", { name: "Confirm the demo purchase" });
    await confirm.waitFor();

    // The first reading of the account once the purchase is answered fails, once, with an error of
    // the API: a network out of reach would be asked again at once, and never seen.
    let answered = false;
    let failed = 0;
    await page.route(PUBLIC_API, async (route) => {
      const operation = operationOf(route.request());
      if (operation === "SiteBuyPrepaidPass") {
        const response = await route.fetch();
        answered = true;
        await route.fulfill({ response });
        return;
      }
      if (operation === "SiteMe" && answered && failed === 0) {
        failed += 1;
        await route.fulfill(failedAnswer(route.request()));
        return;
      }
      await route.fallback();
    });
    const bought = watch.sent("SiteBuyPrepaidPass").length;
    await confirm.click();
    // The purchase stays on the page through the failure, and the page reads the account again by
    // itself: the code is followed until it is ready, and the purchase is never offered again.
    await page.locator("#gift [data-code-state]").first().waitFor({ timeout: 10_000 })
      .catch(() => assert.fail("the purchase left the page with the reading that failed"));
    await page.locator("#gift [data-code-state='READY']").waitFor({ timeout: 30_000 });
    assert.equal(failed, 1, "the reading after the purchase failed");
    assert.ok(CODE_SHAPE.test((await page.locator(".gift-code .code").textContent())?.trim() ?? ""), "the receipt shows the code bought");
    assert.equal(watch.sent("SiteBuyPrepaidPass").length - bought, 1, "one purchase, never two");
    assert.equal(await confirm.count(), 0, "the purchase is not offered again");
    assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, "the failure went with the reading that went through");
  });

  test("7. two price migrations launched; the engine reaches the morning the subscribers are asked or told", async () => {
    assert.ok(stack);
    await launchChange(CONSOLE_API, "migration", priceMigration("Family price in Germany", "family", "DE", "2099", NOTICES_LOCAL, "2026-12-01T00:00"), "family-de");
    await launchChange(CONSOLE_API, "migration", priceMigration("Individual price in Italy", "individual", "IT", "1099", NOTICES_LOCAL, "2026-12-01T00:00"), "individual-it");
    await stack.engine.at(PAST_THE_NOTICES);
    // The migrations start with the engine's next round of launches.
    const deadline = performance.now() + 30_000;
    const { context, page } = await watch.visitor();
    await page.goto(`${SITE_URL}/account/`);
    await enterAs(page, /Family subscriber in Germany/);
    for (;;) {
      const me = await account(context);
      if ((me?.account?.priceChanges ?? []).length > 0) break;
      assert.ok(performance.now() < deadline, "no price change reached the Family subscriber in Germany within 30 s");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await context.close();
  });

  test("8. in Germany the Family subscriber is asked: two equal answers, silence is no, law and choice apart; the answer no", async () => {
    const { context, page } = await watch.visitor();
    await page.goto(`${SITE_URL}/account/`);
    await enterAs(page, /Family subscriber in Germany/);
    await page.getByRole("heading", { name: "Your Family plan price is changing" }).waitFor();
    const me = await account(context);
    const asked = me.account.priceChanges[0];
    assert.equal(asked.kind, "CONSENT");
    assert.equal(asked.state, "WAITING");
    const request = await text(page);
    assert.match(request, /You pay 18,99 € a month\. From 1 December 2026, new Family subscribers in Germany pay 20,99 €\./);
    assert.match(request, /We'd like you to pay 20,99 € too, and we need your yes before we can charge it\./);
    assert.match(request, /If we don't hear from you by 17 December 2026, we take it as a no\./);
    assert.ok(request.includes(`If you say yes: you pay 20,99 € from your billing date on ${siteDay(asked.appliesFrom)}.`), "the yes's date is the engine's");
    assert.ok(request.includes(`your Family plan ends on ${siteDay(asked.ifNoLeavesOn)}`), "the no's date is the engine's");

    // The two answers weigh the same: one look, side by side, the same width (the pointer away from both).
    await page.mouse.move(0, 0);
    const yes = page.getByRole("button", { name: "Yes, move me to 20,99 €" });
    const no = page.getByRole("button", { name: /^No, end my Family plan on / });
    const look = (button: typeof yes) => button.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return { classes: element.className, background: style.backgroundColor, border: `${style.borderWidth} ${style.borderStyle} ${style.borderColor}`,
        weight: style.fontWeight, size: style.fontSize, width: Math.round(box.width), top: Math.round(box.top) };
    });
    assert.deepEqual(await look(yes), await look(no));

    // The law and the service's choice: two blocks, the engine's own words in each.
    const law = page.getByRole("region", { name: "The law" });
    const choice = page.getByRole("region", { name: /'s choice$/ });
    assert.equal((await law.innerText()).includes(asked.legalBasis), true);
    assert.equal((await choice.innerText()).includes(asked.ifNoAnswer), true);
    assert.equal((await law.innerText()).includes(asked.ifNoAnswer), false, "the choice is not written as law");
    await watch.accessible(page, "the request for consent");

    const misfit = await watch.fits(page, "[data-price-change='WAITING']");
    assert.deepEqual(misfit, []);

    await no.click();
    const outcome = page.getByRole("heading", { name: "Your answer: no" });
    await outcome.waitFor({ timeout: 20_000 });
    assert.ok(await outcome.evaluate((element) => element === document.activeElement), "the outcome takes the focus");
    const answered = (await account(context)).account;
    assert.equal(answered.priceChanges[0].state, "DECLINED");
    const leaves: string = answered.priceChanges[0].leavesOn;
    const after = await text(page);
    assert.ok(after.includes(`Your Family plan ends on ${siteDay(leaves)}, when the month you've paid for runs out, and the account moves to Free.`), "the end is the engine's day");
    assert.ok(after.includes(`${siteDay(answered.subscription.endsOn)}, then Free`), "the facts say the same end");
    assert.equal(await page.getByRole("button", { name: "Yes, move me to 20,99 €" }).count(), 0, "an answer given is not asked again");
    await watch.accessible(page, "the answer no");
  });

  test("9. in Italy the Individual subscriber is told in advance, and leaves before the new price", async () => {
    const { context, page } = await watch.visitor();
    await page.goto(`${SITE_URL}/account/`);
    await enterAs(page, /Individual subscriber in Italy/);
    await page.getByRole("heading", { name: "Your Individual plan price is changing" }).waitFor();
    const told = (await account(context)).account.priceChanges[0];
    assert.equal(told.kind, "NOTICE");
    const notice = await text(page);
    assert.ok(notice.includes(`You pay 10,49 € a month. From your billing date on ${siteDay(told.appliesFrom)}, you pay 10,99 €.`), "the new price's date is the engine's");
    assert.match(notice, /New Individual subscribers in Italy pay it from 1 December 2026\./);
    assert.equal(await page.getByRole("button", { name: /^Yes/ }).count(), 0, "a notice asks for no yes");
    await watch.accessible(page, "the notice");
    const misfit = await watch.fits(page, "[data-price-change='WAITING']");
    assert.deepEqual(misfit, []);

    await page.getByRole("button", { name: `Leave on ${siteDay(told.ifNoLeavesOn, { withYear: false })}` }).click();
    await page.getByRole("heading", { name: "You chose to leave" }).waitFor({ timeout: 20_000 });
    const left = (await account(context)).account.priceChanges[0];
    assert.equal(left.state, "DECLINED");
    assert.ok((await text(page)).includes(`Your Individual plan ends on ${siteDay(left.leavesOn)}, before the new price is charged, and the account moves to Free.`));
    await watch.accessible(page, "the notice answered");
  });

  test("10. the audit log holds every step of the listeners with the request id their browser sent", async () => {
    const auditor = await new ConsoleSession(CONSOLE_API, "auditor-1").signIn();
    const read = async (filter: Record<string, string>) => {
      const answer = await auditor.graphql("query ($filter: AuditFilter) { auditEvents(filter: $filter, first: 50) { nodes { action actor requestId } } }", { filter });
      return (answer.body?.data?.auditEvents?.nodes ?? []) as Array<{ action: string; actor: string; requestId: string }>;
    };
    // The three codes: each sold and paid, two of them activated, each step with the browser's request id.
    const sold = await read({ action: "prepaid.sold" });
    assert.equal(sold.length, 3, "three codes sold: the third once only, whatever its page read");
    const payments = await read({ action: "payment.succeeded" });
    for (const sale of sold) {
      assert.ok(watch.sent("SiteBuyPrepaidPass").includes(sale.requestId), "prepaid.sold carries the browser's request id");
      assert.match(sale.requestId, /^site-[0-9a-f-]{36}$/);
      assert.ok(payments.some((event) => event.requestId === sale.requestId), "the payment of the code carries the purchase's request id");
    }
    const activated = await read({ action: "prepaid.activated" });
    assert.equal(activated.length, 2, "two codes activated; the attempt refused while its payment was pending changed nothing");
    for (const activation of activated) {
      assert.ok(watch.sent("SiteActivatePrepaidPass").includes(activation.requestId), "prepaid.activated carries the browser's request id");
    }
    const answers = (await read({ action: "price_change.answered" }));
    assert.equal(answers.length, 2, "the two answers");
    for (const answer of answers) assert.ok(watch.sent("SiteAnswerPriceChange").includes(answer.requestId), `${answer.actor}'s answer carries the browser's request id`);
    summary.auditEvents = sold.length + sold.length + activated.length + answers.length;
  });

  test("11. no page asked anything of another host, and none logged an error", () => {
    assert.equal(watch.externalRequests, 0);
    assert.deepEqual(watch.pageErrors, []);
    assert.ok(watch.pagesChecked >= 10, `axe ran on ${watch.pagesChecked} pages`);
    assert.equal(watch.layoutChecks, 10);
  });
});
