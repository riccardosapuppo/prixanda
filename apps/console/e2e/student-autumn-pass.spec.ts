// The Student Autumn Pass through the console (business book §14.1), on the
// whole system: Marketing writes it, the engine checks it, Marketing
// simulates and submits it, tries to approve it and cannot (no button, and
// the same call made by hand is refused by the server), Finance approves it
// by its version and fingerprint, Marketing schedules the launch, and the
// audit log holds every step with the request ids born in the console.
// axe runs on every screen on the way.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { axe, callByHand, daysAhead, enterAs, onlyLocal, switchTo, watchErrors } from "./support.ts";

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const TITLE = `Student Autumn Pass ${RUN}`;
const GROUP = `student-offers-${RUN}`;
/** When the pass starts in Italy: the day after tomorrow at 09:00 in Rome. */
const STARTS = daysAhead(2, "09:00", "Europe/Rome");

let context: BrowserContext;
let page: Page;
let errors: () => readonly string[];
let local: { readonly refused: () => readonly string[] };
let changeId = "";

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  local = await onlyLocal(context);
  page = await context.newPage();
  errors = watchErrors(page);
});

test.afterAll(async () => {
  await context.close();
});

test("the demo entry says it is not a login, and Marketing enters", async () => {
  await page.goto("/");
  await page.waitForURL(/\/sign-in\//);
  await expect(page.getByText("This is a demonstration entry, not a login")).toBeVisible();
  // Marketing first, where the guided path starts, then the team in the order of its table (§12.1).
  await expect(page.getByRole("button", { name: /^Enter as / })).toHaveText([
    "Enter as Marketing", "Enter as Marketing, second", "Enter as Commercial lead", "Enter as Finance", "Enter as Catalog manager", "Enter as On-call engineer",
    "Enter as Auditor",
  ]);
  await axe(page, "the demo entry");
  await enterAs(page, "Marketing");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Waiting for approval/ })).toBeVisible();
  await axe(page, "the home as Marketing");
});

test("Marketing writes the campaign in five steps, with the page beside it", async () => {
  await page.getByRole("link", { name: "Campaigns" }).first().click();
  await page.getByRole("link", { name: "New campaign" }).click();
  await expect(page.getByRole("heading", { name: "Audience" })).toBeVisible();
  await axe(page, "the guided creation, step 1");

  // Continue on an empty step stops on the first field, with its own message.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Give the campaign a name: it is how the team finds it.")).toBeVisible();
  await expect(page.getByLabel("Campaign name")).toBeFocused();

  await page.getByLabel("Campaign name").fill(TITLE);
  await page.getByRole("checkbox", { name: /^Italy/ }).check();
  await page.getByLabel("Plan", { exact: true }).selectOption("student");
  await page.getByRole("radio", { name: /People who have never paid/ }).check();
  await page.getByLabel("Group", { exact: true }).fill(GROUP);
  await expect(page.getByText("Give the campaign a name")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Price" })).toBeVisible();
  await expect(page.getByText("List price in force:")).toContainText("€5.79");
  await page.getByLabel("Offer price in Italy, VAT included").fill("2.99");
  await expect(page.getByText(/Below the floor in Italy \(€6\.10\)/)).toBeVisible();
  // The preview writes the price the Italian way, with the list price struck through.
  const preview = page.getByRole("figure");
  await expect(preview).toContainText("2,99\u00a0€");
  await expect(preview.locator("s")).toHaveText("5,79\u00a0€");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Dates" })).toBeVisible();
  // The day after tomorrow at 09:00 in Rome: in the future while the test runs, and among the next seven days the
  // launches show, whatever the weekday and the hour. The form's own start, the next Monday at 09:00, is more than
  // seven days away on a Monday morning.
  await page.getByLabel("Starts, Rome time").fill(STARTS);
  await expect(page.getByLabel("Starts, Rome time")).toHaveValue(STARTS);
  await expect(page.getByText(/09:00 Rome \(0[78]:00 UTC\)/)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Page" })).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("Student Autumn Pass");
  await page.getByLabel("Text", { exact: true }).fill("Three months of Student for 2,99 € a month. Then 5,79 €, the usual Student price.");
  await page.getByLabel("Terms").fill("For verified students in Italy who have never paid for a plan. Not combinable with other student offers.");
  await expect(preview).toContainText("Three months of Student for 2,99 € a month.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Check and submit" })).toBeVisible();
});

