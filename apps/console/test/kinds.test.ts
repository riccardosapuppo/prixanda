// Where each kind of change lives (src/lib/kinds.ts): a migration in the
// approvals' queue opens as a migration, a pass as a pass, a draft in its
// form; and who writes, schedules and cancels each kind is the team's table.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approvalHref, changeHref, editHref, KINDS, progressHref, simulationHref } from "../src/lib/kinds.ts";
import { TEAM } from "../src/lib/permissions.ts";

describe("where a change opens", () => {
  it("a draft opens in its own form, anything else on its approval page, under its own section", () => {
    assert.equal(changeHref({ id: "7", state: "DRAFT", kind: "OFFER" }), "/campaigns/edit/?id=7");
    assert.equal(changeHref({ id: "7", state: "IN_APPROVAL", kind: "OFFER" }), "/campaigns/approval/?id=7");
    assert.equal(changeHref({ id: "12", state: "VALIDATED", kind: "PRICE_MIGRATION" }), "/price-migrations/edit/?id=12");
    assert.equal(changeHref({ id: "12", state: "ACTIVE", kind: "PRICE_MIGRATION" }), "/price-migrations/approval/?id=12");
    assert.equal(changeHref({ id: "15", state: "DRAFT", kind: "PREPAID" }), "/passes/edit/?id=15");
    assert.equal(changeHref({ id: "15", state: "SCHEDULED", kind: "PREPAID" }), "/passes/approval/?id=15");
  });

  it("a kind the console only reads opens on the approval page, whatever its state", () => {
    assert.equal(changeHref({ id: "3", state: "DRAFT", kind: "LIST_PRICE" }), "/campaigns/approval/?id=3");
    assert.equal(editHref("ENTITLEMENT", "4"), "/campaigns/approval/?id=4");
  });

  it("a step of a form, a simulation, a migration's progress", () => {
    assert.equal(editHref("PRICE_MIGRATION", "12", 3), "/price-migrations/edit/?id=12&step=3");
    assert.equal(approvalHref("PREPAID", "15"), "/passes/approval/?id=15");
    assert.equal(simulationHref("PRICE_MIGRATION", "12"), "/price-migrations/simulation/?id=12");
    assert.equal(simulationHref("OFFER", "7"), "/campaigns/simulation/?id=7");
    assert.equal(simulationHref("PREPAID", "15"), null);
    assert.equal(progressHref("12"), "/price-migrations/progress/?id=12");
  });
});

describe("who moves each kind on", () => {
  it("names rights of the team's table: Marketing for campaigns, the commercial lead for prices", () => {
    for (const kind of Object.values(KINDS)) {
      for (const right of [kind.writes, kind.schedules, kind.cancels]) if (right !== null) assert.ok(right in TEAM.rights, right);
    }
    assert.deepEqual(TEAM.rights[KINDS.PRICE_MIGRATION.writes ?? "createOffer"], ["COMMERCIAL_LEAD"]);
    assert.deepEqual(TEAM.rights[KINDS.PREPAID.schedules ?? "scheduleOffer"], ["COMMERCIAL_LEAD"]);
    assert.deepEqual(TEAM.rights[KINDS.OFFER.schedules ?? "schedulePrice"], ["MARKETING", "COMMERCIAL_LEAD"]);
  });
});
