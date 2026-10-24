// The console's resolvers end to end: GraphQL over HTTP, the gateway, gRPC,
// the fake engine and back, on the flows of the business book.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Code } from "@connectrpc/connect";
import { ChangeState } from "contracts/commerce/v1/changes";
import { codes, type Harness, startHarness } from "./support/harness.ts";

const OFFER = {
  title: "Student Autumn Pass",
  plan: "student",
  audience: { segment: "NEVER_PAID", needsStudentCheck: true },
  prices: [{ market: "IT", fixed: { amountMinor: "299", currency: "EUR" } }],
  monthsAtOfferPrice: 3,
  periods: [{ market: "IT", startsLocal: "2026-11-02T09:00", endsLocal: "2026-11-30T23:59" }],
  nonCombinabilityGroup: "student",
  pages: [{ market: "IT", title: "Student Autumn Pass", text: "Three months at a student price.", terms: "New subscribers only." }],
};

const CHANGE_FIELDS = `id state currentVersion title sentence createdBy { id }
  current { version fingerprint author { id } content { __typename ... on OfferContent { plan prices { market fixed percentOffBasisPoints } } } }
  requiredSignatures { role signed why } approvals { approver { id } role fingerprint }`;

const RESULT = `__typename ... on Change { ${CHANGE_FIELDS} } ... on Refusal { code reason facts { name value } change { id currentVersion state validation { valid findings { check severity market } } } }`;

let harness: Harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness.close();
});

