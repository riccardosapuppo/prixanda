// The launches in the console's schema (stage 6): the engine's job that
// activates a scheduled change, step by step, read by every role and retried
// or cancelled by the on-call engineer alone (§12), and the incidents of the
// home with their launch. The fake engine follows the engine's LaunchService
// (commerce/engine/launches.py), its checks in their order.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ChangeState } from "contracts/commerce/v1/changes";
import { codes, type Harness, startHarness } from "./support/harness.ts";

const RUN = `id run state title kind version currentStep attempts cause retryAt snapshotBefore snapshotAfter resolution dueAt startedAt finishedAt
  starts { market local utc } change { id state }
  incidents { id kind state summary openedAt closedAt resolution }`;
const DETAIL = `${RUN} steps { name purpose state startedAt finishedAt attempts error facts { name value } } auditEventSeqs`;
const RESULT = `__typename ... on LaunchRun { ${DETAIL} } ... on Refusal { code reason facts { name value } }`;

let harness: Harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness.close();
});

describe("reading the launches", () => {
  test("a page of launches, newest first by keyset, filtered by state or by change, for every role", async () => {
    const done = harness.engine.seedLaunch("done");
    const failed = harness.engine.seedLaunch("failed");
    const refused = harness.engine.seedLaunch("refused");
    const auditor = harness.console();
    await auditor.signIn("auditor-1");
    harness.engine.clearCalls();
    const first = await auditor.graphql(`{ launches(first: 2) { nodes { id run state steps { name } auditEventSeqs } next } }`);
    assert.equal(first.body.errors, undefined, first.text);
    assert.deepEqual(first.body.data.launches.nodes.map((launch: { id: string }) => launch.id), [refused.id, failed.id]);
    assert.deepEqual(first.body.data.launches.nodes[0], { id: refused.id, run: `launch-${refused.id}`, state: "REFUSED", steps: [], auditEventSeqs: [] },
      "a page carries no steps and no audit events: launch(id) reads them");
    const call = harness.engine.calls.find((candidate) => candidate.method === "ListLaunches");
    assert.deepEqual([call?.actor, call?.role, call?.idempotencyKey], ["auditor-1", "auditor", null]);
    const second = await auditor.graphql(`query ($after: String) { launches(first: 2, after: $after) { nodes { id } next } }`, { variables: { after: first.body.data.launches.next } });
    assert.deepEqual(second.body.data.launches, { nodes: [{ id: done.id }], next: null });
    const failing = await auditor.graphql(`{ launches(filter: { state: FAILED }) { nodes { id } } }`);
    assert.deepEqual(failing.body.data.launches.nodes, [{ id: failed.id }]);
    const ofChange = await auditor.graphql(`query ($change: ID!) { launches(filter: { changeId: $change }) { nodes { id change { id } } } }`, { variables: { change: done.changeId } });
    assert.deepEqual(ofChange.body.data.launches.nodes, [{ id: done.id, change: { id: done.changeId } }]);
    for (const person of ["marketing-1", "commercial-lead-1", "finance-1", "catalog-manager-1", "on-call-1"]) {
      const reader = harness.console();
      await reader.signIn(person);
      assert.equal((await reader.graphql("{ launches { nodes { id } } }")).body.errors, undefined, person);
    }
  });

  test("one launch, step by step: five steps, the snapshots before and after, the audit events it wrote", async () => {
    const done = harness.engine.seedLaunch("done", "Student Autumn Pass");
    const reader = harness.console();
    await reader.signIn("marketing-1");
    const answer = await reader.graphql(`query ($id: ID!) { launch(id: $id) { ${DETAIL} } }`, { variables: { id: done.id } });
    assert.equal(answer.body.errors, undefined, answer.text);
    const launch = answer.body.data.launch;
    assert.deepEqual(launch.steps.map((step: { name: string; state: string }) => `${step.name} ${step.state}`),
      ["check DONE", "prepare DONE", "publish DONE", "notify DONE", "verify DONE"]);
    assert.deepEqual({ state: launch.state, currentStep: launch.currentStep, snapshotBefore: launch.snapshotBefore, snapshotAfter: launch.snapshotAfter, cause: launch.cause },
      { state: "DONE", currentStep: null, snapshotBefore: "41", snapshotAfter: "42", cause: null });
    assert.deepEqual({ title: launch.title, kind: launch.kind, version: launch.version, starts: launch.starts, dueAt: launch.dueAt, change: launch.change },
      { title: "Student Autumn Pass", kind: "OFFER", version: 1, starts: { market: "IT", local: "2026-11-02T09:00", utc: "2026-11-02T08:00:00Z" }, dueAt: "2026-11-02T07:59:00Z", change: { id: done.changeId, state: "ACTIVE" } });
    assert.deepEqual(launch.steps[1].facts, [{ name: "offers", value: "3" }, { name: "snapshot", value: "42" }]);
    assert.match(launch.steps[2].purpose, /^In one transaction/);
    assert.equal(launch.auditEventSeqs.length, 2);
    // The audit log has them under the launch's run: the console finds them by their numbers.
    const auditor = harness.console();
    await auditor.signIn("auditor-1");
    const log = await auditor.graphql(`query ($subject: String!) { auditEvents(filter: { subject: $subject }) { nodes { seq action requestId } } }`, { variables: { subject: `change:${done.changeId}` } });
    const activated = log.body.data.auditEvents.nodes.find((event: { action: string }) => event.action === "change.activated");
    assert.ok(launch.auditEventSeqs.includes(activated.seq));
    assert.equal(activated.requestId, launch.run);
  });

  test("a failed launch says where it stopped and why, with its incident open", async () => {
    const failed = harness.engine.seedLaunch("failed");
    const reader = harness.console();
    await reader.signIn("on-call-1");
    const launch = (await reader.graphql(`query ($id: ID!) { launch(id: $id) { ${DETAIL} } }`, { variables: { id: failed.id } })).body.data.launch;
    assert.deepEqual({ state: launch.state, currentStep: launch.currentStep, cause: launch.cause, attempts: launch.attempts, snapshotAfter: launch.snapshotAfter },
      { state: "FAILED", currentStep: "publish", cause: "the connection to the database was cut", attempts: 7, snapshotAfter: null });
    assert.deepEqual(launch.steps.map((step: { state: string; attempts: number }) => `${step.state} ${step.attempts}`), ["DONE 1", "DONE 1", "FAILED 5", "PENDING 0", "PENDING 0"]);
    assert.equal(launch.steps[3].startedAt, null);
    assert.deepEqual(launch.incidents.map((incident: { kind: string; state: string; closedAt: string | null }) => [incident.kind, incident.state, incident.closedAt]), [["FAILED", "OPEN", null]]);
  });

  test("a malformed launch id is BAD_USER_INPUT before the engine; an unknown one is NOT_FOUND", async () => {
    const reader = harness.console();
    await reader.signIn("auditor-1");
    harness.engine.clearCalls();
    assert.deepEqual(codes(await reader.graphql('{ launch(id: "launch-1") { id } }')), ["BAD_USER_INPUT"]);
    assert.deepEqual(codes(await reader.graphql('{ launches(filter: { changeId: "x" }) { nodes { id } } }')), ["BAD_USER_INPUT"]);
    assert.equal(harness.engine.count(), 0);
    const unknown = await reader.graphql('{ launch(id: "999999") { id } }');
    assert.deepEqual(codes(unknown), ["NOT_FOUND"]);
    assert.equal(unknown.body.data.launch, null);
  });
});

