// The album release through the console (business book §14.2), on the whole
// system and with a real launch. Marketing aims a campaign at the fans of
// Doppelfenster on Free in Germany: the artist found in the catalog by a part
// of the name, more than 3 hours of their music in the last 30 days. The
// engine counts them in the listening data when the version is checked, and
// they are fewer than all of Germany's Free listeners; Finance signs it (the
// price is below the floor), Marketing schedules it minutes ahead, and the
// engine's launch puts it live. The night Berlin's clocks change, a start
// minutes away cannot be scheduled there: the test is not run, and says why.
//
// This file runs after launch.spec.ts (the files run in order): the engine of
// these tests cuts the publish step of its first launch once, and that one
// is launch.spec.ts's. A launch that met the cut would still go live, on the
// step's second attempt.
import { expect, test } from "@playwright/test";
import { asPerson, axe, enterAs, launchClockGuard, minutesAhead, onlyLocal, recordNotRun, switchTo, watchErrors } from "./support.ts";

const RUN = Date.now().toString(36);
const ZONE = "Europe/Berlin";

/** How many people an audience reaches in Germany now, as the engine counts them when a draft is checked. */
async function eligibleInGermany(audience: Record<string, unknown>, title: string): Promise<number> {
  const marketing = asPerson("marketing-2");
  await marketing.signIn();
  const offer = {
    title, plan: "duo", audience, prices: [{ market: "DE", fixed: { amountMinor: "999", currency: "EUR" } }], monthsAtOfferPrice: 1,
    periods: [{ market: "DE", startsLocal: "2027-03-01T09:00" }], nonCombinabilityGroup: `count-${RUN}`,
    pages: [{ market: "DE", title, text: "A draft that counts an audience.", terms: "Not submitted.", treatment: "standard" }],
  };
  const created = await marketing.mutate("mutation ($offer: OfferInput!) { createOffer(offer: $offer) { __typename ... on Change { id } ... on Refusal { code reason } } }", { offer });
  expect(created.createOffer.__typename, JSON.stringify(created.createOffer)).toBe("Change");
  const checked = await marketing.mutate("mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { __typename ... on Change { validation { eligible } } ... on Refusal { code reason } } }",
    { id: created.createOffer.id });
  return Number(checked.validateChange.validation?.eligible ?? -1);
}

