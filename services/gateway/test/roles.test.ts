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
import { LaunchService } from "contracts/commerce/v1/launches";
import { OverviewService, PeopleService } from "contracts/commerce/v1/overview";
import { QuoteService } from "contracts/commerce/v1/quotes";
import { SimulationService } from "contracts/commerce/v1/simulation";
import { SubscriberService } from "contracts/commerce/v1/subscriptions";
import { SERVICES } from "../src/core/engine.ts";
import { anyKind, FIELD_ROLES, isByKind, KINDS, METHOD_ROLES, PUBLIC_METHODS, ROLES, SUBSCRIBER_METHODS } from "../src/core/roles.ts";
import { type Harness, startHarness } from "./support/harness.ts";

const BOOK = join(import.meta.dirname, "..", "..", "..", "docs", "business.md");

/**
 * §12.1, as docs/business.md writes it since stage 6 of the engine: the
 * commercial lead reads revenue, and the on-call engineer retries or cancels
 * a launch that stopped.
 */
const SECTION_12 = [
  "| Marketing | create and edit campaigns, run simulations, submit | approve |",
  "| Commercial lead | own the price list and commercial rules, create price changes, approve campaigns within the thresholds, read revenue | approve own versions; sign for finance |",
  "| Finance | approve price changes and anything over a finance condition (§7.3); read revenue and unearned value | approve own versions |",
  "| Catalog manager | define plans and entitlements | approve own versions; change prices |",
  "| On-call engineer | suspend an active change; retry or cancel a launch that stopped (roll back a launch) | create or approve anything |",
  "| Auditor | read and export the audit log | change anything |",
];

/** §11.4 and §12.2, as docs/business.md writes them since the same commit, each paragraph on one line. */
const SECTION_11_4 = "§11.4 Everyone on the team reads the log, so any decision can be traced from any seat; the auditor exports it, "
  + "and the auditor and the on-call engineer verify the chain. Nobody can change it through Plancia.";
const SECTION_12_2 = "§12.2 Every role reads the changes, the home and the audit log. Revenue is read by finance and the commercial lead, "
  + "unearned pass value by finance (§9.2); the console tells the other roles who can read them, and the engine leaves those figures "
  + "out of its answers to them.";

/** The paragraph of the book that starts with a section's mark, its lines joined. */
function paragraph(book: string, mark: string): string {
  const start = book.indexOf(`\n${mark} `) + 1;
  assert.ok(start > 0, `the book has no ${mark}`);
  const end = book.indexOf("\n\n", start);
  return book.slice(start, end === -1 ? undefined : end).split("\n").join(" ");
}

const ALL = ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"];

type PerKind = { offer: string[]; listPrice: string[]; priceMigration: string[] };

/**
 * The coordinator's table, method by method; for the methods that depend on
 * the kind of change, offers, list prices and price migrations apart. Stage 7
 * (BRIEF-TAPPA-7.md, behaviour 1): only the commercial lead writes and
 * schedules a migration, and the commercial lead or the on-call engineer
 * cancels it.
 */
const TABLE: Record<string, string[] | PerKind> = {
  CreateChange: { offer: ["marketing"], listPrice: ["commercial_lead"], priceMigration: ["commercial_lead"] },
  SaveVersion: { offer: ["marketing"], listPrice: ["commercial_lead"], priceMigration: ["commercial_lead"] },
  ValidateChange: { offer: ["marketing"], listPrice: ["commercial_lead"], priceMigration: ["commercial_lead"] },
  SubmitChange: { offer: ["marketing"], listPrice: ["commercial_lead"], priceMigration: ["commercial_lead"] },
  SimulateOffer: ["marketing", "commercial_lead", "finance"],
  SimulateMigration: ["marketing", "commercial_lead", "finance"],
  ApproveChange: ["commercial_lead", "finance"],
  RejectChange: ["commercial_lead", "finance"],
  ScheduleChange: { offer: ["marketing", "commercial_lead"], listPrice: ["commercial_lead"], priceMigration: ["commercial_lead"] },
  CancelChange: {
    offer: ["marketing", "commercial_lead", "on_call"], listPrice: ["commercial_lead", "on_call"], priceMigration: ["commercial_lead", "on_call"],
  },
  SuspendChange: ["on_call"],
  GetChange: ALL,
  BatchGetChanges: ALL,
  ListChanges: ALL,
  GetOverview: ALL,
  ListEvents: ALL,
  VerifyChain: ["auditor", "on_call"],
  ExportHead: ["auditor"],
  // Stage 6 (launches.proto): every role reads the launches, only on_call retries or cancels one.
  ListLaunches: ALL,
  GetLaunch: ALL,
  RetryLaunch: ["on_call"],
  CancelLaunch: ["on_call"],
};

