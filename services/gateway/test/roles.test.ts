// The role matrix (src/core/roles.ts) against what it must say: the rows of
// the business book's §12, quoted below and checked against the book itself,
// and the table the coordinator fixed for the engine and the gateway
// (BRIEF-TAPPE-2-3.md, §4), transcribed below on its own. If the book or the
// matrix changes, one of these fails until the other is read again.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AuditService } from "contracts/commerce/v1/audit";
import { CatalogService } from "contracts/commerce/v1/catalog";
import { ChangeService, ChangeState } from "contracts/commerce/v1/changes";
import { OverviewService, PeopleService } from "contracts/commerce/v1/overview";
import { QuoteService } from "contracts/commerce/v1/quotes";
import { SimulationService } from "contracts/commerce/v1/simulation";
import { anyKind, FIELD_ROLES, isByKind, METHOD_ROLES, PUBLIC_METHODS, ROLES } from "../src/core/roles.ts";
import { type Harness, startHarness } from "./support/harness.ts";

const BOOK = join(import.meta.dirname, "..", "..", "..", "docs", "business.md");

/** §12.1, as docs/business.md writes it on 24 October 2026. */
const SECTION_12 = [
  "| Marketing | create and edit campaigns, run simulations, submit | approve |",
  "| Commercial lead | own the price list and commercial rules, create price changes, approve campaigns within the thresholds | approve own versions; sign for finance |",
  "| Finance | approve price changes and anything over a finance condition (§7.3); read revenue and unearned value | approve own versions |",
  "| Catalog manager | define plans and entitlements | approve own versions; change prices |",
  "| On-call engineer | suspend an active change and roll back a launch | create or approve anything |",
  "| Auditor | read and export the audit log | change anything |",
];

const ALL = ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"];

/** The coordinator's table, method by method; for the methods that depend on the kind of change, offers and list prices apart. */
const TABLE: Record<string, string[] | { offer: string[]; listPrice: string[] }> = {
  CreateChange: { offer: ["marketing"], listPrice: ["commercial_lead"] },
  SaveVersion: { offer: ["marketing"], listPrice: ["commercial_lead"] },
  ValidateChange: { offer: ["marketing"], listPrice: ["commercial_lead"] },
  SubmitChange: { offer: ["marketing"], listPrice: ["commercial_lead"] },
  SimulateOffer: ["marketing", "commercial_lead", "finance"],
  ApproveChange: ["commercial_lead", "finance"],
  RejectChange: ["commercial_lead", "finance"],
  ScheduleChange: { offer: ["marketing", "commercial_lead"], listPrice: ["commercial_lead"] },
  CancelChange: { offer: ["marketing", "commercial_lead", "on_call"], listPrice: ["commercial_lead", "on_call"] },
  SuspendChange: ["on_call"],
  GetChange: ALL,
  BatchGetChanges: ALL,
  ListChanges: ALL,
  GetOverview: ALL,
  ListEvents: ALL,
  VerifyChain: ["auditor", "on_call"],
  ExportHead: ["auditor"],
};

const sorted = (roles: readonly string[]) => [...roles].sort();
const matrix = METHOD_ROLES as Record<string, readonly string[] | { offer: readonly string[]; listPrice: readonly string[] }>;
const may = (method: string, role: string) => {
  const allowed = matrix[method];
  return allowed !== undefined && anyKind(allowed as never).includes(role as never);
};

