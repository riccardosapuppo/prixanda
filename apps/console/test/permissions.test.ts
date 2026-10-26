// The team's table (src/lib/permissions.ts) against what it must say, and
// what the approval page offers by the engine's rules.
//
// The rows are §12.1 of docs/business.md word for word; the rights are the
// gateway's matrix (services/gateway/src/core/roles.ts); the audit log's rule
// is §11.4 and what every role reads is §12.2. If the book, the matrix or the
// table changes, one of these fails until the others are read again.
//
// Signing needs the signature the version asks for; sending back does not:
// both roles that review may send a version back to its author, even one
// that asks for the other's signature (services/commerce, engine/changes.py:
// approve and reject). Neither is open to whoever wrote any version.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FIELD_ROLES, METHOD_ROLES } from "../../../services/gateway/src/core/roles.ts";
import {
  type ApprovalView, approvesWithoutScheduling, decide, decisionSentence, everyoneReadsWords, inTeamOrder, logRule, otherwiseSigner, type Right, type Role,
  ROLES, sendsBack, type Signature, TEAM, waitingFor, whoDoes,
} from "../src/lib/permissions.ts";

const BOOK = join(import.meta.dirname, "..", "..", "..", "docs", "business.md");

/** The paragraph of the book that starts with a section's mark, its lines joined, without the mark. */
function paragraph(book: string, mark: string): string {
  const start = book.indexOf(`\n${mark} `) + 1;
  assert.ok(start > 0, `the book has no ${mark}`);
  const end = book.indexOf("\n\n", start);
  return book.slice(start + mark.length + 1, end === -1 ? undefined : end).split("\n").join(" ");
}

