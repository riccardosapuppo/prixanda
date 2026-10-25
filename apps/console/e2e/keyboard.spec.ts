// The keyboard alone creates and approves a campaign (the owner's brief: a
// keyboard path to create, approve and activate), and writes and submits a
// price migration: no click and no mouse; Tab, Enter, Space, the arrows and
// typing.
import { expect, test } from "@playwright/test";
import { tabTo } from "./support.ts";

const RUN = Date.now().toString(36);

test("Marketing creates and submits a campaign with the keyboard alone; Finance approves it the same way", async ({ page }) => {
  await page.goto("/sign-in/");
  await tabTo(page, page.getByRole("button", { name: "Enter as Marketing", exact: true }));
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));

  await tabTo(page, page.getByRole("link", { name: "Campaigns" }).first());
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/campaigns\/$/);
  await tabTo(page, page.getByRole("link", { name: "New campaign" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Audience" })).toBeVisible();

  await tabTo(page, page.getByLabel("Campaign name"));
  await page.keyboard.type(`Keyboard Pass ${RUN}`);
  await tabTo(page, page.getByRole("checkbox", { name: /^Italy/ }));
  await page.keyboard.press("Space");
  await tabTo(page, page.getByLabel("Plan", { exact: true }));
  await page.keyboard.type("Student");
  await expect(page.getByLabel("Plan", { exact: true })).toHaveValue("student");
  await tabTo(page, page.getByRole("radio", { name: /People who have never paid/ }));
  await page.keyboard.press("Space");
  await tabTo(page, page.getByLabel("Group", { exact: true }));
  await page.keyboard.type(`keyboard-${RUN}`);
  await tabTo(page, page.getByRole("button", { name: "Continue" }));
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Price" })).toBeFocused();
  await tabTo(page, page.getByLabel("Offer price in Italy, VAT included"));
  await page.keyboard.type("2.99");
  await tabTo(page, page.getByRole("button", { name: "Continue" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Dates" })).toBeFocused();
  await tabTo(page, page.getByRole("button", { name: "Continue" }));
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Page" })).toBeFocused();
  await tabTo(page, page.getByLabel("Title", { exact: true }));
  await page.keyboard.type("Keyboard Pass");
  await tabTo(page, page.getByLabel("Text", { exact: true }));
  await page.keyboard.type("Three months of Student for 2,99 € a month.");
  await tabTo(page, page.getByLabel("Terms"));
  await page.keyboard.type("New subscribers only.");
  await tabTo(page, page.getByRole("button", { name: "Continue" }));
  await page.keyboard.press("Enter");

  await tabTo(page, page.getByRole("button", { name: "Save v1 and check it" }));
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("The change in business words")).toContainText("Italy, Student: from €5.79 to €2.99");
  await tabTo(page, page.getByLabel(/Why is it worth running\?/));
  await page.keyboard.type("Tested from the keyboard.");
  await tabTo(page, page.getByRole("button", { name: "Submit v1 for approval" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText("v1 is in approval.", { exact: true })).toBeVisible();
  const id = new URL(page.url()).searchParams.get("id");

  // Finance, chosen from the rail's menu by typing its name.
  await tabTo(page, page.getByLabel("Signed in as"));
  await page.keyboard.type("Finance");
  await expect(page.getByLabel("Signed in as").locator("option:checked")).toHaveText("Finance");
  await expect(page.getByText(/Can.*approve price changes/)).toBeVisible();
  await tabTo(page, page.getByRole("link", { name: "Approvals" }).first());
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/approvals\/$/);
  const link = page.getByRole("link", { name: new RegExp(`Keyboard Pass ${RUN}`) });
  await tabTo(page, link);
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(`/campaigns/approval/\\?id=${id}`));
  await tabTo(page, page.getByRole("button", { name: "Approve v1 as Finance" }));
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Approve v1" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Approved v1 as Finance/)).toBeVisible();
});

test("the commercial lead writes and submits a price migration with the keyboard alone", async ({ page }) => {
  await page.goto("/sign-in/");
  await tabTo(page, page.getByRole("button", { name: "Enter as Commercial lead", exact: true }));
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));

  await tabTo(page, page.getByRole("link", { name: "Price migrations" }).first());
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/price-migrations\/$/);
  await tabTo(page, page.getByRole("link", { name: "New price migration" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "New price", level: 2 })).toBeVisible();

  // The book's example fills the dates; the rest is changed by hand: Individual in the United Kingdom.
  await tabTo(page, page.getByRole("button", { name: "Fill in the Family price rise in Germany" }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByLabel("Migration name"));
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(`Keyboard rise ${RUN}`);
  await tabTo(page, page.getByRole("radio", { name: /^Germany/ }));
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: /^United Kingdom/ })).toBeChecked();
  await tabTo(page, page.getByLabel("Plan", { exact: true }));
  await page.keyboard.type("Individual");
  await expect(page.getByLabel("Plan", { exact: true })).toHaveValue("individual");
  await tabTo(page, page.getByLabel("New price in United Kingdom, VAT included"));
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("10.49");
  await tabTo(page, page.getByRole("button", { name: "Continue" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Dates" })).toBeFocused();
  await tabTo(page, page.getByRole("button", { name: "Continue" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Check and submit" })).toBeFocused();

  await tabTo(page, page.getByRole("button", { name: "Save v1 and check it" }));
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("The change in business words")).toContainText("United Kingdom, Individual: from £9.49 to £10.49");
  await tabTo(page, page.getByRole("button", { name: "Submit v1 for approval" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText("v1 is in approval.", { exact: true })).toBeVisible();
});
