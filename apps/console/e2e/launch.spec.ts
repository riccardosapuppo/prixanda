// A real launch on the whole system (business book §7.5, §14.6). An offer is
// written, approved and scheduled to start within the minute; the engine
// begins its launch at once (a minute before the start) and runs it step by
// step. The engine of these tests runs from its fault-injection launcher
// (services/commerce/tests/faults/engine_with_faults.py, armed by e2e/run.ts):
// the publish step's database connection is cut inside its transaction, once.
// The step rolls back, the catalog of before stays live, the engine tries the
// step again five seconds later, and the launch goes through. The console's
// timeline shows all of it; the on-call engineer's actions are refused by the
// server to every other role, and to a launch that is done.
import { expect, test } from "@playwright/test";
import { asPerson, axe, callByHand, enterAs, switchTo } from "./support.ts";

const RUN = Date.now().toString(36);

/** The local time in a zone, the contract's way, of the first whole minute at least `ahead` milliseconds from now. */
function nextMinuteIn(zone: string, ahead: number): string {
  const at = new Date(Math.ceil((Date.now() + ahead) / 60_000) * 60_000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}

type Step = { name: string; state: string; attempts: number; error: string | null };
type Seen = { id: string; run: string; state: string; retryAt: string | null; snapshotBefore: string | null; snapshotAfter: string | null; steps: Step[] };

const LAUNCH = "id run state retryAt snapshotBefore snapshotAfter steps { name state attempts error }";

test("a scheduled offer launches step by step, a cut publish is tried again, and the timeline shows it", async ({ page }) => {
  test.setTimeout(150_000);
  const marketing = asPerson("marketing-1");
  const finance = asPerson("finance-1");
  await marketing.signIn();
  await finance.signIn();

  // Written, checked and submitted by Marketing; it starts at the next whole minute at least 20 seconds away, in Paris.
  const title = `Launch Pass ${RUN}`;
  const startsLocal = nextMinuteIn("Europe/Paris", 20_000);
  const offer = {
    title,
    plan: "individual",
    audience: { segment: "FREE_LISTENERS", needsStudentCheck: false },
    prices: [{ market: "FR", fixed: { amountMinor: "799", currency: "EUR" } }],
    monthsAtOfferPrice: 1,
    periods: [{ market: "FR", startsLocal }],
    nonCombinabilityGroup: `launch-${RUN}`,
    pages: [{ market: "FR", title, text: "Un mois d'Individual à 7,99 €.", terms: "Pour les auditeurs gratuits en France.", treatment: "standard" }],
  };
  const created = await marketing.mutate("mutation ($offer: OfferInput!) { createOffer(offer: $offer) { __typename ... on Change { id } ... on Refusal { code reason } } }", { offer });
  expect(created.createOffer.__typename, JSON.stringify(created.createOffer)).toBe("Change");
  const id = String(created.createOffer.id);
  const checked = await marketing.mutate("mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { __typename ... on Change { validation { valid } } ... on Refusal { code reason } } }", { id });
  expect(checked.validateChange.validation?.valid, JSON.stringify(checked.validateChange)).toBe(true);
  const submitted = await marketing.mutate(
    "mutation ($id: ID!) { submitChange(changeId: $id, version: 1, authorReason: \"A month to try Individual, for free listeners who stream every week.\") { __typename ... on Change { state current { fingerprint } } ... on Refusal { code reason } } }",
    { id },
  );
  expect(submitted.submitChange.state, JSON.stringify(submitted.submitChange)).toBe("IN_APPROVAL");

  // Finance approves it (Finance may sign whatever it needs), Marketing schedules it.
  const approved = await finance.mutate(
    "mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { __typename ... on Change { state } ... on Refusal { code reason } } }",
    { id, fp: submitted.submitChange.current.fingerprint },
  );
  expect(approved.approveChange.state, JSON.stringify(approved.approveChange)).toBe("APPROVED");
  const scheduled = await marketing.mutate("mutation ($id: ID!) { scheduleChange(changeId: $id) { __typename ... on Change { state } ... on Refusal { code reason } } }", { id });
  expect(scheduled.scheduleChange.state, JSON.stringify(scheduled.scheduleChange)).toBe("SCHEDULED");

  // The engine begins the launch within its next pass, meets the cut in the publish step, waits, and goes through.
  const seen: Seen[] = [];
  let launch: Seen | null = null;
  await expect.poll(async () => {
    const answer = await marketing.query(`query ($id: ID!) { launches(filter: { changeId: $id }, first: 1) { nodes { id } } }`, { id });
    const first = answer.launches.nodes[0];
    if (!first) return "not begun";
    launch = (await marketing.query(`query ($id: ID!) { launch(id: $id) { ${LAUNCH} } }`, { id: first.id })).launch as Seen;
    seen.push(launch);
    return launch.state;
  }, { timeout: 100_000, intervals: [250] }).toBe("DONE");
  const done = launch as unknown as Seen;

  // While it waited: the publish step had failed, nothing had gone live, and the engine named when it would try again.
  const waited = seen.find((at) => at.state === "RUNNING" && at.retryAt !== null);
  expect(waited, "the launch was seen waiting to try its publish step again").toBeTruthy();
  expect(waited?.steps.find((step) => step.name === "publish")?.state).toBe("FAILED");
  expect(waited?.snapshotAfter ?? null).toBeNull();
  // At the end: five steps done, the publish step on its second attempt, a new catalog live.
  expect(done.steps.map((step) => step.state)).toEqual(["DONE", "DONE", "DONE", "DONE", "DONE"]);
  expect(done.steps.find((step) => step.name === "publish")?.attempts).toBe(2);
  expect(done.snapshotAfter).not.toBeNull();
  expect(done.snapshotAfter).not.toBe(done.snapshotBefore);

  // The console: the run in the launches, then its timeline.
  await enterAs(page, "Marketing");
  await page.goto("/launches/");
  await expect(page.getByRole("link", { name: done.run })).toBeVisible();
  await page.getByRole("link", { name: done.run }).click();
  await expect(page.getByRole("heading", { name: `Launch timeline: ${done.run}`, level: 1 })).toBeVisible();
  await expect(page.getByText("5 done")).toBeVisible();
  await expect(page.getByText("attempt 2 of 5")).toBeVisible();
  const live = page.getByRole("region", { name: "Live now" });
  await expect(live.getByText(`#${done.snapshotAfter}`)).toBeVisible();
  await expect(live.getByText("The change is live on the site, in one piece.")).toBeVisible();
  const events = page.getByRole("region", { name: "Audit events" });
  await expect(events.getByText("change.activated")).toBeVisible();
  await expect(events.getByText("catalog.published")).toBeVisible();
  await expect(page.getByText(/Published: there is nothing to try again/)).toBeVisible();
  await axe(page, "a launch's timeline");

  // Trying a launch again is the on-call engineer's: the server refuses it to Marketing, and to a launch that is done.
  const byMarketing = await callByHand(page, "mutation ($id: ID!) { retryLaunch(launchId: $id) { __typename ... on Refusal { code } } }", { id: done.id });
  expect(byMarketing.body.data.retryLaunch).toEqual({ __typename: "Refusal", code: "ROLE_NOT_ALLOWED" });
  await switchTo(page, "On-call engineer");
  const byOnCall = await callByHand(page, "mutation ($id: ID!) { retryLaunch(launchId: $id) { __typename ... on Refusal { code } } }", { id: done.id });
  expect(byOnCall.body.data.retryLaunch).toEqual({ __typename: "Refusal", code: "WRONG_STATE" });
});
