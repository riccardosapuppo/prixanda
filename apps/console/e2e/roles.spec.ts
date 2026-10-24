// Separation of duties seen from the console (business book §7.4, §12): the
// commercial lead, who may approve, cannot approve a version they wrote (the
// page has no button and says why; the server refuses it as OWN_VERSION),
// cannot sign what only Finance may sign but may still send it back to its
// author (sending back is not signing), and the roles that only read find a
// lock with the reason where the actions would be.
import { expect, test } from "@playwright/test";
import { asPerson, axe, callByHand, enterAs, submittedOffer, switchTo } from "./support.ts";

const RUN = Date.now().toString(36);

test("the commercial lead cannot approve a list price they wrote: no button, and the server says OWN_VERSION", async ({ page }) => {
  const lead = asPerson("commercial-lead-1");
  await lead.signIn();
  const starts = new Date(Date.now() + 21 * 86_400_000);
  const startsLocal = `${starts.getUTCFullYear()}-${String(starts.getUTCMonth() + 1).padStart(2, "0")}-${String(starts.getUTCDate()).padStart(2, "0")}T00:00`;
  const created = await lead.mutate(
    "mutation ($price: ListPriceInput!) { createListPrice(listPrice: $price) { __typename ... on Change { id } ... on Refusal { code reason } } }",
    { price: { title: `Duo in France ${RUN}`, plan: "duo", market: "FR", amount: { amountMinor: "1599", currency: "EUR" }, startsLocal } },
  );
  expect(created.createListPrice.__typename).toBe("Change");
  const id = String(created.createListPrice.id);
  const validated = await lead.mutate("mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { __typename ... on Refusal { code reason } } }", { id });
  expect(validated.validateChange.__typename).toBe("Change");
  const submitted = await lead.mutate("mutation ($id: ID!) { submitChange(changeId: $id, version: 1) { __typename ... on Change { state } ... on Refusal { code reason } } }", { id });
  expect(submitted.submitChange.state).toBe("IN_APPROVAL");

  await enterAs(page, "Commercial lead");
  await page.goto(`/campaigns/approval/?id=${id}`);
  await expect(page.getByText("You wrote v1. Someone else has to approve it.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  const fingerprint = (await page.getByLabel("Fingerprint of v1").textContent())?.trim() ?? "";
  const answer = await callByHand(page, "mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { __typename ... on Refusal { code } } }", { id, fp: fingerprint });
  expect(answer.body.data.approveChange.code).toBe("OWN_VERSION");
});

test("the commercial lead cannot sign what only Finance may sign, the page names who must, and the lead sends it back", async ({ page }) => {
  const id = await submittedOffer(`Finance only ${RUN}`, `finance-only-${RUN}`);
  await enterAs(page, "Commercial lead");
  await page.goto(`/campaigns/approval/?id=${id}`);
  await expect(page.getByText("As Commercial lead you can't sign this one: it needs Finance (conditions 2 and 4).")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await expect(page.getByText("You can still send v1 back to its author, with a reason.")).toBeVisible();
  await page.getByRole("button", { name: "Send back with a reason" }).click();
  await page.getByLabel("Why v1 goes back to its author").fill("Keep it to Italy until the floor is agreed.");
  await page.getByRole("button", { name: "Send v1 back" }).click();
  const dialog = page.getByRole("dialog", { name: "Send v1 back to its author?" });
  await dialog.getByRole("button", { name: "Send v1 back" }).click();
  await expect(page.getByText("Sent v1 back to draft, with your reason.")).toBeVisible();
});

test("roles that only read find a lock and the reason where the actions would be", async ({ page }) => {
  const id = await submittedOffer(`Locks ${RUN}`, `locks-${RUN}`);
  await enterAs(page, "Auditor");
  await page.goto("/campaigns/");
  await expect(page.getByText("Marketing creates campaigns; as Auditor you read them.")).toBeVisible();
  await expect(page.getByRole("link", { name: "New campaign" })).toHaveCount(0);
  await page.goto(`/campaigns/edit/?id=${id}&step=1`);
  await expect(page.getByText(/Marketing creates and submits campaigns\. As Auditor you read this one, with its fields read-only\./)).toBeVisible();
  await expect(page.getByRole("link", { name: /in Approvals$/ })).toHaveCount(0);
  await expect(page.getByLabel("Campaign name")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await page.goto(`/campaigns/simulation/?id=${id}`);
  await expect(page.getByText(/Marketing, the commercial lead and Finance run simulations\./)).toBeVisible();
  await axe(page, "the simulation, locked for the auditor");
  await switchTo(page, "On-call engineer");
  await page.goto(`/campaigns/approval/?id=${id}`);
  await expect(page.getByText(/As On-call engineer you can't sign this one/)).toBeVisible();
});