test("Marketing aims a campaign at the fans of an artist, the engine counts them, Finance signs, and its launch puts it live", async ({ page, context }) => {
  test.setTimeout(480_000);
  const blocked = launchClockGuard(ZONE);
  if (blocked) recordNotRun(test.info().title, blocked);
  test.skip(blocked !== null, blocked ?? "");
  const local = await onlyLocal(context);
  const errors = watchErrors(page);
  const title = `Nordflur release ${RUN}`;

  // Step 1: Germany's Free listeners, narrowed to the fans of an artist found in the catalog.
  await enterAs(page, "Marketing");
  await page.goto("/campaigns/new/");
  await expect(page.getByRole("heading", { name: "Audience", level: 2 })).toBeVisible();
  await page.getByLabel("Campaign name").fill(title);
  await page.getByRole("checkbox", { name: /^Germany/ }).check();
  await page.getByLabel("Plan", { exact: true }).selectOption("individual");
  await page.getByRole("radio", { name: /Listeners on Free now/ }).check();
  await page.getByRole("checkbox", { name: /Only the fans of an artist/ }).check();
  await page.getByRole("searchbox", { name: "Artist" }).fill("doppel");
  await expect(page.getByText("1 artist with “doppel” in their name.")).toBeVisible();
  await page.getByRole("radio", { name: /^Doppelfenster/ }).check();
  await expect(page.getByRole("radio", { name: /^Doppelfenster/ })).toHaveAccessibleName(/Kellerlicht · Germany · Nordflur, 6 November 2026/);
  await page.getByLabel("Hours played").fill("3");
  await expect(page.getByLabel("Window")).toHaveValue("30");
  await expect(page.getByText("Listeners on Free in Germany who played Doppelfenster for more than 3 hours in the last 30 days.")).toBeVisible();
  await expect(page.getByText(/the engine counts in the data once the version is saved and checked, in step 5/)).toBeVisible();
  await page.getByLabel("Group", { exact: true }).fill(`release-${RUN}`);
  await page.getByLabel("Cap on redemptions").fill("1500");
  await axe(page, "the guided creation, a campaign for the fans of an artist");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2: below Germany's floor, so Finance will sign (§7.3, condition 2).
  await expect(page.getByRole("heading", { name: "Price", level: 2 })).toBeVisible();
  await expect(page.getByText("List price in force:")).toContainText("€10.99");
  await page.getByLabel("Offer price in Germany, VAT included").fill("1.99");
  await expect(page.getByText(/Below the floor in Germany \(€5\.95\)/)).toBeVisible();
  await page.getByLabel("Months at the offer price").fill("2");
  await expect(page.getByRole("figure")).toContainText("Fans of Doppelfenster on Free in Germany");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: minutes from now in Berlin, for the launch to run while the test waits.
  await expect(page.getByRole("heading", { name: "Dates", level: 2 })).toBeVisible();
  await page.getByLabel("Starts, Berlin time").fill(minutesAhead(3, ZONE));
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Page", level: 2 })).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("Nordflur is out");
  await page.getByLabel("Text", { exact: true }).fill("Two months of Individual for 1,99 € a month, for the listeners who kept Doppelfenster on repeat. Then 10,99 €, the usual Individual price.");
  await page.getByLabel("Terms").fill("For listeners on Free in Germany who played Doppelfenster for more than 3 hours in the last 30 days. At most 1,500 redemptions.");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 5: the engine checks v1 and counts the fans in the listening data.
  await page.getByRole("button", { name: "Save v1 and check it" }).click();
  await page.waitForURL(/\/campaigns\/edit\/\?id=\d+/);
  const changeId = new URL(page.url()).searchParams.get("id") ?? "";
  await expect(page.getByLabel("The change in business words")).toContainText("Germany, Individual: from €10.99 to €1.99 for 2 months, Free listeners with more than 3 hours of Doppelfenster in 30 days;");
  const counted = page.getByText(/people eligible right now, counted in the simulated data by the engine: their listening of the 30 full days before today/);
  await expect(counted).toBeVisible();
  const shown = Number(/^([\d,]+) people/.exec((await counted.textContent()) ?? "")?.[1]?.replaceAll(",", "") ?? "-1");
  const marketing = asPerson("marketing-1");
  await marketing.signIn();
  const engine = (await marketing.query("query ($id: ID!) { change(id: $id) { validation { eligible } } }", { id: changeId })).change.validation.eligible as number;
  expect(shown, "the console shows the engine's count").toBe(engine);
  // The data run up to the day they were loaded: some of Germany's Free listeners are fans, and not all of them.
  const everyone = await eligibleInGermany({ segment: "FREE_LISTENERS", needsStudentCheck: false }, `Everyone on Free in Germany ${RUN}`);
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(everyone);
  await expect(page.getByText("Finance must sign: conditions 2 and 4 of §7.3.").or(page.getByText("Finance must sign: condition 2 of §7.3.")).first()).toBeVisible();
  await axe(page, "the check of a campaign for the fans of an artist");
  await page.getByLabel(/Why is it worth running\?/).fill("Nordflur is out: two months at 1,99 € turn the fans who already play Doppelfenster every week into subscribers.");
  await page.getByRole("button", { name: "Submit v1 for approval" }).click();
  await expect(page.getByText("v1 is in approval.", { exact: true })).toBeVisible();

  // Finance signs v1 by its fingerprint.
  await switchTo(page, "Finance");
  await page.goto(`/campaigns/approval/?id=${changeId}`);
  await expect(page.getByText(/Free listeners with more than 3 hours of Doppelfenster in 30 days/).first()).toBeVisible();
  await page.getByRole("button", { name: "Approve v1 as Finance" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve v1" }).click();
  await expect(page.getByText(/Approved v1 as Finance/)).toBeVisible();

  // Marketing schedules it; the engine's launch begins a minute before the start and puts it live.
  await switchTo(page, "Marketing");
  await page.goto(`/campaigns/approval/?id=${changeId}`);
  await page.getByRole("button", { name: "Schedule the launch" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Schedule the launch" }).click();
  await expect(page.getByText(/^Scheduled\. It starts at Germany:/)).toBeVisible();
  await expect.poll(async () => (await marketing.query("query ($id: ID!) { change(id: $id) { state } }", { id: changeId })).change.state,
    { timeout: 300_000, intervals: [1_000] }).toBe("ACTIVE");
  await page.goto(`/campaigns/edit/?id=${changeId}&step=1`);
  await expect(page.locator(".state").filter({ hasText: "Live" }).first()).toBeVisible();
  // Live, the campaign reads its rule back as it was approved.
  await expect(page.getByText("Listeners on Free in Germany who played Doppelfenster for more than 3 hours in the last 30 days.")).toBeVisible();
  await axe(page, "a live campaign for the fans of an artist");

  expect(local.refused()).toEqual([]);
  expect(errors()).toEqual([]);
});