describe("the Student Autumn Pass, from draft to scheduled (§14.1)", () => {
  test("marketing creates and moves it on, its author cannot approve it, finance does, and marketing schedules it", async () => {
    const marketing = harness.console();
    await marketing.signIn("marketing-1");
    const created = await marketing.graphql(`mutation ($offer: OfferInput!) { createOffer(offer: $offer) { ${RESULT} } }`, { variables: { offer: OFFER } });
    assert.equal(created.status, 200, created.text);
    const change = created.body.data.createOffer;
    assert.equal(change.__typename, "Change");
    assert.equal(change.state, "DRAFT");
    assert.equal(change.createdBy.id, "marketing-1");
    assert.deepEqual(change.current.content.prices, [{ market: "IT", fixed: { amountMinor: "299", currency: "EUR" }, percentOffBasisPoints: null }]);
    assert.match(change.current.fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(change.requiredSignatures.map((signature: { role: string }) => signature.role), ["FINANCE"]);

    const validated = await marketing.graphql(`mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { ${RESULT} } }`, { variables: { id: change.id } });
    assert.equal(validated.body.data.validateChange.state, "VALIDATED", validated.text);
    const submitted = await marketing.graphql(`mutation ($id: ID!) { submitChange(changeId: $id, version: 1) { ${RESULT} } }`, { variables: { id: change.id } });
    assert.equal(submitted.body.data.submitChange.state, "IN_APPROVAL", submitted.text);

    // The engine refuses the author's own signature: an answer, typed, not an error.
    const own = await marketing.graphql(`mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { ${RESULT} } }`, {
      variables: { id: change.id, fp: change.current.fingerprint },
    });
    assert.equal(own.status, 200);
    assert.equal(own.body.errors, undefined);
    assert.equal(own.body.data.approveChange.__typename, "Refusal");
    assert.equal(own.body.data.approveChange.code, "ROLE_NOT_ALLOWED", "marketing may not approve at all: the gateway refuses before the engine");

    const lead = harness.console();
    await lead.signIn("commercial-lead-1");
    const needsFinance = await lead.graphql(`mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { ${RESULT} } }`, {
      variables: { id: change.id, fp: change.current.fingerprint },
    });
    assert.equal(needsFinance.body.data.approveChange.code, "ROLE_NOT_ALLOWED", "below the floor, the commercial lead cannot sign for finance");

    const finance = harness.console();
    await finance.signIn("finance-1");
    const approved = await finance.graphql(`mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { ${RESULT} } }`, {
      variables: { id: change.id, fp: change.current.fingerprint.toUpperCase() },
    });
    const signed = approved.body.data.approveChange;
    assert.equal(signed.state, "APPROVED", approved.text);
    assert.deepEqual(signed.approvals, [{ approver: { id: "finance-1" }, role: "FINANCE", fingerprint: change.current.fingerprint }]);

    const notFinance = await finance.graphql(`mutation ($id: ID!) { scheduleChange(changeId: $id) { ${RESULT} } }`, { variables: { id: change.id } });
    assert.equal(notFinance.body.data.scheduleChange.code, "ROLE_NOT_ALLOWED", "finance approves but does not schedule");
    const scheduled = await marketing.graphql(`mutation ($id: ID!) { scheduleChange(changeId: $id) { ${RESULT} } }`, { variables: { id: change.id } });
    assert.equal(scheduled.body.data.scheduleChange.state, "SCHEDULED", scheduled.text);
  });

  test("the author signing their own version is refused by the engine as OWN_VERSION", async () => {
    // A commercial lead who wrote a price change and tries to approve it: allowed to approve, refused as the author.
    const lead = harness.console();
    await lead.signIn("commercial-lead-1");
    const created = await lead.graphql(`mutation { createListPrice(listPrice: { title: "Family up", plan: "family", market: "DE", amount: { amountMinor: "2099", currency: "EUR" }, startsLocal: "2027-01-01T00:00" }) { ${RESULT} } }`);
    const id = created.body.data.createListPrice.id;
    await lead.graphql(`mutation { validateChange(changeId: "${id}", version: 1) { __typename } }`);
    await lead.graphql(`mutation { submitChange(changeId: "${id}", version: 1) { __typename } }`);
    const fingerprint = created.body.data.createListPrice.current.fingerprint;
    const own = await lead.graphql(`mutation { approveChange(changeId: "${id}", version: 1, fingerprint: "${fingerprint}") { ${RESULT} } }`);
    assert.equal(own.body.data.approveChange.__typename, "Refusal", own.text);
    assert.equal(own.body.data.approveChange.code, "OWN_VERSION");
    assert.deepEqual(own.body.data.approveChange.facts, [{ name: "author", value: "commercial-lead-1" }]);
  });
});

describe("refusals carry what the client needs", () => {
  test("saving over a newer version is STALE_VERSION, and the refusal carries the newer version (§6.3)", async () => {
    const first = harness.console();
    await first.signIn("marketing-1");
    const second = harness.console();
    await second.signIn("marketing-2");
    const id = harness.engine.seedOffer("Two editors", "marketing-1", ChangeState.DRAFT).id;
    const saved = await first.graphql(`mutation ($offer: OfferInput!) { saveOfferVersion(changeId: "${id}", baseVersion: 1, offer: $offer) { ${RESULT} } }`, { variables: { offer: OFFER } });
    assert.equal(saved.body.data.saveOfferVersion.currentVersion, 2, saved.text);
    const stale = await second.graphql(`mutation ($offer: OfferInput!) { saveOfferVersion(changeId: "${id}", baseVersion: 1, offer: $offer) { ${RESULT} } }`, { variables: { offer: OFFER } });
    const refusal = stale.body.data.saveOfferVersion;
    assert.equal(refusal.code, "STALE_VERSION");
    assert.deepEqual(refusal.facts, [{ name: "newer_version", value: "2" }]);
    assert.equal(refusal.change.currentVersion, 2, "the newer version comes with the refusal");
  });

  test("a validation with blocking problems is INVALID, and the saved report comes with it", async () => {
    const marketing = harness.console();
    await marketing.signIn("marketing-1");
    const id = harness.engine.seedOffer("No page", "marketing-1", ChangeState.DRAFT, { withPage: false }).id;
    const answer = await marketing.graphql(`mutation { validateChange(changeId: "${id}", version: 1) { ${RESULT} } }`);
    const refusal = answer.body.data.validateChange;
    assert.equal(refusal.code, "INVALID", answer.text);
    assert.deepEqual(refusal.facts, [{ name: "blocking", value: "1" }, { name: "checks", value: "page_text" }]);
    assert.deepEqual(refusal.change.validation, { valid: false, findings: [{ check: "page_text", severity: "BLOCKING", market: "IT" }] });
    assert.equal(refusal.change.state, "DRAFT");
  });

  test("an approval naming an older fingerprint is FINGERPRINT_MISMATCH (§7.2)", async () => {
    const id = harness.engine.seedOffer("Moved on", "marketing-1", ChangeState.IN_APPROVAL).id;
    const finance = harness.console();
    await finance.signIn("finance-1");
    const answer = await finance.graphql(`mutation { approveChange(changeId: "${id}", version: 1, fingerprint: "${"0".repeat(64)}") { ${RESULT} } }`);
    assert.equal(answer.body.data.approveChange.code, "FINGERPRINT_MISMATCH", answer.text);
  });

  test("a rejection without a reason is REASON_REQUIRED", async () => {
    const id = harness.engine.seedOffer("Rejected", "marketing-1", ChangeState.IN_APPROVAL).id;
    const finance = harness.console();
    await finance.signIn("finance-1");
    const answer = await finance.graphql(`mutation { rejectChange(changeId: "${id}", version: 1, reason: " ") { ${RESULT} } }`);
    assert.equal(answer.body.data.rejectChange.code, "REASON_REQUIRED", answer.text);
  });
});

describe("reads", () => {
  test("a change by id, with its people loaded once", async () => {
    const id = harness.engine.seedOffer("Read me", "marketing-2", ChangeState.DRAFT).id;
    const reader = harness.console();
    await reader.signIn("auditor-1");
    harness.engine.clearCalls();
    const answer = await reader.graphql(`{ change(id: "${id}") { title createdBy { id label roles } current { author { id } } } }`);
    assert.deepEqual(answer.body.data.change, { title: "Read me", createdBy: { id: "marketing-2", label: "Marketing, second", roles: ["MARKETING"] }, current: { author: { id: "marketing-2" } } });
    assert.equal(harness.engine.count("ListPeople"), 1);
  });

  test("an unknown change is NOT_FOUND; a malformed id is BAD_USER_INPUT and never reaches the engine", async () => {
    const reader = harness.console();
    await reader.signIn("auditor-1");
    const unknown = await reader.graphql(`{ change(id: "99999") { id } }`);
    assert.deepEqual(codes(unknown), ["NOT_FOUND"]);
    assert.equal(unknown.body.data.change, null);
    harness.engine.clearCalls();
    const malformed = await reader.graphql(`{ change(id: "12; drop") { id } }`);
    assert.deepEqual(codes(malformed), ["BAD_USER_INPUT"]);
    assert.equal(harness.engine.count("BatchGetChanges") + harness.engine.count("GetChange"), 0);
  });

  test("markets, plans and the price list keep money as integers of minor units", async () => {
    const reader = harness.console();
    await reader.signIn("marketing-1");
    const answer = await reader.graphql(`{ markets { code floor artistsMinimum vatBasisPoints } plans(market: "IT") { code listPrice breakdown { price companyKeeps } entitlements { skipsPerHour audio } } priceList(market: "IT", plan: "student") { amount belowFloor change { id } } }`);
    assert.equal(answer.body.errors, undefined, answer.text);
    assert.deepEqual(answer.body.data.markets[0], { code: "IT", floor: { amountMinor: "610", currency: "EUR" }, artistsMinimum: { amountMinor: "300", currency: "EUR" }, vatBasisPoints: 2200 });
    const free = answer.body.data.plans.find((plan: { code: string }) => plan.code === "free");
    assert.deepEqual(free, { code: "free", listPrice: null, breakdown: null, entitlements: { skipsPerHour: 6, audio: "STANDARD" } });
    const student = answer.body.data.plans.find((plan: { code: string }) => plan.code === "student");
    assert.deepEqual(student.listPrice, { amountMinor: "579", currency: "EUR" });
    assert.equal(student.entitlements.skipsPerHour, null, "0 from the engine means unlimited, which the schema writes as null");
    assert.deepEqual(answer.body.data.priceList, [{ amount: { amountMinor: "579", currency: "EUR" }, belowFloor: true, change: null }]);
  });

  test("the simulation keeps negative amounts and turns the engine's -1 into null", async () => {
    const id = harness.engine.seedOffer("Simulated", "marketing-1", ChangeState.DRAFT).id;
    const marketing = harness.console();
    await marketing.signIn("marketing-1");
    const query = `query ($o: [AssumptionInput!]) { simulateOffer(changeId: "${id}", version: 1, market: "IT", overrides: $o) {
      __typename ... on Simulation { difference { contribution } breakEvenRetentionBasisPoints assumptions { name value source } } } }`;
    const plain = await marketing.graphql(query);
    assert.deepEqual(plain.body.data.simulateOffer.difference, { contribution: { amountMinor: "-187751", currency: "EUR" } }, plain.text);
    assert.equal(plain.body.data.simulateOffer.breakEvenRetentionBasisPoints, 7300);
    const overridden = await marketing.graphql(query, { variables: { o: [{ name: "RETENTION", value: 2000 }] } });
    assert.equal(overridden.body.data.simulateOffer.breakEvenRetentionBasisPoints, null, overridden.text);
    assert.deepEqual(overridden.body.data.simulateOffer.assumptions.find((a: { name: string }) => a.name === "RETENTION"), { name: "RETENTION", value: 2000, source: "typed by finance" });
    const call = harness.engine.calls.filter((c) => c.method === "SimulateOffer").at(-1);
    assert.deepEqual((call?.message as { overrides: Array<{ name: string; value: bigint }> }).overrides.map((o) => [o.name, o.value]), [["retention", 2000n]]);
  });
});

describe("when the engine fails", () => {
  test("an engine that does not answer is ENGINE_UNAVAILABLE, and the console gets no stack trace", async () => {
    const reader = harness.console();
    await reader.signIn("marketing-1");
    harness.engine.failNext("ListMarkets", Code.Unavailable, "the database is unreachable");
    const answer = await reader.graphql("{ markets { code } }");
    assert.deepEqual(codes(answer), ["ENGINE_UNAVAILABLE"]);
    assert.doesNotMatch(answer.text, /stack|at .*\.ts|the database is unreachable/);
  });

  test("an engine past its deadline is ENGINE_UNAVAILABLE, on time", async () => {
    const reader = harness.console();
    await reader.signIn("marketing-1");
    const deadline = harness.config.timeouts.readMs;
    harness.engine.delayNext("ListMarkets", deadline * 10);
    const started = performance.now();
    const answer = await reader.graphql("{ markets { code } }");
    const waited = performance.now() - started;
    assert.deepEqual(codes(answer), ["ENGINE_UNAVAILABLE"]);
    assert.ok(waited >= deadline * 0.9 && waited < deadline * 5, `the read deadline is ${deadline} ms; the request took ${Math.round(waited)} ms`);
  });

  test("an internal error of the engine is INTERNAL_SERVER_ERROR with a generic message, and the log keeps it", async () => {
    const reader = harness.console();
    await reader.signIn("marketing-1");
    harness.engine.failNext("ListMarkets", Code.Internal, "secret detail of the engine");
    const answer = await reader.graphql("{ markets { code } }", { headers: { "x-request-id": "req-internal-0001" } });
    assert.deepEqual(codes(answer), ["INTERNAL_SERVER_ERROR"]);
    assert.doesNotMatch(answer.text, /secret detail/);
    assert.equal(answer.body.extensions.requestId, "req-internal-0001");
    assert.ok(harness.logs.some((line) => line["requestId"] === "req-internal-0001" && line["code"] === "Internal" && line["engine"] === "secret detail of the engine"));
  });

  test("an engine that stopped: /health is 503 and every call ENGINE_UNAVAILABLE, until it is back", async () => {
    const reader = harness.console();
    await reader.signIn("marketing-1");
    await harness.engine.stop();
    try {
      const health = await reader.raw({ method: "GET", path: "/health" });
      assert.equal(health.status, 503);
      assert.deepEqual(health.body, { status: "degraded", endpoint: "internal", engine: "UNREACHABLE", mode: "demonstration" });
      assert.deepEqual(codes(await reader.graphql("{ markets { code } }")), ["ENGINE_UNAVAILABLE"]);
      assert.deepEqual(codes(await harness.site().graphql('{ offers(market: "IT") { id } }')), ["ENGINE_UNAVAILABLE"]);
    } finally {
      await harness.engine.start();
    }
    const back = await reader.graphql("{ markets { code } }");
    assert.equal(back.body.errors, undefined, back.text);
    assert.equal((await reader.raw({ method: "GET", path: "/health" })).status, 200);
  });

  test("the engine refusing the gateway's token is ENGINE_UNAVAILABLE for the person, and a log line for whoever runs it", async () => {
    const reader = harness.console();
    await reader.signIn("marketing-1");
    harness.engine.failNext("ListMarkets", Code.Unauthenticated, "missing or wrong internal token");
    const answer = await reader.graphql("{ markets { code } }", { headers: { "x-request-id": "req-token-00001" } });
    assert.deepEqual(codes(answer), ["ENGINE_UNAVAILABLE"]);
    assert.ok(harness.logs.some((line) => line["requestId"] === "req-token-00001" && line["code"] === "Unauthenticated"));
  });
});