describe("the team's table", () => {
  it("writes every role as §12.1 does, word for word", async () => {
    const book = await readFile(BOOK, "utf8");
    for (const role of ROLES) {
      const row = TEAM.roles[role];
      const line = `| ${row.name} | ${row.can} | ${row.cannot} |`;
      assert.ok(book.includes(`\n${line}\n`), `§12.1 has no row ${line}`);
    }
  });

  it("lists the demo's people Marketing first, then in the order of the team's table (§12.1), as the book writes its rows", async () => {
    // As the engine lists them: by name.
    const people = [
      { id: "auditor-1", label: "Auditor", roles: ["AUDITOR"] },
      { id: "catalog-manager-1", label: "Catalog manager", roles: ["CATALOG_MANAGER"] },
      { id: "commercial-lead-1", label: "Commercial lead", roles: ["COMMERCIAL_LEAD"] },
      { id: "finance-1", label: "Finance", roles: ["FINANCE"] },
      { id: "marketing-2", label: "Marketing, second", roles: ["MARKETING"] },
      { id: "marketing-1", label: "Marketing", roles: ["MARKETING"] },
      { id: "on-call-1", label: "On-call engineer", roles: ["ON_CALL"] },
    ] as const;
    assert.deepEqual(inTeamOrder(people).map((person) => person.label), [
      "Marketing", "Marketing, second", "Commercial lead", "Finance", "Catalog manager", "On-call engineer", "Auditor",
    ]);
    const book = await readFile(BOOK, "utf8");
    const rows = ROLES.map((role) => book.indexOf(`\n| ${TEAM.roles[role].name} |`));
    assert.deepEqual([...rows].sort((a, b) => a - b), rows, "the roles in the order of §12.1's rows");
  });

  it("says §11.4 on the audit log, word for word, with the roles its rights give", async () => {
    const book = await readFile(BOOK, "utf8");
    assert.equal(logRule("Plancia"), paragraph(book, "§11.4"));
  });

  it("says what every role reads as §12.2 does", async () => {
    const book = await readFile(BOOK, "utf8");
    assert.ok(paragraph(book, "§12.2").startsWith(`Every role reads ${TEAM.everyoneReads}.`));
    assert.equal(everyoneReadsWords("AUDITOR"), "As Auditor you read what every role reads: the changes, the home and the audit log (§12.2).");
  });

  it("gives every right to the roles the gateway's matrix allows, by kind of change", () => {
    type Allowed = readonly string[];
    const offer = (allowed: { readonly offer: Allowed }) => allowed.offer;
    const gateway: Readonly<Record<Right, Allowed>> = {
      createOffer: offer(METHOD_ROLES.CreateChange),
      editOffer: offer(METHOD_ROLES.SaveVersion),
      submitOffer: offer(METHOD_ROLES.SubmitChange),
      createListPrice: METHOD_ROLES.CreateChange.listPrice,
      createPriceMigration: METHOD_ROLES.CreateChange.priceMigration,
      createPrepaidPass: METHOD_ROLES.CreateChange.prepaid,
      simulate: METHOD_ROLES.SimulateOffer,
      approve: METHOD_ROLES.ApproveChange,
      reject: METHOD_ROLES.RejectChange,
      scheduleOffer: offer(METHOD_ROLES.ScheduleChange),
      cancelOffer: offer(METHOD_ROLES.CancelChange),
      schedulePrice: METHOD_ROLES.ScheduleChange.priceMigration,
      cancelPrice: METHOD_ROLES.CancelChange.priceMigration,
      suspend: METHOD_ROLES.SuspendChange,
      retryLaunch: METHOD_ROLES.RetryLaunch,
      cancelLaunch: METHOD_ROLES.CancelLaunch,
      verifyChain: METHOD_ROLES.VerifyChain,
      exportHead: METHOD_ROLES.ExportHead,
      readRevenue: FIELD_ROLES["Overview.monthlyRevenue"],
      readUnearnedValue: FIELD_ROLES["Overview.prepaid"],
      readArtists: METHOD_ROLES.ListArtists,
    };
    for (const [right, roles] of Object.entries(TEAM.rights) as [Right, readonly Role[]][]) {
      assert.deepEqual([...roles].map((role) => role.toLowerCase()).sort(), [...gateway[right]].sort(), right);
    }
    // Checking a campaign is part of editing it.
    assert.deepEqual([...offer(METHOD_ROLES.ValidateChange)], TEAM.rights.editOffer.map((role) => role.toLowerCase()));
    // Who creates a price migration or a pass also saves, checks and submits it.
    for (const kind of ["priceMigration", "prepaid"] as const) {
      const creates = [...METHOD_ROLES.CreateChange[kind]].sort();
      for (const method of ["SaveVersion", "ValidateChange", "SubmitChange"] as const) assert.deepEqual([...METHOD_ROLES[method][kind]].sort(), creates, `${method} ${kind}`);
    }
    // A price is a price: a list price, a migration and a pass are scheduled and cancelled by the same roles.
    for (const kind of ["listPrice", "prepaid"] as const) {
      assert.deepEqual([...METHOD_ROLES.ScheduleChange[kind]].sort(), [...METHOD_ROLES.ScheduleChange.priceMigration].sort(), `schedule ${kind}`);
      assert.deepEqual([...METHOD_ROLES.CancelChange[kind]].sort(), [...METHOD_ROLES.CancelChange.priceMigration].sort(), `cancel ${kind}`);
    }
    // A migration's simulation is open to those who simulate a campaign, and the unearned value to finance in both fields.
    assert.deepEqual([...METHOD_ROLES.SimulateMigration].sort(), [...METHOD_ROLES.SimulateOffer].sort());
    assert.deepEqual([...FIELD_ROLES["Overview.prepaidUnearnedEur"]], [...FIELD_ROLES["Overview.prepaid"]]);
  });

  it("composes the sentences from the rights, the verb agreeing with the roles", () => {
    assert.equal(whoDoes("readRevenue", { one: "reads revenue", many: "read revenue" }), "Finance and the commercial lead read revenue");
    assert.equal(whoDoes("readUnearnedValue", { one: "reads it", many: "read it" }), "Finance reads it");
    assert.equal(whoDoes("scheduleOffer", { one: "schedules it", many: "schedule it" }, { start: false, either: true }), "Marketing or the commercial lead schedules it");
    assert.equal(whoDoes("verifyChain", { one: "verifies the chain", many: "verify the chain" }), "The auditor and the on-call engineer verify the chain");
    assert.equal(approvesWithoutScheduling(), "Finance approves but does not schedule");
    assert.equal(approvesWithoutScheduling({ schedules: "schedulePrice" }), "Finance approves but does not schedule");
    assert.equal(whoDoes("schedulePrice", { one: "schedules it", many: "schedule it" }, { start: false }), "the commercial lead schedules it");
    assert.equal(whoDoes("cancelPrice", { one: "cancels it", many: "cancel it" }, { either: true }), "The commercial lead or the on-call engineer cancels it");
    assert.equal(whoDoes("createPriceMigration", { one: "writes price migrations", many: "write price migrations" }), "The commercial lead writes price migrations");
    assert.equal(otherwiseSigner(), "the commercial lead or Finance");
    assert.equal(waitingFor([{ role: "COMMERCIAL_LEAD", conditions: [], why: "", signed: false }]), "Waiting for the commercial lead or Finance");
  });
});

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