describe("retrying and cancelling a launch", () => {
  test("only the on-call engineer: the other roles are refused with ROLE_NOT_ALLOWED before the engine", async () => {
    const failed = harness.engine.seedLaunch("failed");
    for (const person of ["marketing-1", "commercial-lead-1", "finance-1", "catalog-manager-1", "auditor-1"]) {
      const client = harness.console();
      await client.signIn(person);
      harness.engine.clearCalls();
      for (const mutation of [`retryLaunch(launchId: "${failed.id}")`, `cancelLaunch(launchId: "${failed.id}", reason: "Not today.")`]) {
        const answer = await client.graphql(`mutation { ${mutation} { __typename ... on Refusal { code } } }`);
        assert.deepEqual(answer.body.data[mutation.slice(0, mutation.indexOf("("))], { __typename: "Refusal", code: "ROLE_NOT_ALLOWED" }, `${person}: ${mutation}`);
      }
      assert.equal(harness.engine.count("RetryLaunch") + harness.engine.count("CancelLaunch"), 0, person);
    }
  });

  test("the on-call engineer retries a failed launch: it runs again, and its resolution and the log say who and why", async () => {
    const failed = harness.engine.seedLaunch("failed");
    const onCall = harness.console();
    await onCall.signIn("on-call-1");
    harness.engine.clearCalls();
    const query = `mutation ($id: ID!) { retryLaunch(launchId: $id, reason: "The database is back.") { ${RESULT} } }`;
    const answer = await onCall.graphql(query, { variables: { id: failed.id }, key: "retry-launch-0001" });
    const launch = answer.body.data.retryLaunch;
    assert.equal(launch.__typename, "LaunchRun", answer.text);
    assert.deepEqual({ state: launch.state, finishedAt: launch.finishedAt }, { state: "RUNNING", finishedAt: null });
    assert.match(launch.resolution, /^retried by on-call-1 at .*: The database is back\.$/);
    const call = harness.engine.calls.find((candidate) => candidate.method === "RetryLaunch");
    assert.deepEqual([call?.actor, call?.role, call?.idempotencyKey], ["on-call-1", "on_call", "retry-launch-0001"]);
    assert.equal(harness.engine.audit.at(-1)?.action, "launch.retried");
    assert.ok(launch.auditEventSeqs.includes(harness.engine.audit.at(-1)?.seq));
    // The same key answers the same; a launch that runs is not retried again.
    const again = await onCall.graphql(query, { variables: { id: failed.id }, key: "retry-launch-0001" });
    assert.deepEqual(again.body.data, answer.body.data);
    const running = await onCall.graphql(query, { variables: { id: failed.id } });
    assert.deepEqual({ typename: running.body.data.retryLaunch.__typename, code: running.body.data.retryLaunch.code }, { typename: "Refusal", code: "WRONG_STATE" });
  });

  test("cancelling needs a reason, and a launch that has not published; it cancels the change and resolves the incident", async () => {
    const refused = harness.engine.seedLaunch("refused");
    const done = harness.engine.seedLaunch("done");
    const onCall = harness.console();
    await onCall.signIn("on-call-1");
    const cancel = `mutation ($id: ID!, $reason: String!) { cancelLaunch(launchId: $id, reason: $reason) { ${RESULT} } }`;
    const blank = (await onCall.graphql(cancel, { variables: { id: refused.id, reason: "  " } })).body.data.cancelLaunch;
    assert.deepEqual({ typename: blank.__typename, code: blank.code }, { typename: "Refusal", code: "REASON_REQUIRED" });
    const live = (await onCall.graphql(cancel, { variables: { id: done.id, reason: "Too late." } })).body.data.cancelLaunch;
    assert.deepEqual({ typename: live.__typename, code: live.code }, { typename: "Refusal", code: "WRONG_STATE" });
    assert.match(live.reason, /has published/);
    const answer = await onCall.graphql(cancel, { variables: { id: refused.id, reason: "The clash stays: we launch it next week instead." } });
    const launch = answer.body.data.cancelLaunch;
    assert.equal(launch.__typename, "LaunchRun", answer.text);
    // The change read in the same answer is the engine's now: the mutation's loader forgot it.
    assert.deepEqual({ state: launch.state, change: launch.change.state }, { state: "CANCELLED", change: "CANCELLED" });
    assert.equal(launch.resolution, "cancelled by on-call-1: The clash stays: we launch it next week instead.");
    assert.deepEqual(launch.incidents.map((incident: { state: string; resolution: string }) => [incident.state, incident.resolution]),
      [["RESOLVED", "cancelled by on-call-1: The clash stays: we launch it next week instead."]]);
    assert.deepEqual(harness.engine.audit.slice(-2).map((event) => event.action), ["change.cancelled", "launch.cancelled"]);
  });

  test("without an Idempotency-Key, a launch's mutation is refused before the engine", async () => {
    const failed = harness.engine.seedLaunch("failed");
    const onCall = harness.console();
    await onCall.signIn("on-call-1");
    harness.engine.clearCalls();
    const answer = await onCall.graphql(`mutation { retryLaunch(launchId: "${failed.id}") { __typename } }`, { key: false });
    assert.deepEqual(codes(answer), ["BAD_USER_INPUT"]);
    assert.equal(harness.engine.count("RetryLaunch"), 0);
  });
});

