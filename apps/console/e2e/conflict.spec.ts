// Two people on one draft (business book §6.3): the console saves from the
// version its form was loaded from. When the page reads a newer version
// saved by someone else, it says so as a conflict, saving the old form is
// refused by the engine instead of overwriting the other person's work, and
// only an explicit reload moves the form to the newer version.
import { expect, test } from "@playwright/test";
import { asPerson, enterAs, nextMondayAtNine } from "./support.ts";

const RUN = Date.now().toString(36);
const TITLE = `Two hands ${RUN}`;

const OFFER = (title: string) => ({
  title,
  plan: "student",
  audience: { segment: "NEVER_PAID", needsStudentCheck: true },
  prices: [{ market: "IT", fixed: { amountMinor: "299", currency: "EUR" } }],
  monthsAtOfferPrice: 3,
  periods: [{ market: "IT", startsLocal: nextMondayAtNine() }],
  nonCombinabilityGroup: `two-hands-${RUN}`,
  pages: [{ market: "IT", title, text: "Three months of Student for 2,99 € a month.", terms: "New subscribers only.", treatment: "standard" }],
});

test("a version saved by someone else meanwhile is a conflict, never overwritten", async ({ page, context }) => {
  test.setTimeout(90_000);
  const first = asPerson("marketing-1");
  await first.signIn();
  const created = await first.mutate("mutation ($offer: OfferInput!) { createOffer(offer: $offer) { __typename ... on Change { id } } }", { offer: OFFER(TITLE) });
  const id = String(created.createOffer.id);

  await enterAs(page, "Marketing");
  await page.goto(`/campaigns/edit/?id=${id}&step=1`);
  await expect(page.getByLabel("Campaign name")).toHaveValue(TITLE);

  // Marketing's second person saves v2 through the gateway.
  const second = asPerson("marketing-2");
  await second.signIn();
  const theirs = `${TITLE}, by the second marketer`;
  const saved = await second.mutate(
    "mutation ($id: ID!, $offer: OfferInput!) { saveOfferVersion(changeId: $id, baseVersion: 1, offer: $offer) { __typename ... on Change { currentVersion } } }",
    { id, offer: OFFER(theirs) },
  );
  expect(saved.saveOfferVersion.currentVersion).toBe(2);

  // The page reads the change again, as it does after a lost connection comes back.
  await page.waitForTimeout(10_500);
  await context.setOffline(true);
  await context.setOffline(false);
  await expect(page.getByText("Someone saved v2 while you were editing v1.")).toBeVisible();
  await expect(page.getByLabel("Campaign name")).toHaveValue(TITLE);

  // Saving the form loaded from v1 is refused: the second person's v2 stays.
  await page.getByLabel("Campaign name").fill(`${TITLE}, mine`);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Someone saved v2 while you were editing v1.")).toBeVisible();
  const after = await first.query("query ($id: ID!) { change(id: $id) { currentVersion title } }", { id });
  expect(after.change).toEqual({ currentVersion: 2, title: theirs });

  // Only an explicit reload moves the form to v2; from there a save makes v3.
  await page.getByRole("button", { name: "Load v2 and drop my edits" }).click();
  await expect(page.getByLabel("Campaign name")).toHaveValue(theirs);
  await expect(page.getByText(/while you were editing/)).toHaveCount(0);
  await page.getByLabel("Campaign name").fill(`${theirs}, then mine`);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Saved as v3.")).toBeVisible();
  const last = await first.query("query ($id: ID!) { change(id: $id) { currentVersion title } }", { id });
  expect(last.change).toEqual({ currentVersion: 3, title: `${theirs}, then mine` });
});