test("the engine checks v1: the change in business words, the eligible people, who has to sign", async () => {
  await page.getByRole("button", { name: "Save v1 and check it" }).click();
  await page.waitForURL(/\/campaigns\/edit\/\?id=\d+/);
  changeId = new URL(page.url()).searchParams.get("id") ?? "";
  expect(changeId).toMatch(/^\d+$/);
  const sentence = page.getByLabel("The change in business words");
  await expect(sentence).toContainText("Italy, Student: from €5.79 to €2.99 for 3 months, new subscribers only;");
  await expect(sentence).toContainText("conflicts: none.");
  await expect(page.getByText(/people eligible right now, counted in the simulated data/)).toBeVisible();
  await expect(page.getByText("Finance must sign: conditions 2 and 4 of §7.3.").first()).toBeVisible();
  await axe(page, "the check of v1");
});

test("the simulation opens with the verdict and takes a typed assumption, with its source", async () => {
  await page.getByRole("link", { name: "Simulation", exact: true }).click();
  await expect(page.getByRole("heading", { name: /At these assumptions the campaign (loses|earns)/ })).toBeVisible();
  await expect(page.getByText(/It breaks even if at least|No retention makes it break even/)).toBeVisible();
  const before = await page.getByRole("heading", { name: /At these assumptions/ }).textContent();
  const retention = page.getByRole("textbox", { name: /^Retention/ });
  await retention.fill("90");
  await retention.press("Enter");
  await expect(page.getByText(/Typed by Marketing at/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /At these assumptions/ })).not.toHaveText(before ?? "");
  await axe(page, "the simulation");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByText(/Typed by Marketing at/)).toHaveCount(0);
});

test("Marketing submits v1 with the reason that a negative contribution asks for", async () => {
  await page.getByRole("link", { name: "Campaign", exact: true }).click();
  await page.getByRole("button", { name: /^5\b/ }).click();
  const submit = page.getByRole("button", { name: "Submit v1 for approval" });
  await expect(submit).toBeVisible();
  const reasonRequired = await page.getByText("Required: the simulated contribution over 12 months is negative.").count();
  if (reasonRequired > 0) {
    await submit.click();
    await expect(page.getByText(/Write why the campaign is worth running/)).toBeVisible();
  }
  await page.getByLabel(/Why is it worth running\?/).fill("We are buying students now: at 55% retention after month 3 the pass pays for itself in the second year.");
  await submit.click();
  await expect(page.getByText("v1 is in approval.", { exact: true })).toBeVisible();
});