describe("the home's incidents", () => {
  test("carry their launch, their kind and when they opened and closed", async () => {
    const failed = harness.engine.seedLaunch("failed");
    const late = harness.engine.seedOffer("Late start", "marketing-1", ChangeState.SCHEDULED);
    harness.engine.incidents.push(
      { changeId: failed.changeId, title: "Failed launch", run: `launch-${failed.id}`, state: "open", summary: "Failed at its publish step.", launchId: failed.id, kind: "failed", openedAt: "2026-11-02T07:59:20Z" },
      { changeId: late.id, title: "Late start", run: "", state: "open", summary: "Not live 5 minutes after its start.", launchId: "0", kind: "late", openedAt: "2026-11-02T08:05:00Z" },
      { changeId: failed.changeId, title: "Recovered", run: `launch-${failed.id}`, state: "recovered", summary: "Went through on its own.", launchId: failed.id, kind: "late", openedAt: "2026-11-01T08:05:00Z", closedAt: "2026-11-01T08:06:10Z", resolution: "published at 2026-11-01T08:06:10Z" },
    );
    try {
      const onCall = harness.console();
      await onCall.signIn("on-call-1");
      const answer = await onCall.graphql("{ overview { incidentsToday { title state launchId kind openedAt closedAt resolution } } }");
      assert.equal(answer.body.errors, undefined, answer.text);
      assert.deepEqual(answer.body.data.overview.incidentsToday, [
        { title: "Failed launch", state: "OPEN", launchId: failed.id, kind: "FAILED", openedAt: "2026-11-02T07:59:20Z", closedAt: null, resolution: null },
        { title: "Late start", state: "OPEN", launchId: null, kind: "LATE", openedAt: "2026-11-02T08:05:00Z", closedAt: null, resolution: null },
        { title: "Recovered", state: "RECOVERED", launchId: failed.id, kind: "LATE", openedAt: "2026-11-01T08:05:00Z", closedAt: "2026-11-01T08:06:10Z", resolution: "published at 2026-11-01T08:06:10Z" },
      ]);
    } finally {
      harness.engine.incidents.length = 0;
    }
  });
});
