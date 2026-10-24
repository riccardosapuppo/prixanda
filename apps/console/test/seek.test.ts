// Finding the event a link names in the audit log, read newest first a page
// at a time: read on while it may still come, found when it is read, not
// found when the events read already go older than it or the log ends.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seek } from "../src/lib/seek.ts";

/** Sequence numbers from `from` down to `to`, as the engine pages them. */
const down = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, index) => String(from - index));

describe("finding the event a link names", () => {
  it("reads on past the newest fifty, and finds an older event on a later page", () => {
    assert.equal(seek("11", { loaded: true, seqs: down(120, 71), more: true }), "seeking");
    assert.equal(seek("11", { loaded: true, seqs: down(120, 21), more: true }), "seeking");
    assert.equal(seek("11", { loaded: true, seqs: down(120, 1), more: false }), "found");
  });

  it("says not found when the log ends, or the events read go older than it, or it is no event number", () => {
    assert.equal(seek("500", { loaded: true, seqs: down(120, 71), more: true }), "not-found");
    assert.equal(seek("11", { loaded: true, seqs: down(20, 12), more: false }), "not-found");
    assert.equal(seek("11", { loaded: true, seqs: ["30", "12", "9"], more: true }), "not-found");
    assert.equal(seek("eleven", { loaded: true, seqs: down(20, 1), more: false }), "not-found");
  });

  it("waits for the first page, and does nothing when no event is named", () => {
    assert.equal(seek("11", { loaded: false, seqs: [], more: false }), "seeking");
    assert.equal(seek(null, { loaded: true, seqs: down(20, 1), more: false }), "none");
  });
});