describe("the role matrix", () => {
  test("the §12 rows quoted here are the book's, all six of them", async () => {
    const book = (await readFile(BOOK, "utf8")).replaceAll("\r\n", "\n");
    const section = book.slice(book.indexOf("§12.1"), book.indexOf("## 13."));
    const rows = section.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Role") && !line.startsWith("|---"));
    assert.deepEqual(rows, SECTION_12);
  });

  test("names the six roles of the book, as the database writes them", () => {
    assert.deepEqual([...ROLES], ALL);
  });

  test("says, method by method, what the coordinator's table says", () => {
    assert.deepEqual(Object.keys(matrix).sort(), Object.keys(TABLE).sort());
    for (const [method, expected] of Object.entries(TABLE)) {
      const actual = matrix[method];
      if (Array.isArray(expected)) {
        assert.ok(actual !== undefined && !isByKind(actual as never), `${method} should not depend on the kind`);
        assert.deepEqual(sorted(actual as readonly string[]), sorted(expected), method);
      } else {
        assert.ok(actual !== undefined && isByKind(actual as never), `${method} should depend on the kind`);
        const byKind = actual as { offer: readonly string[]; listPrice: readonly string[] };
        assert.deepEqual(sorted(byKind.offer), sorted(expected.offer), `${method} for offers`);
        assert.deepEqual(sorted(byKind.listPrice), sorted(expected.listPrice), `${method} for list prices`);
      }
    }
  });

  test("keeps the cannots of §12", () => {
    assert.ok(!may("ApproveChange", "marketing"), "marketing cannot approve");
    assert.ok(!(METHOD_ROLES.CreateChange.listPrice as readonly string[]).includes("catalog_manager"), "the catalog manager cannot change prices");
    for (const method of ["CreateChange", "SaveVersion", "ApproveChange", "RejectChange"]) {
      assert.ok(!may(method, "on_call"), `the on-call engineer cannot ${method}`);
    }
    const auditorMay = Object.keys(matrix).filter((method) => may(method, "auditor")).sort();
    assert.deepEqual(auditorMay, ["BatchGetChanges", "ExportHead", "GetChange", "GetOverview", "ListChanges", "ListEvents", "VerifyChain"],
      "the auditor reads and exports, and changes nothing");
    assert.ok(may("ApproveChange", "finance") && may("ApproveChange", "commercial_lead"));
    assert.ok(!may("ScheduleChange", "finance"), "finance approves but does not schedule");
  });

  test("lets finance and the commercial lead, and nobody else, read revenue", () => {
    for (const [field, roles] of Object.entries(FIELD_ROLES)) assert.deepEqual(sorted(roles), ["commercial_lead", "finance"], field);
    assert.deepEqual(Object.keys(FIELD_ROLES).sort(), ["Overview.monthlyRevenue", "Overview.monthlyRevenueEur", "Overview.monthlyTopUps"]);
  });

  test("asks for the home in a role that reads its narrower fields first, when the person holds one", () => {
    const readers = [...new Set(Object.values(FIELD_ROLES).flat())];
    assert.deepEqual(sorted(METHOD_ROLES.GetOverview.slice(0, readers.length)), sorted(readers));
  });

  test("covers every method of the contract: public or in the matrix, never both", () => {
    const contract = [CatalogService, ChangeService, QuoteService, SimulationService, AuditService, OverviewService, PeopleService]
      .flatMap((service) => service.methods.map((method) => method.name));
    // Catalog 4, Change 12, Quote 1, Simulation 1, Audit 3, Overview 1, People 1.
    assert.equal(contract.length, 23, "the contract's methods were all read");
    assert.deepEqual([...PUBLIC_METHODS].sort(), ["GetPriceList", "GetQuote", "ListMarkets", "ListOffers", "ListPeople", "ListPlans"]);
    for (const method of contract) {
      const isPublic = (PUBLIC_METHODS as readonly string[]).includes(method);
      assert.notEqual(isPublic, Object.hasOwn(matrix, method), `${method} must be either public or in the matrix`);
    }
    assert.deepEqual(Object.keys(matrix).filter((method) => !contract.includes(method)), [], "the matrix names no method the contract lacks");
  });
});

