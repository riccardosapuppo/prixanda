// What the approval page offers, by the engine's rules (services/commerce,
// engine/changes.py: approve and reject). Signing needs the signature the
// version asks for; sending back does not: both roles that review may send a
// version back to its author, even one that asks for the other's signature.
// Neither is open to whoever wrote any version of the change.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ApprovalView, decide, decisionSentence, type Role, sendsBack, type Signature } from "../src/lib/permissions.ts";

const FINANCE_SIGNS: Signature = { role: "FINANCE", conditions: [2, 4], why: "Finance must sign: conditions 2 and 4 of §7.3.", signed: false };

/** The Student Autumn Pass in approval: Marketing wrote its three versions, Finance must sign v3. */
function pass(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    state: "IN_APPROVAL",
    version: 3,
    versions: [1, 2, 3].map((version) => ({ version, authorId: "marketing-1" })),
    signatures: [FINANCE_SIGNS],
    approvals: [],
    ...over,
  };
}

const person = (personId: string, ...roles: Role[]) => ({ personId, roles });
const LEAD = person("lead-1", "COMMERCIAL_LEAD");
const FINANCE = person("finance-1", "FINANCE");
const MARKETING = person("marketing-1", "MARKETING");

describe("sending a version back", () => {
  it("is open to the commercial lead on an offer only Finance may sign", () => {
    assert.equal(decide(pass(), LEAD).kind, "needs-another-role");
    assert.equal(sendsBack(pass(), LEAD), true);
  });

  it("is open to Finance, who also signs", () => {
    assert.equal(decide(pass(), FINANCE).kind, "sign");
    assert.equal(sendsBack(pass(), FINANCE), true);
  });

  it("is closed to the roles that do not review", () => {
    for (const role of ["MARKETING", "CATALOG_MANAGER", "ON_CALL", "AUDITOR"] as const) {
      assert.equal(sendsBack(pass(), person("someone-1", role)), false, role);
    }
  });

  it("is closed to the author of the version, and to the author of an earlier one", () => {
    assert.equal(sendsBack(pass(), MARKETING), false);
    const leadWroteV1 = pass({ versions: [{ version: 1, authorId: "lead-1" }, { version: 2, authorId: "marketing-1" }, { version: 3, authorId: "marketing-1" }] });
    assert.equal(sendsBack(leadWroteV1, LEAD), false);
  });

  it("is closed outside approval", () => {
    for (const state of ["DRAFT", "VALIDATED", "APPROVED", "SCHEDULED", "ACTIVE"]) {
      assert.equal(sendsBack(pass({ state }), FINANCE), false, state);
    }
  });
});

describe("signing", () => {
  it("is closed to the author of an earlier version too, and the sentence says which one they wrote", () => {
    const financeWroteV1 = pass({ versions: [{ version: 1, authorId: "finance-1" }, { version: 2, authorId: "marketing-1" }, { version: 3, authorId: "marketing-1" }] });
    const decision = decide(financeWroteV1, FINANCE);
    assert.equal(decision.kind, "author");
    assert.equal(decisionSentence(decision, "FINANCE"), "You wrote v1 of this change. Someone else has to approve it.");
    assert.equal(decisionSentence(decide(pass(), MARKETING), "MARKETING"), "You wrote v3. Someone else has to approve it.");
  });

  it("tells the commercial lead whose signature the version needs", () => {
    assert.equal(decisionSentence(decide(pass(), LEAD), "COMMERCIAL_LEAD"), "As Commercial lead you can't sign this one: it needs Finance (conditions 2 and 4).");
  });
});
