// The demo's "Try this" (src/lib/guide.ts): the guided path, its steps
// ticked by what the engine says and what this browser recorded, kept in a
// storage that may refuse (a private window), and started again with a new
// campaign.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentStep, EMPTY_GUIDE, GUIDE_KEY, guideSteps, nextGuide, NO_FACTS, readGuide, recoveredFrom, writeGuide } from "../src/lib/guide.ts";

const done = (steps: ReturnType<typeof guideSteps>) => steps.filter((step) => step.done).map((step) => step.id);

describe("the steps of Try this", () => {
  it("starts on the site, then the campaign, and ticks each step from the engine's facts", () => {
    assert.equal(currentStep(guideSteps(EMPTY_GUIDE, NO_FACTS)), "site");
    const record = { ...EMPTY_GUIDE, siteOpened: true, changeId: "11" };
    assert.deepEqual(done(guideSteps(record, { state: "IN_APPROVAL", signed: false, recovered: false })), ["site", "create"]);
    assert.equal(currentStep(guideSteps(record, { state: "IN_APPROVAL", signed: false, recovered: false })), "own");
    const tried = { ...record, triedOwn: true };
    assert.deepEqual(done(guideSteps(tried, { state: "APPROVED", signed: true, recovered: false })), ["site", "create", "own", "approve"]);
    assert.deepEqual(done(guideSteps(tried, { state: "SCHEDULED", signed: true, recovered: false })), ["site", "create", "own", "approve", "schedule"]);
    // Live after a fault and its recovery; then the site, once more.
    const live = guideSteps({ ...tried, foundOnSite: true }, { state: "ACTIVE", signed: true, recovered: true });
    assert.equal(currentStep(live), null);
  });

  it("does not tick the campaign's steps for nobody's campaign", () => {
    assert.deepEqual(done(guideSteps({ ...EMPTY_GUIDE, triedOwn: true, foundOnSite: true }, { state: "ACTIVE", signed: true, recovered: true })), []);
  });

  it("takes a launch done with more attempts than its five steps as a recovery", () => {
    assert.equal(recoveredFrom({ state: "DONE", attempts: 5 }), false);
    assert.equal(recoveredFrom({ state: "DONE", attempts: 6 }), true);
    assert.equal(recoveredFrom({ state: "RUNNING", attempts: 7 }), false);
  });
});

describe("what this browser keeps", () => {
  function memory() {
    const items = new Map<string, string>();
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key), items };
  }

  it("reads back what it wrote, and nothing from a storage that refuses or holds nonsense", () => {
    const storage = memory();
    writeGuide(storage, { ...EMPTY_GUIDE, changeId: "12", siteOpened: true });
    assert.deepEqual(readGuide(storage), { ...EMPTY_GUIDE, changeId: "12", siteOpened: true });
    storage.items.set(GUIDE_KEY, "not json");
    assert.deepEqual(readGuide(storage), EMPTY_GUIDE);
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => undefined };
    assert.deepEqual(readGuide(refusing), EMPTY_GUIDE);
    assert.doesNotThrow(() => writeGuide(refusing, EMPTY_GUIDE));
  });

  it("starts a new campaign's steps again, keeping the site seen", () => {
    const record = { changeId: "11", triedOwn: true, siteOpened: true, foundOnSite: true };
    assert.deepEqual(nextGuide(record, { changeId: "13" }), { changeId: "13", triedOwn: false, siteOpened: true, foundOnSite: false });
    assert.deepEqual(nextGuide(record, { foundOnSite: true }), record);
  });
});
