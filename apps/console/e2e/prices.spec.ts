// The prices the commercial lead writes, on the whole system (business book
// §8, §9, §14.3, §14.4). The commercial lead writes the Family price rise in
// Germany through its three steps, Finance signs it for conditions 1 and 5,
// the commercial lead schedules it, the engine's launch asks the existing
// subscribers for their consent, and the progress shows where they stand,
// one of them saying yes on the site. A prepaid pass is written, signed,
// scheduled and put on sale; a listener buys a code through the simulated
// provider, and Finance reads its value not yet earned on the home, €24.58
// for an Italian pass (§9.2). Marketing finds no button to write either, and
// the server refuses it all the same.
import { expect, type Page, test } from "@playwright/test";
import {
  asListener, asPerson, axe, callByHand, daysAfter, daysAhead, enterAs, launchClockGuard, minutesAhead, recordNotRun, submittedMigration, switchTo, watchErrors,
} from "./support.ts";

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);

/** The change's id from the address of its pages. */
const idOf = (page: Page) => new URL(page.url()).searchParams.get("id") ?? "";

/** The state of a change, read from the console's API by the commercial lead. */
async function stateOf(id: string): Promise<string> {
  const lead = asPerson("commercial-lead-1");
  await lead.signIn();
  return (await lead.query("query ($id: ID!) { change(id: $id) { state } }", { id })).change.state as string;
}

/** A launch minutes away in a market, or not run for its clocks, said why and from when. */
function launchesIn(zone: string): void {
  const blocked = launchClockGuard(zone);
  if (blocked) recordNotRun(test.info().title, blocked);
  test.skip(blocked !== null, blocked ?? "");
}

