// What a launch shows, and what the on-call engineer may still do with it,
// by the engine's rules: the catalog of before stays live until the publish
// step is done; a failed, refused or waiting launch can be tried again; one
// that has not published can be given up; a published one cannot.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { elapsed, type LaunchDetail, launchActions, launchLook, launchWords, now, publication, stepCounts, stepLook } from "../src/lib/launch.ts";

type StepState = LaunchDetail["steps"][number]["state"];
const NAMES = ["check", "prepare", "publish", "notify", "verify"] as const;

/** A launch whose five steps stand as given, with the snapshots it wrote. */
function launch(state: LaunchDetail["state"], steps: readonly StepState[], extra: Partial<LaunchDetail> = {}): LaunchDetail {
  return {
    id: "12", run: "launch-12", title: "Student Autumn Pass", kind: "OFFER", version: 3, state,
    change: { id: "7", currentVersion: 3, state: "SCHEDULED" },
    starts: { market: "IT", local: "2026-10-26T09:00", utc: "2026-10-26T08:00:00Z" },
    dueAt: "2026-10-26T07:59:00Z", startedAt: "2026-10-26T07:59:00.080Z", finishedAt: null, currentStep: null, attempts: 0,
    cause: null, retryAt: null, resolution: null, snapshotBefore: "417", snapshotAfter: null,
    steps: NAMES.map((name, index) => ({ name, purpose: "", state: steps[index] ?? "PENDING", startedAt: null, finishedAt: null, attempts: 0, error: null, facts: [] })),
    auditEventSeqs: [], incidents: [],
    ...extra,
  };
}

describe("a launch, step by step", () => {
  it("keeps the catalog of before live until the publish step is done", () => {
    const failing = launch("RUNNING", ["DONE", "DONE", "FAILED"], { retryAt: "2026-10-26T07:59:05Z" });
    assert.deepEqual(publication(failing), { published: false, catalog: "417", at: null, words: "Nothing yet: catalog #417 stays live until the publish step is done." });
    const done = launch("DONE", ["DONE", "DONE", "DONE", "DONE", "DONE"], { snapshotAfter: "418" });
    assert.equal(publication(done).catalog, "418");
    assert.equal(publication(done).published, true);
  });

  it("tells what the launch published apart from what is live today", () => {
    const done = (state: LaunchDetail["change"]["state"]) => launch("DONE", ["DONE", "DONE", "DONE", "DONE", "DONE"], { snapshotAfter: "418", change: { id: "7", currentVersion: 3, state } });
    // Today as the launch left it: nothing to say.
    assert.deepEqual(now(done("ACTIVE"), "418"), { catalog: "418", words: "Student Autumn Pass v3 is live on the site.", differs: null });
    // Suspended since: the launch's own publication stays history, and today says otherwise.
    const suspended = now(done("SUSPENDED"), "431");
    assert.equal(suspended.words, "Student Autumn Pass v3 is suspended: it is not on the site.");
    assert.equal(suspended.differs, "Not what this launch left: it published catalog #418 with the change live; since then the change was suspended, and catalog #431 is the live one.");
    assert.equal(publication(done("SUSPENDED")).catalog, "418");
    // Still live, in a later catalog.
    assert.equal(now(done("ACTIVE"), "430").differs, "Catalog #430 is the live one now, published after this launch's #418; the change is still in it.");
  });

  it("says a failed step of a waiting launch will be tried again, and of a stopped one that it failed", () => {
    const waiting = launch("RUNNING", ["DONE", "DONE", "FAILED"], { retryAt: "2026-10-26T07:59:05Z" });
    assert.equal(stepLook(waiting.steps[2]!, waiting), "retrying");
    assert.equal(launchLook(waiting).word, "Waiting to try again");
    assert.equal(stepCounts(waiting.steps, waiting), "2 done, 1 to be tried again, 2 to do");
    const failed = launch("FAILED", ["DONE", "DONE", "FAILED"]);
    assert.equal(stepLook(failed.steps[2]!, failed), "failed");
    assert.equal(stepCounts(failed.steps, failed), "2 done, 1 failed, 2 to do");
  });

  it("lets the on-call engineer try again a failed, refused or waiting launch, and give up one that has not published", () => {
    assert.deepEqual(launchActions(launch("FAILED", ["DONE", "DONE", "FAILED"])), { retry: true, cancel: true });
    assert.deepEqual(launchActions(launch("REFUSED", ["FAILED"])), { retry: true, cancel: true });
    assert.deepEqual(launchActions(launch("RUNNING", ["DONE", "FAILED"], { retryAt: "2026-10-26T07:59:05Z" })), { retry: true, cancel: true });
    // Running a step now: nothing to try again yet; it can still be given up before it publishes.
    assert.deepEqual(launchActions(launch("RUNNING", ["DONE", "RUNNING"])), { retry: false, cancel: true });
    // Published: the change leaves the site by being suspended, not by giving up its launch.
    assert.deepEqual(launchActions(launch("RUNNING", ["DONE", "DONE", "DONE", "RUNNING"], { snapshotAfter: "418" })), { retry: false, cancel: false });
    assert.deepEqual(launchActions(launch("DONE", ["DONE", "DONE", "DONE", "DONE", "DONE"], { snapshotAfter: "418" })), { retry: false, cancel: false });
    assert.deepEqual(launchActions(launch("CANCELLED", ["DONE", "FAILED"])), { retry: false, cancel: false });
  });

  it("reads the engine's instants in the market's time, as a sentence", () => {
    assert.equal(
      launchWords("published at 2026-10-26T07:59:05.530Z, retried by on-call-1 at 2026-10-26T07:59:04Z", "Europe/Rome"),
      "Published at 26 Oct 08:59:05 Rome, retried by on-call-1 at 26 Oct 08:59:04 Rome",
    );
  });

  it("says how long after the launch began each step ended", () => {
    assert.equal(elapsed("2026-10-26T07:59:00.080Z", "2026-10-26T07:59:00.490Z"), "+0.41 s");
    assert.equal(elapsed("2026-10-26T07:59:00Z", "2026-10-26T07:59:12.300Z"), "+12.3 s");
    assert.equal(elapsed("2026-10-26T07:59:00Z", "2026-10-26T08:01:15Z"), "+2 min 15 s");
  });
});