test("Marketing cannot approve: no button, the page says why, and the same call by hand is refused", async () => {
  await page.goto(`/campaigns/approval/?id=${changeId}`);
  await expect(page.getByRole("heading", { name: "Decision" })).toBeVisible();
  await expect(page.getByText("You wrote v1. Someone else has to approve it.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await axe(page, "the approval as its author");

  const fingerprint = (await page.getByLabel("Fingerprint of v1").textContent())?.trim() ?? "";
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  const answer = await callByHand(page, "mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { __typename ... on Refusal { code reason } ... on Change { state } } }", { id: changeId, fp: fingerprint });
  expect(answer.status).toBe(200);
  expect(answer.body.data.approveChange.__typename).toBe("Refusal");
  expect(answer.body.data.approveChange.code).toBe("ROLE_NOT_ALLOWED");
});

test("Finance approves v1, after a confirmation that names the version and the fingerprint", async () => {
  await switchTo(page, "Finance");
  const approve = page.getByRole("button", { name: "Approve v1 as Finance" });
  await expect(approve).toBeVisible();
  await approve.click();
  const dialog = page.getByRole("dialog", { name: "Approve v1 as Finance?" });
  await expect(dialog).toBeVisible();
  const fingerprint = (await page.getByLabel("Fingerprint of v1").textContent())?.trim() ?? "";
  await expect(dialog).toContainText(fingerprint);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await axe(page, "the approval's confirmation");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(approve).toBeFocused();
  await approve.click();
  await dialog.getByRole("button", { name: "Approve v1" }).click();
  await expect(page.getByText(/Approved v1 as Finance/)).toBeVisible();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
});

test("Marketing schedules the launch, and the launches show it among the next seven days", async () => {
  await switchTo(page, "Marketing");
  await page.goto(`/campaigns/approval/?id=${changeId}`);
  await page.getByRole("button", { name: "Schedule the launch" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Schedule the launch" }).click();
  await expect(page.getByText(/^Scheduled\. It starts at Italy:/)).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Launching in the next 7 days/ })).toBeVisible();
  await page.goto("/launches/");
  const week = page.getByRole("region", { name: "Starting in the next 7 days" });
  await expect(week.getByRole("listitem").filter({ hasText: TITLE })).toContainText("Scheduled");
});

test("the audit log holds every step, with the request ids born in the console; the auditor verifies and exports", async () => {
  await page.goto(`/audit/?change=${changeId}`);
  await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
  const table = page.getByRole("table", { name: /Events/ });
  for (const action of ["change.created", "change.validated", "change.submitted", "change.approved", "change.scheduled"]) {
    await expect(table.getByText(action, { exact: true })).toBeVisible();
  }
  await expect(table.getByText(/console:[0-9a-f-]{36}/).first()).toBeVisible();
  await expect(page.getByText("Everyone on the team reads the log, so any decision can be traced from any seat; the auditor exports it, and the auditor and the on-call engineer verify the chain. Nobody can change it through Prixanda.")).toBeVisible();
  // Marketing reads the log, and finds neither the verification nor the export: a lock says who does them.
  await expect(page.getByText("The auditor and the on-call engineer verify the chain. As Marketing you read every event below.")).toBeVisible();
  await expect(page.getByText("The auditor exports the log, with the head of the chain kept outside the database. As Marketing you read it, like everyone on the team.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify the chain" })).toHaveCount(0);
  await axe(page, "the audit log as Marketing");

  await switchTo(page, "Auditor");
  await page.getByRole("button", { name: "Verify the chain" }).click();
  await expect(page.getByText(/^The chain holds:/)).toBeVisible();
  await page.getByRole("button", { name: "Export the head" }).click();
  await expect(page.getByText(/Exported head: event #\d+/)).toBeVisible();
  await axe(page, "the audit log as the auditor");
});

test("revenue is for Finance and the commercial lead; the others see who reads it, and the server refuses them", async () => {
  await switchTo(page, "Marketing");
  await page.goto("/");
  await expect(page.getByText("Finance and the commercial lead read revenue and the standing top-ups.")).toBeVisible();
  await expect(page.getByText("Finance reads the value of prepaid passes sold and not yet earned (§9.2).")).toBeVisible();
  const asked = await callByHand(page, "query { overview { monthlyRevenueEur } }", {});
  expect(asked.body.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  await switchTo(page, "Finance");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Revenue this month, without VAT/ })).toContainText("€");
  // Finance reads the value of prepaid passes not yet earned in the same place (§9.2), where the others read who does.
  await expect(page.getByRole("heading", { name: /Prepaid passes sold, not yet earned/ })).toBeVisible();
  await expect(page.getByText("Finance reads the value of prepaid passes sold and not yet earned (§9.2).")).toHaveCount(0);
});

test("the price list reads the same for every role, and the launches page says what is not built yet", async () => {
  await page.goto("/price-list/");
  await expect(page.getByRole("heading", { name: "Price list", level: 1 })).toBeVisible();
  await expect(page.getByRole("table").first()).toContainText("€5.79");
  await axe(page, "the price list");
  await page.goto("/launches/");
  await expect(page.getByRole("heading", { name: "Launches", level: 1 })).toBeVisible();
  await axe(page, "the launches");
});

test("no page asked for anything outside 127.0.0.1, and no script failed", async () => {
  expect(local.refused()).toEqual([]);
  expect(errors()).toEqual([]);
});
