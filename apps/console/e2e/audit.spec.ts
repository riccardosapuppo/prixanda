// The audit log's chain, as the auditor checks it (business book §11.3):
// what the page says about a verification is about the exported head that
// verification was given, never about what is typed afterwards.
import { expect, test } from "@playwright/test";
import { enterAs } from "./support.ts";

test("a verification speaks of the head it checked, and a new head typed in clears it", async ({ page }) => {
  await enterAs(page, "Auditor");
  await page.goto("/audit/");
  const verify = page.getByRole("button", { name: "Verify the chain" });

  // Without an exported head: the chain is recomputed on its own, and the page says so.
  await verify.click();
  const holds = page.getByRole("status").filter({ hasText: "The chain holds" });
  await expect(holds).toBeVisible();
  await expect(holds).not.toContainText("It leads to the exported head");

  // Typing a head in does not turn that answer into a claim about the head.
  await page.getByText("Check against an exported head").click();
  await page.getByLabel("Event #").fill("1");
  await page.getByLabel("Its hash (64 hexadecimal digits)").fill("ab".repeat(32));
  await expect(holds).toHaveCount(0);
  await expect(page.getByText(/leads to the exported head/)).toHaveCount(0);

  // Checked against that made-up head, the engine says the chain does not lead to it, and the page names the head.
  await verify.click();
  const broken = page.getByRole("alert").filter({ hasText: "Checked against the exported head #1 (abababab…)" });
  await expect(broken).toContainText("no longer leads to the exported head");

  // The real head, exported now and checked: the page says it leads to that one.
  await page.getByRole("button", { name: "Export the head" }).click();
  const exported = page.getByText(/^Exported head: event #(\d+)$/);
  await expect(exported).toBeVisible();
  const seq = (await exported.textContent())?.match(/#(\d+)/)?.[1] ?? "";
  await expect(page.getByLabel("Event #")).toHaveValue(seq);
  await expect(page.getByRole("alert").filter({ hasText: "Checked against" })).toHaveCount(0);
  await verify.click();
  await expect(page.getByRole("status").filter({ hasText: "The chain holds" })).toContainText(`It leads to the exported head #${seq}`);
});
