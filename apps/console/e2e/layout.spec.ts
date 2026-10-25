// Every screen at the widths the brief names (1440, 1280, 390 and 320 px,
// and 1440 at 200% zoom, which lays out like a 720 px window): the page never
// scrolls sideways (tables and the week's lanes scroll inside their own
// boxes), and no text is cut.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { asPerson, enterAs, layoutProblems, notRunForTheClocks, recordNotRun, submittedMigration, submittedOffer } from "./support.ts";

test.describe.configure({ mode: "serial" });

const WIDTHS: readonly { readonly name: string; readonly width: number; readonly height: number }[] = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 800 },
  { name: "200%", width: 720, height: 450 },
  { name: "390", width: 390, height: 844 },
  { name: "320", width: 320, height: 640 },
];

const RUN = Date.now().toString(36);
let context: BrowserContext;
let page: Page;
let changeId = "";
let migrationId = "";

test.beforeAll(async ({ browser }) => {
  changeId = await submittedOffer(`Layout Pass ${RUN}`, `layout-${RUN}`);
  // Duo in Germany: a plan and a market no other test raises, so that no migration overlaps another.
  migrationId = await submittedMigration(`Duo price rise, Germany ${RUN}`, "duo", "DE", { amountMinor: "1599", currency: "EUR" });
  context = await browser.newContext();
  page = await context.newPage();
  await enterAs(page, "Marketing");
});

test.afterAll(async () => {
  await context.close();
});

async function atEveryWidth(path: string, ready: (page: Page) => Promise<void>): Promise<void> {
  const problems: string[] = [];
  for (const size of WIDTHS) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(path);
    await ready(page);
    const found = await layoutProblems(page);
    if (found.sideways > 0) problems.push(`${size.name}: the page scrolls sideways by ${found.sideways} px`);
    for (const clipped of found.clipped) problems.push(`${size.name}: text cut in ${clipped}`);
  }
  expect(problems, path).toEqual([]);
}

const heading = (name: RegExp | string) => async (on: Page) => {
  await expect(on.getByRole("heading", { name, level: 1 }).or(on.getByRole("heading", { name }).first())).toBeVisible();
};

test("the home", async () => {
  await atEveryWidth("/", async (on) => {
    await expect(on.getByRole("heading", { name: /Paying subscribers by plan and market/ })).toBeVisible();
    await expect(on.getByRole("heading", { name: "This week, by market and plan" })).toBeVisible();
  });
});

test("the campaigns and the approvals", async () => {
  await atEveryWidth("/campaigns/", heading("Campaigns"));
  await atEveryWidth("/approvals/", heading("Approvals"));
});

test("the guided creation, its first and last steps", async () => {
  await atEveryWidth("/campaigns/new/", heading("Audience"));
  await atEveryWidth(`/campaigns/edit/?id=${changeId}&step=5`, async (on) => {
    await expect(on.getByLabel("The change in business words")).toBeVisible();
  });
});

test("the simulation", async () => {
  await atEveryWidth(`/campaigns/simulation/?id=${changeId}`, async (on) => {
    await expect(on.getByRole("heading", { name: /At these assumptions/ })).toBeVisible();
  });
});

test("the approval", async () => {
  await atEveryWidth(`/campaigns/approval/?id=${changeId}`, async (on) => {
    await expect(on.getByRole("heading", { name: "Decision" })).toBeVisible();
    await expect(on.getByRole("heading", { name: "Version and fingerprint" })).toBeVisible();
  });
});

test("a launch's timeline (the launch test, before this file, ran one)", async () => {
  // When the launch test was not run for the clocks, there is no launch to look at, for the same reason.
  const blocked = notRunForTheClocks[0] ?? null;
  if (blocked) recordNotRun(test.info().title, blocked);
  test.skip(blocked !== null, blocked ?? "");
  const reader = asPerson("marketing-1");
  await reader.signIn();
  const first = (await reader.query("query { launches(first: 1) { nodes { id run } } }")).launches.nodes[0] as { id: string; run: string } | undefined;
  expect(first, "a launch to look at").toBeTruthy();
  await atEveryWidth(`/launches/run/?id=${first?.id}`, async (on) => {
    await expect(on.getByRole("heading", { name: `Launch timeline: ${first?.run}`, level: 1 })).toBeVisible();
    await expect(on.getByRole("heading", { name: "Live now" })).toBeVisible();
  });
});

test("the price migrations: the list, the form's first and last steps, the simulation, the approval and the progress", async () => {
  await atEveryWidth("/price-migrations/", heading("Price migrations"));
  await atEveryWidth("/price-migrations/new/", heading("New price"));
  await atEveryWidth(`/price-migrations/edit/?id=${migrationId}&step=3`, async (on) => {
    await expect(on.getByLabel("The change in business words")).toBeVisible();
  });
  await atEveryWidth(`/price-migrations/simulation/?id=${migrationId}`, async (on) => {
    await expect(on.getByRole("heading", { name: /^If \d+% accept, revenue/ })).toBeVisible();
  });
  await atEveryWidth(`/price-migrations/approval/?id=${migrationId}`, async (on) => {
    await expect(on.getByRole("heading", { name: "Decision" })).toBeVisible();
    await expect(on.getByRole("region", { name: "What the law asks" })).toBeVisible();
  });
  await atEveryWidth(`/price-migrations/progress/?id=${migrationId}`, heading(/^Progress:/));
});

test("the prepaid passes: the list and the form", async () => {
  await atEveryWidth("/passes/", heading("Prepaid passes"));
  await atEveryWidth("/passes/new/", heading("The pass"));
});

test("the audit log, the price list and the launches", async () => {
  await atEveryWidth("/audit/", async (on) => {
    await expect(on.getByRole("heading", { name: "Events" })).toBeVisible();
    await expect(on.getByRole("table")).toBeVisible();
  });
  await atEveryWidth("/price-list/", heading("Price list"));
  await atEveryWidth("/launches/", heading("Launches"));
});