describe("a person holding two roles acts in the one the operation needs", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness({
      engine: {
        extraPeople: {
          "lead-and-finance-1": { label: "Commercial lead and finance", roles: ["commercial_lead", "finance"] },
          "marketing-and-lead-1": { label: "Marketing and commercial lead", roles: ["marketing", "commercial_lead"] },
          "marketing-and-finance-1": { label: "Marketing and finance", roles: ["marketing", "finance"] },
        },
      },
    });
  });
  after(async () => {
    await harness.close();
  });

  test("signing: finance first", async () => {
    const change = harness.engine.seedOffer("Two hats", "marketing-1", ChangeState.IN_APPROVAL);
    const person = harness.console();
    await person.signIn("lead-and-finance-1");
    const hash = Buffer.from(change.versions[0]?.hash ?? []).toString("hex");
    const answer = await person.graphql(`mutation { approveChange(changeId: "${change.id}", version: 1, fingerprint: "${hash}") { __typename ... on Change { state approvals { role } } } }`);
    assert.deepEqual(answer.body.data.approveChange, { __typename: "Change", state: "APPROVED", approvals: [{ role: "FINANCE" }] }, answer.text);
    assert.equal(harness.engine.calls.filter((call) => call.method === "ApproveChange").at(-1)?.role, "finance");
  });

  test("validating: the role of the change's kind, read from the change itself", async () => {
    const person = harness.console();
    await person.signIn("marketing-and-lead-1");
    const offer = harness.engine.seedOffer("Their offer", "marketing-and-lead-1", ChangeState.DRAFT);
    harness.engine.clearCalls();
    const answer = await person.graphql(`mutation { validateChange(changeId: "${offer.id}", version: 1) { __typename ... on Change { state } } }`);
    assert.equal(answer.body.data.validateChange.state, "VALIDATED", answer.text);
    assert.equal(harness.engine.calls.find((call) => call.method === "ValidateChange")?.role, "marketing");
    assert.equal(harness.engine.count("BatchGetChanges"), 1, "the kind was read through the loader, once");
  });

  test("the home: a person who may read revenue reads it, whichever other role they hold", async () => {
    // The engine fills the revenue only for finance and the commercial lead:
    // the overview must be asked in the role that reads it, or it comes back
    // empty while the gateway's field check lets it through.
    const query = "{ overview { monthlyRevenue { market revenue } monthlyRevenueEur monthlyTopUps exchangeRateNote } }";
    for (const person of ["marketing-and-finance-1", "marketing-and-lead-1"]) {
      const client = harness.console();
      await client.signIn(person);
      harness.engine.clearCalls();
      const answer = await client.graphql(query);
      assert.equal(answer.body.errors, undefined, `${person}: ${answer.text}`);
      assert.deepEqual(answer.body.data.overview.monthlyRevenueEur, { amountMinor: "15234000", currency: "EUR" }, person);
      assert.deepEqual(answer.body.data.overview.monthlyTopUps, { amountMinor: "187200", currency: "EUR" }, person);
      assert.equal(answer.body.data.overview.monthlyRevenue.length, 1, person);
      assert.notEqual(harness.engine.calls.find((call) => call.method === "GetOverview")?.role, "marketing", person);
    }
    const marketing = harness.console();
    await marketing.signIn("marketing-1");
    const refused = await marketing.graphql(query);
    assert.deepEqual(refused.body.errors.map((error: { extensions: { code: string } }) => error.extensions.code), ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
    assert.equal(refused.body.data.overview.exchangeRateNote, "1 EUR = 0.83728 GBP (ECB reference rate, 23 October 2026)");
  });

  test("a person with one role needs no lookup", async () => {
    const person = harness.console();
    await person.signIn("marketing-1");
    const offer = harness.engine.seedOffer("Plain", "marketing-1", ChangeState.DRAFT);
    harness.engine.clearCalls();
    await person.graphql(`mutation { validateChange(changeId: "${offer.id}", version: 1) { __typename } }`);
    assert.equal(harness.engine.count("BatchGetChanges") + harness.engine.count("GetChange"), 0);
    assert.equal(harness.engine.count("ValidateChange"), 1);
  });
});