const sorted = (roles: readonly string[]) => [...roles].sort();
const matrix = METHOD_ROLES as Record<string, readonly string[] | Readonly<Record<string, readonly string[]>>>;
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
        const byKind = actual as Readonly<Record<string, readonly string[]>>;
        assert.deepEqual(Object.keys(byKind).sort(), [...KINDS].sort(), `${method} names every kind of change`);
        assert.deepEqual(Object.keys(expected).sort(), [...KINDS].sort(), `the table names every kind of change for ${method}`);
        for (const kind of KINDS) assert.deepEqual(sorted(byKind[kind] ?? []), sorted(expected[kind]), `${method} for ${kind}`);
      }
    }
  });

  test("keeps the cannots of §12", () => {
    assert.ok(!may("ApproveChange", "marketing"), "marketing cannot approve");
    for (const kind of ["listPrice", "priceMigration"] as const) {
      assert.ok(!(METHOD_ROLES.CreateChange[kind] as readonly string[]).includes("catalog_manager"), `the catalog manager cannot change prices (${kind})`);
    }
    for (const method of ["CreateChange", "SaveVersion", "ApproveChange", "RejectChange"]) {
      assert.ok(!may(method, "on_call"), `the on-call engineer cannot ${method}`);
    }
    const auditorMay = Object.keys(matrix).filter((method) => may(method, "auditor")).sort();
    assert.deepEqual(auditorMay, [
      "BatchGetChanges", "ExportHead", "GetChange", "GetLaunch", "GetOverview", "ListChanges", "ListEvents", "ListLaunches", "VerifyChain",
    ], "the auditor reads and exports, and changes nothing");
    assert.ok(may("ApproveChange", "finance") && may("ApproveChange", "commercial_lead"));
    assert.ok(!may("ScheduleChange", "finance"), "finance approves but does not schedule");
    // "Retry or cancel a launch that stopped": the on-call engineer's, and nobody else's.
    for (const method of ["RetryLaunch", "CancelLaunch"]) {
      assert.deepEqual(ALL.filter((role) => may(method, role)), ["on_call"], method);
    }
  });

  test("lets finance and the commercial lead, and nobody else, read revenue", () => {
    for (const [field, roles] of Object.entries(FIELD_ROLES)) assert.deepEqual(sorted(roles), ["commercial_lead", "finance"], field);
    assert.deepEqual(Object.keys(FIELD_ROLES).sort(), ["Overview.monthlyRevenue", "Overview.monthlyRevenueEur", "Overview.monthlyTopUps"]);
  });

  test("§11.4 and §12.2 quoted here are the book's, and the matrix does what they say", async () => {
    const book = (await readFile(BOOK, "utf8")).replaceAll("\r\n", "\n");
    assert.equal(paragraph(book, "§11.4"), SECTION_11_4);
    assert.equal(paragraph(book, "§12.2"), SECTION_12_2);
    // "Every role reads the changes, the home and the audit log."
    for (const method of ["GetChange", "BatchGetChanges", "ListChanges", "GetOverview", "ListEvents"]) {
      assert.deepEqual(sorted(anyKind(matrix[method] as never)), sorted(ALL), method);
    }
    // "The auditor exports it, and the auditor and the on-call engineer verify the chain."
    assert.deepEqual(sorted(METHOD_ROLES.ExportHead), ["auditor"]);
    assert.deepEqual(sorted(METHOD_ROLES.VerifyChain), ["auditor", "on_call"]);
    // "Revenue is read by finance and the commercial lead": the fields the
    // gateway narrows (FIELD_ROLES) are the revenue of the home, read by those
    // two and nobody else. Unearned pass value has no field before stage 7.
    const revenue = Object.keys(FIELD_ROLES).filter((field) => /revenue|topups/i.test(field));
    assert.deepEqual(revenue.sort(), Object.keys(FIELD_ROLES).sort(), "every narrowed field is revenue");
    for (const field of revenue) assert.deepEqual(sorted(FIELD_ROLES[field as keyof typeof FIELD_ROLES]), ["commercial_lead", "finance"], field);
  });

  test("asks for the home in a role that reads its narrower fields first, when the person holds one", () => {
    const readers = [...new Set(Object.values(FIELD_ROLES).flat())];
    assert.deepEqual(sorted(METHOD_ROLES.GetOverview.slice(0, readers.length)), sorted(readers));
  });

  test("covers every method of the contract: public, the subscriber's, or in the matrix, exactly one of them", () => {
    const services = [CatalogService, ChangeService, QuoteService, SimulationService, AuditService, OverviewService, PeopleService, SubscriberService, LaunchService];
    const contract = services.flatMap((service) => service.methods.map((method) => method.name));
    // Catalog 5, Change 12, Quote 1, Simulation 2, Audit 3, Overview 1, People 1, Subscriber 7, Launch 4.
    assert.equal(contract.length, 36, "the contract's methods were all read");
    // The gateway binds a client to every service of the contract, and engineCalls() refuses a method no list names.
    assert.deepEqual((Object.values(SERVICES) as unknown[]).length, services.length);
    for (const service of services) assert.ok((Object.values(SERVICES) as unknown[]).includes(service), service.typeName);
    assert.deepEqual([...PUBLIC_METHODS].sort(), [
      "GetPriceList", "GetQuote", "ListDemoListeners", "ListMarkets", "ListOffers", "ListPeople", "ListPlans", "ListPrepaidPasses",
    ]);
    // The brief of stage 5: these act for the listener of the site's session, with no x-actor.
    assert.deepEqual([...SUBSCRIBER_METHODS].sort(), [
      "ActivatePrepaidPass", "AnswerPriceChange", "BuyPrepaidPass", "ConfirmQuote", "GetAccount", "VerifyStudent",
    ]);
    for (const method of contract) {
      const kinds = [(PUBLIC_METHODS as readonly string[]).includes(method), (SUBSCRIBER_METHODS as readonly string[]).includes(method), Object.hasOwn(matrix, method)];
      assert.equal(kinds.filter(Boolean).length, 1, `${method} must be public, the subscriber's, or in the matrix, and only one of them`);
    }
    const listed = [...PUBLIC_METHODS, ...SUBSCRIBER_METHODS, ...Object.keys(matrix)];
    assert.deepEqual(listed.filter((method) => !contract.includes(method)), [], "the lists name no method the contract lacks");
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