test("the commercial lead writes the Family rise in Germany, Finance signs it, it is launched, and its progress shows the subscribers asked", async ({ page }) => {
  test.setTimeout(420_000);
  launchesIn("Europe/Berlin");
  const errors = watchErrors(page);
  await enterAs(page, "Commercial lead");
  await page.goto("/price-migrations/");
  await page.getByRole("link", { name: "New price migration" }).click();
  await expect(page.getByRole("heading", { name: "New price", level: 2 })).toBeVisible();

  // Step 1: the new price, with Germany's rules beside it, the law apart from the music service's choice.
  await page.getByLabel("Migration name").fill(`Family price rise, Germany ${RUN}`);
  await page.getByRole("radio", { name: /^Germany/ }).check();
  await page.getByLabel("Plan", { exact: true }).selectOption("family");
  await page.getByLabel("New price in Germany, VAT included").fill("20.99");
  await expect(page.getByText(/€2\.00 a month more than €18\.99/)).toBeVisible();
  await expect(page.getByRole("region", { name: "What the law asks" })).toContainText("Consent: each existing subscriber has to say yes, and silence counts as no.");
  await expect(page.getByRole("region", { name: "What Rione chose" })).toContainText("not a legal requirement");
  await axe(page, "a new price migration, its first step");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2: soon enough for its launch to run while the test waits.
  const notices = minutesAhead(3, "Europe/Berlin");
  await expect(page.getByRole("heading", { name: "Dates", level: 2 })).toBeVisible();
  await page.getByLabel("Existing subscribers are asked from, Berlin time").fill(notices);
  // New subscribers from noon the next day: a time no clock change touches.
  await page.getByLabel(/^New subscribers pay €20\.99 from, Berlin time/).fill(daysAfter(notices, 1, "12:00"));
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: the engine checks it, says it in business words, and simulates it with the book's numbers (§8.7).
  await page.getByRole("button", { name: "Save v1 and check it" }).click();
  await expect(page.getByLabel("The change in business words")).toContainText("Germany, Family: from €18.99 to €20.99 for new subscribers");
  await expect(page.getByText("Finance must sign: conditions 1 and 5 of §7.3.", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/net of VAT €15\.96 becomes €17\.64, and the artists' share €9\.58 becomes €10\.58/)).toBeVisible();
  await expect(page.getByText(/If 90% of the [\d,]+ existing subscribers accept \(an illustrative assumption\)/)).toBeVisible();
  await axe(page, "a price migration checked");
  await page.getByRole("button", { name: "Submit v1 for approval" }).click();
  await expect(page.getByText("v1 is in approval.", { exact: true })).toBeVisible();
  const migrationId = idOf(page);
  expect(migrationId).toMatch(/^\d+$/);

  // Finance signs v1 by its fingerprint; Finance does not schedule what it signed.
  await switchTo(page, "Finance");
  await page.goto(`/price-migrations/approval/?id=${migrationId}`);
  await expect(page.getByRole("region", { name: "What the law asks" })).toBeVisible();
  await axe(page, "a price migration in approval, for Finance");
  await page.getByRole("button", { name: "Approve v1 as Finance" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve v1" }).click();
  await expect(page.getByText(/Approved v1 as Finance/)).toBeVisible();
  await expect(page.getByText("Approved. The commercial lead schedules the launch; Finance approves but does not schedule.")).toBeVisible();

  // The commercial lead schedules it; its launch begins a minute before the requests go out.
  await switchTo(page, "Commercial lead");
  await page.goto(`/price-migrations/approval/?id=${migrationId}`);
  await page.getByRole("button", { name: "Schedule the launch" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Schedule the launch" }).click();
  await expect(page.getByText(/^Scheduled\. It starts at Germany:/)).toBeVisible();

  // The progress: first when the requests go out, then where the subscribers stand, read again every few seconds.
  await page.getByRole("link", { name: "Progress" }).click();
  const standing = page.getByRole("heading", { name: /Family subscribers in Germany asked for their consent;/ });
  await expect(standing).toBeVisible({ timeout: 300_000 });
  const counted = /^([\d,]+) Family subscribers in Germany asked for their consent; ([\d,]+) have not answered yet\.$/.exec((await standing.textContent()) ?? "");
  expect(counted, "the counts in the heading").not.toBeNull();
  const asked = Number((counted?.[1] ?? "0").replaceAll(",", ""));
  expect(asked).toBeGreaterThan(0);
  expect(counted?.[2]).toBe(counted?.[1]);
  await expect(page.getByRole("row", { name: new RegExp(`^Asked ${counted?.[1]}$`) })).toBeVisible();

  // The Family subscriber of the demo says yes on the site: the progress counts one acceptance.
  const listener = asListener("Family subscriber in Germany");
  await listener.signIn();
  const changes = (await listener.query("query { me { account { priceChanges { id state newPrice } } } }")).me.account.priceChanges as { id: string; state: string; newPrice: { amountMinor: string } }[];
  const mine = changes.find((change) => change.state === "WAITING" && change.newPrice.amountMinor === "2099");
  expect(mine, "the consent request of the demo's Family subscriber").toBeTruthy();
  const answered = await listener.mutate("mutation ($id: ID!) { answerPriceChange(priceChangeId: $id, accept: true) { __typename ... on Refusal { code reason } } }", { id: mine?.id });
  expect(answered.answerPriceChange.__typename).toBe("PriceChange");
  await expect(page.getByRole("row", { name: /^Accepted Said yes: .* 1$/ })).toBeVisible({ timeout: 30_000 });
  await axe(page, "a price migration's progress");
  expect(errors()).toEqual([]);
});

test("a prepaid pass is written, signed, scheduled and on sale; a listener buys a code; Finance reads what is not yet earned", async ({ page }) => {
  test.setTimeout(420_000);
  launchesIn("Europe/Rome");
  await enterAs(page, "Commercial lead");
  await page.goto("/passes/");
  await page.getByRole("link", { name: "New prepaid pass" }).click();
  await page.getByRole("button", { name: "Fill in the three-month gift pass" }).click();
  await page.getByLabel("Pass name").fill(`Three-month gift pass ${RUN}`);
  await expect(page.getByLabel(/^Plan it gives/).locator("option", { hasText: "Student" })).toHaveCount(0);
  await axe(page, "a new prepaid pass, its first step");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Price in Italy, VAT included, paid once")).toHaveValue("29.99");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("On sale from, Rome time").fill(minutesAhead(3, "Europe/Rome"));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Title", { exact: true }).fill(`Three months of Individual, as a gift ${RUN}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Save v1 and check it" }).click();
  await expect(page.getByLabel("The change in business words")).toContainText("Individual for 3 months, paid in advance and never renewed; Italy: €29.99");
  await page.getByRole("button", { name: "Submit v1 for approval" }).click();
  await expect(page.getByText("v1 is in approval.", { exact: true })).toBeVisible();
  const passId = idOf(page);

  await switchTo(page, "Finance");
  await page.goto(`/passes/approval/?id=${passId}`);
  await expect(page.getByRole("heading", { name: "The pass, in short" })).toBeVisible();
  await page.getByRole("button", { name: "Approve v1 as Finance" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve v1" }).click();
  await expect(page.getByText(/Approved v1 as Finance/)).toBeVisible();

  await switchTo(page, "Commercial lead");
  await page.goto(`/passes/approval/?id=${passId}`);
  await page.getByRole("button", { name: "Schedule the launch" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Schedule the launch" }).click();
  await expect(page.getByText(/^Scheduled\. It starts at Italy:/)).toBeVisible();
  await expect.poll(() => stateOf(passId), { timeout: 300_000, intervals: [2_000] }).toBe("ACTIVE");
  await page.reload();
  await expect(page.getByText("On sale on the site.")).toBeVisible();

  // A listener in Italy buys a code; the simulated provider settles its payment.
  const listener = asListener("Individual subscriber in Italy");
  await listener.signIn();
  // On sale from the start of its period in Italy: the site lists it from then.
  let onSale: { id: string; title: string } | undefined;
  await expect.poll(async () => {
    const passes = (await listener.query("query { prepaidPasses(market: \"IT\") { id title } }")).prepaidPasses as { id: string; title: string }[];
    onSale = passes.find((pass) => pass.title.includes(RUN));
    return onSale !== undefined;
  }, { timeout: 180_000, intervals: [2_000] }).toBe(true);
  const bought = await listener.mutate("mutation ($id: ID!) { buyPrepaidPass(passId: $id) { __typename ... on Refusal { code reason } } }", { id: onSale?.id });
  expect(bought.buyPrepaidPass.__typename, JSON.stringify(bought.buyPrepaidPass)).toBe("PrepaidPurchase");
  await expect.poll(async () => {
    const codes = (await listener.query("query { me { account { prepaidCodes { state passId } } } }")).me.account.prepaidCodes as { state: string; passId: string }[];
    return codes.find((code) => code.passId === onSale?.id)?.state ?? "none";
  }, { timeout: 60_000, intervals: [1_000] }).toBe("READY");

  // Finance reads the value sold and not yet earned: an Italian pass, net €24.58, unearned until its code is activated (§9.2).
  await switchTo(page, "Finance");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /€24\.58\s*Prepaid passes sold, not yet earned/ })).toBeVisible();
  await expect(page.getByRole("row", { name: "Italy 1 0 0 €24.58" })).toBeVisible();
  await axe(page, "the home, for Finance, with a pass sold");
});

test("Marketing finds no button to write a price migration or a pass, and the server refuses it", async ({ page }) => {
  // Individual in France: a plan and a market no other test raises.
  const migrationId = await submittedMigration(`Individual price rise, France ${RUN}`, "individual", "FR", { amountMinor: "1199", currency: "EUR" });
  await enterAs(page, "Marketing");
  await page.goto("/price-migrations/");
  await expect(page.getByText("The commercial lead writes price migrations; as Marketing you read them.")).toBeVisible();
  await expect(page.getByRole("link", { name: "New price migration" })).toHaveCount(0);
  await page.goto("/passes/");
  await expect(page.getByText("The commercial lead writes prepaid passes; as Marketing you read them.")).toBeVisible();
  await expect(page.getByRole("link", { name: "New prepaid pass" })).toHaveCount(0);
  await page.goto(`/price-migrations/edit/?id=${migrationId}&step=1`);
  await expect(page.getByText(/The commercial lead writes price migrations \(§12\)\. As Marketing you read this one, with its fields read-only\./)).toBeVisible();
  await expect(page.getByLabel("Migration name")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await page.goto(`/price-migrations/approval/?id=${migrationId}`);
  await expect(page.getByText("As Marketing you can't sign this one: it needs Finance (conditions 1 and 5).")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);

  // Days ahead at 09:00, not minutes: a week or forty days from a night hour can fall in the hour the clocks repeat.
  const migration = { title: `By hand ${RUN}`, plan: "duo", market: "IT", amount: { amountMinor: "1599", currency: "EUR" }, noticesLocal: daysAhead(7, "09:00", "Europe/Rome"), startsLocal: daysAhead(40, "09:00", "Europe/Rome") };
  const created = await callByHand(page, "mutation ($m: PriceMigrationInput!) { createPriceMigration(migration: $m) { __typename ... on Refusal { code } } }", { m: migration });
  expect(created.body.data.createPriceMigration.code).toBe("ROLE_NOT_ALLOWED");
  const pass = { title: `By hand ${RUN}`, plan: "individual", months: 3, prices: [{ market: "IT", amount: { amountMinor: "2999", currency: "EUR" } }], periods: [{ market: "IT", startsLocal: daysAhead(7, "09:00", "Europe/Rome") }], codeValidMonths: 12, pages: [] };
  const passCreated = await callByHand(page, "mutation ($p: PrepaidPassInput!) { createPrepaidPass(pass: $p) { __typename ... on Refusal { code } } }", { p: pass });
  expect(passCreated.body.data.createPrepaidPass.code).toBe("ROLE_NOT_ALLOWED");
  // The value not yet earned is Finance's alone: the gateway refuses the field to Marketing.
  const read = await callByHand(page, "query { overview { prepaidUnearnedEur } }", {});
  expect(read.body.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
});
