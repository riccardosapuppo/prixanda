// Authorization on the server, through HTTP as a browser would ask: no
// session, every role against every operation, the fields narrower than their
// operation, a browser trying to give itself a role, the session cookie, CSRF
// and CORS. The expectations come from the coordinator's table, written in
// roles.test.ts and here on their own, not from the gateway's policy.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ChangeState } from "contracts/commerce/v1/changes";
import { buildInternalSchema } from "../src/core/schemas.ts";
import { INTERNAL_ACCESS } from "../src/core/policy.ts";
import { SessionStore } from "../src/node/sessions.ts";
import { codes, CONSOLE_ORIGIN, type Harness, startHarness } from "./support/harness.ts";

const OFFER = {
  title: "Offer", plan: "student", audience: { segment: "NEVER_PAID", needsStudentCheck: true },
  prices: [{ market: "IT", fixed: { amountMinor: "299", currency: "EUR" } }], monthsAtOfferPrice: 3,
  periods: [{ market: "IT", startsLocal: "2026-11-02T09:00" }], nonCombinabilityGroup: "student",
  pages: [{ market: "IT", title: "Offer", text: "Text", terms: "Terms" }],
};
const LIST_PRICE = { title: "Up", plan: "family", market: "DE", amount: { amountMinor: "2099", currency: "EUR" }, startsLocal: "2027-01-01T00:00" };
const MIGRATION = {
  title: "Family price in Germany", plan: "family", market: "DE", amount: { amountMinor: "2099", currency: "EUR" },
  noticesLocal: "2026-11-02T09:00", startsLocal: "2026-12-01T00:00",
};

/** One call of each root field that needs a session, with what it needs; `id` is replaced by a change of the right state. */
const OPERATIONS: Record<string, { query: string; variables?: Record<string, unknown>; method: string | null }> = {
  overview: { query: "{ overview { exchangeRateNote } }", method: "GetOverview" },
  markets: { query: "{ markets { code } }", method: "ListMarkets" },
  plans: { query: '{ plans(market: "IT") { code } }', method: "ListPlans" },
  priceList: { query: "{ priceList { id } }", method: "GetPriceList" },
  change: { query: '{ change(id: "ID") { id } }', method: "BatchGetChanges" },
  changes: { query: "{ changes { nodes { id } } }", method: "ListChanges" },
  simulateOffer: { query: '{ simulateOffer(changeId: "ID", version: 1, market: "IT") { __typename ... on Refusal { code } } }', method: "SimulateOffer" },
  auditEvents: { query: "{ auditEvents { nodes { seq } } }", method: "ListEvents" },
  verifyAuditChain: { query: "{ verifyAuditChain { ok } }", method: "VerifyChain" },
  createOffer: { query: "mutation ($o: OfferInput!) { createOffer(offer: $o) { __typename ... on Refusal { code } } }", variables: { o: OFFER }, method: "CreateChange" },
  createListPrice: { query: "mutation ($p: ListPriceInput!) { createListPrice(listPrice: $p) { __typename ... on Refusal { code } } }", variables: { p: LIST_PRICE }, method: "CreateChange" },
  saveOfferVersion: { query: 'mutation ($o: OfferInput!) { saveOfferVersion(changeId: "ID", baseVersion: 1, offer: $o) { __typename ... on Refusal { code } } }', variables: { o: OFFER }, method: "SaveVersion" },
  saveListPriceVersion: { query: 'mutation ($p: ListPriceInput!) { saveListPriceVersion(changeId: "ID", baseVersion: 1, listPrice: $p) { __typename ... on Refusal { code } } }', variables: { p: LIST_PRICE }, method: "SaveVersion" },
  validateChange: { query: 'mutation { validateChange(changeId: "ID", version: 1) { __typename ... on Refusal { code } } }', method: "ValidateChange" },
  submitChange: { query: 'mutation { submitChange(changeId: "ID", version: 1) { __typename ... on Refusal { code } } }', method: "SubmitChange" },
  approveChange: { query: `mutation { approveChange(changeId: "ID", version: 1, fingerprint: "${"a".repeat(64)}") { __typename ... on Refusal { code } } }`, method: "ApproveChange" },
  rejectChange: { query: 'mutation { rejectChange(changeId: "ID", version: 1, reason: "No.") { __typename ... on Refusal { code } } }', method: "RejectChange" },
  scheduleChange: { query: 'mutation { scheduleChange(changeId: "ID") { __typename ... on Refusal { code } } }', method: "ScheduleChange" },
  cancelChange: { query: 'mutation { cancelChange(changeId: "ID", reason: "Stop.") { __typename ... on Refusal { code } } }', method: "CancelChange" },
  suspendChange: { query: 'mutation { suspendChange(changeId: "ID", reason: "Stop.") { __typename ... on Refusal { code } } }', method: "SuspendChange" },
  exportAuditHead: { query: "mutation { exportAuditHead { __typename ... on Refusal { code } } }", method: "ExportHead" },
  // Stage 7: on these, "ID" is a price migration's.
  createPriceMigration: { query: "mutation ($m: PriceMigrationInput!) { createPriceMigration(migration: $m) { __typename ... on Refusal { code } } }", variables: { m: MIGRATION }, method: "CreateChange" },
  savePriceMigrationVersion: { query: 'mutation ($m: PriceMigrationInput!) { savePriceMigrationVersion(changeId: "ID", baseVersion: 1, migration: $m) { __typename ... on Refusal { code } } }', variables: { m: MIGRATION }, method: "SaveVersion" },
  simulateMigration: { query: '{ simulateMigration(changeId: "ID") { __typename ... on Refusal { code } } }', method: "SimulateMigration" },
  // Stage 6: "LAUNCH" is replaced by a failed launch of the fake engine's.
  launches: { query: "{ launches { nodes { id } } }", method: "ListLaunches" },
  launch: { query: '{ launch(id: "LAUNCH") { id } }', method: "GetLaunch" },
  retryLaunch: { query: 'mutation { retryLaunch(launchId: "LAUNCH") { __typename ... on Refusal { code } } }', method: "RetryLaunch" },
  cancelLaunch: { query: 'mutation { cancelLaunch(launchId: "LAUNCH", reason: "Stop.") { __typename ... on Refusal { code } } }', method: "CancelLaunch" },
};

/** Who may, per operation, from the coordinator's table (any kind of change). */
const MAY: Record<string, string[]> = {
  overview: ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"],
  markets: ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"],
  plans: ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"],
  priceList: ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"],
  change: ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"],
  changes: ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"],
  auditEvents: ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"],
  simulateOffer: ["marketing", "commercial_lead", "finance"],
  verifyAuditChain: ["auditor", "on_call"],
  createOffer: ["marketing"],
  saveOfferVersion: ["marketing"],
  createListPrice: ["commercial_lead"],
  saveListPriceVersion: ["commercial_lead"],
  validateChange: ["marketing", "commercial_lead"],
  submitChange: ["marketing", "commercial_lead"],
  approveChange: ["commercial_lead", "finance"],
  rejectChange: ["commercial_lead", "finance"],
  scheduleChange: ["marketing", "commercial_lead"],
  cancelChange: ["marketing", "commercial_lead", "on_call"],
  suspendChange: ["on_call"],
  exportAuditHead: ["auditor"],
  createPriceMigration: ["commercial_lead"],
  savePriceMigrationVersion: ["commercial_lead"],
  simulateMigration: ["marketing", "commercial_lead", "finance"],
  launches: ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"],
  launch: ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"],
  retryLaunch: ["on_call"],
  cancelLaunch: ["on_call"],
};

const PEOPLE: Record<string, string> = {
  marketing: "marketing-1", commercial_lead: "commercial-lead-1", finance: "finance-1",
  catalog_manager: "catalog-manager-1", on_call: "on-call-1", auditor: "auditor-1",
};

let harness: Harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness.close();
});

function withId(operation: { query: string }, id: string, launch = "1"): string {
  return operation.query.replaceAll('"ID"', `"${id}"`).replaceAll('"LAUNCH"', `"${launch}"`);
}

describe("without a session", () => {
  test("the list of operations here covers every root field that needs a session", () => {
    const schema = buildInternalSchema();
    const roots = [...Object.keys(schema.getQueryType()?.getFields() ?? {}), ...Object.keys(schema.getMutationType()?.getFields() ?? {})];
    const needing = roots.filter((name) => !["people", "session", "signIn", "signOut"].includes(name));
    assert.deepEqual(needing.sort(), Object.keys(OPERATIONS).sort());
    assert.deepEqual(Object.keys(MAY).sort(), Object.keys(OPERATIONS).sort());
    // And the four that need none are exactly those the policy lets anyone call.
    const anyone = Object.entries({ ...INTERNAL_ACCESS.Query, ...INTERNAL_ACCESS.Mutation }).filter(([, access]) => access.kind === "anyone").map(([name]) => name);
    assert.deepEqual(anyone.sort(), ["people", "session", "signIn", "signOut"]);
  });

  test("every one of them is UNAUTHENTICATED, and the engine hears nothing", async () => {
    const id = harness.engine.seedOffer("Anyone?", "marketing-1", ChangeState.DRAFT).id;
    const anonymous = harness.console();
    harness.engine.clearCalls();
    for (const [name, operation] of Object.entries(OPERATIONS)) {
      const answer = await anonymous.graphql(withId(operation, id), operation.variables ? { variables: operation.variables } : {});
      assert.deepEqual(codes(answer), ["UNAUTHENTICATED"], `${name}: ${answer.text}`);
    }
    assert.equal(harness.engine.count(), 0);
  });

  test("the sign-in screen's list of people needs no session, and neither does asking who is signed in", async () => {
    const anonymous = harness.console();
    const answer = await anonymous.graphql("{ session { person { id } } people { id roles } }");
    assert.equal(answer.body.data.session, null);
    assert.equal(answer.body.data.people.length, 7);
  });
});

describe("each role against each operation", () => {
  for (const role of Object.keys(PEOPLE)) {
    test(`${role}: allowed operations reach the engine in that role; the others are refused before it`, async () => {
      const client = harness.console();
      await client.signIn(PEOPLE[role] ?? "");
      for (const [name, operation] of Object.entries(OPERATIONS)) {
        const states: Record<string, ChangeState> = {
          submitChange: ChangeState.VALIDATED, approveChange: ChangeState.IN_APPROVAL, rejectChange: ChangeState.IN_APPROVAL,
          scheduleChange: ChangeState.APPROVED, cancelChange: ChangeState.SCHEDULED, suspendChange: ChangeState.ACTIVE,
        };
        const id = name.includes("Migration")
          ? harness.engine.seedMigration(states[name] ?? ChangeState.DRAFT).id
          : harness.engine.seedOffer(`${role} ${name}`, "marketing-2", states[name] ?? ChangeState.DRAFT).id;
        const launch = operation.query.includes('"LAUNCH"') ? harness.engine.seedLaunch("failed").id : "1";
        harness.engine.clearCalls();
        const answer = await client.graphql(withId(operation, id, launch), operation.variables ? { variables: operation.variables } : {});
        const allowed = MAY[name]?.includes(role) ?? false;
        const reached = harness.engine.calls.filter((call) => call.method === operation.method);
        if (allowed) {
          assert.equal(reached.length, 1, `${role} ${name} should reach ${operation.method}: ${answer.text}`);
          const expectedRole = operation.method === "ListMarkets" || operation.method === "ListPlans" || operation.method === "GetPriceList" ? null : role;
          assert.equal(reached[0]?.role ?? null, expectedRole, `${role} ${name} acts in its own role`);
          assert.ok(!codes(answer).includes("FORBIDDEN"), `${role} ${name}: ${answer.text}`);
        } else {
          assert.equal(reached.length, 0, `${role} ${name} must not reach the engine`);
          const field = answer.body?.data?.[name];
          if (field !== undefined && field !== null) {
            assert.equal(field.code, "ROLE_NOT_ALLOWED", `${role} ${name}: an operation with an outcome answers with a refusal`);
          } else {
            assert.deepEqual(codes(answer), ["FORBIDDEN"], `${role} ${name}: a read answers FORBIDDEN: ${answer.text}`);
          }
        }
      }
    });
  }
});

describe("fields narrower than their operation", () => {
  const OVERVIEW = "{ overview { waitingForApproval { id } monthlyRevenue { market revenue } monthlyRevenueEur monthlyTopUps exchangeRateNote } }";

  test("finance and the commercial lead read the revenue", async () => {
    for (const person of ["finance-1", "commercial-lead-1"]) {
      const client = harness.console();
      await client.signIn(person);
      const answer = await client.graphql(OVERVIEW);
      assert.equal(answer.body.errors, undefined, answer.text);
      assert.deepEqual(answer.body.data.overview.monthlyRevenueEur, { amountMinor: "15234000", currency: "EUR" });
    }
  });

  test("the other roles get FORBIDDEN on those three fields, and the rest of the home", async () => {
    for (const person of ["marketing-1", "catalog-manager-1", "on-call-1", "auditor-1"]) {
      const client = harness.console();
      await client.signIn(person);
      const answer = await client.graphql(OVERVIEW);
      assert.deepEqual(codes(answer), ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN"], `${person}: ${answer.text}`);
      assert.deepEqual(answer.body.errors.map((error: { path: string[] }) => error.path.join(".")).sort(),
        ["overview.monthlyRevenue", "overview.monthlyRevenueEur", "overview.monthlyTopUps"]);
      assert.equal(answer.body.data.overview.monthlyRevenueEur, null);
      assert.equal(answer.body.data.overview.exchangeRateNote, "1 EUR = 0.83728 GBP (ECB reference rate, 23 October 2026)");
    }
  });
});

describe("the browser never gives itself a role", () => {
  test("signIn takes a person, never a role", () => {
    const signIn = buildInternalSchema().getMutationType()?.getFields()["signIn"];
    assert.deepEqual(signIn?.args.map((arg) => arg.name), ["personId"]);
  });

  test("an unknown person cannot sign in", async () => {
    const client = harness.console();
    const answer = await client.graphql('mutation { signIn(personId: "admin") { csrfToken } }');
    assert.deepEqual(codes(answer), ["BAD_USER_INPUT"]);
    assert.equal(client.cookie, null);
  });

  test("headers a browser adds to claim another person, role or token never reach the engine", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    harness.engine.clearCalls();
    const answer = await client.graphql("{ changes { nodes { id } } }", {
      headers: { "x-actor": "finance-1", "x-actor-role": "finance", authorization: "Bearer forged", "idempotency-key": "forged-key-1" },
    });
    assert.equal(answer.body.errors, undefined, answer.text);
    const call = harness.engine.calls.find((candidate) => candidate.method === "ListChanges");
    assert.deepEqual(
      { actor: call?.actor, role: call?.role, authorization: call?.authorization, key: call?.idempotencyKey },
      { actor: "marketing-1", role: "marketing", authorization: `Bearer ${harness.engine.token}`, key: null },
    );
  });
});

describe("the session cookie", () => {
  test("is HttpOnly, SameSite=Strict, on the whole path, and signed", async () => {
    const client = harness.console();
    const answer = await client.signIn("auditor-1");
    const cookie = String(answer.headers["set-cookie"]);
    assert.match(cookie, /^gateway_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800$/);
  });

  test("a cookie altered by one character is no session at all", async () => {
    const client = harness.console();
    await client.signIn("auditor-1");
    const good = client.cookie ?? "";
    const [id = "", mac = ""] = good.split(".");
    for (const forged of [`${id}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`, `${id.slice(0, -1)}${id.endsWith("A") ? "B" : "A"}.${mac}`, id, `.${mac}`]) {
      client.cookie = forged;
      const answer = await client.graphql("{ session { person { id } } }");
      assert.equal(answer.body.data.session, null, `forged cookie ${forged}`);
    }
    client.cookie = good;
    const back = await client.graphql("{ session { person { id } } }");
    assert.deepEqual(back.body.data.session, { person: { id: "auditor-1" } });
  });

  test("signing in again gives a new cookie and ends the old one", async () => {
    const client = harness.console();
    await client.signIn("auditor-1");
    const first = client.cookie;
    await client.signIn("finance-1");
    assert.notEqual(client.cookie, first);
    const replay = harness.console();
    replay.cookie = first;
    assert.equal((await replay.graphql("{ session { person { id } } }")).body.data.session, null);
  });

  test("signing out ends it on the server, not only in the browser", async () => {
    const client = harness.console();
    await client.signIn("auditor-1");
    const kept = client.cookie;
    const out = await client.graphql("mutation { signOut }");
    assert.equal(out.body.data.signOut, true);
    assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
    const replay = harness.console();
    replay.cookie = kept;
    assert.equal((await replay.graphql("{ session { person { id } } }")).body.data.session, null);
  });

  test("ends after an hour without requests, by the injected clock", async () => {
    const client = harness.console();
    await client.signIn("auditor-1");
    harness.clock.advance(59 * 60_000);
    assert.notEqual((await client.graphql("{ session { person { id } } }")).body.data.session, null, "59 minutes: still there, and now renewed");
    harness.clock.advance(59 * 60_000);
    assert.notEqual((await client.graphql("{ session { person { id } } }")).body.data.session, null);
    harness.clock.advance(61 * 60_000);
    assert.equal((await client.graphql("{ session { person { id } } }")).body.data.session, null);
  });

  test("lives in the gateway's memory: a gateway started again knows none, even with the same key", () => {
    const clock = () => new Date("2026-10-24T08:00:00Z");
    const options = { secret: new Uint8Array(32).fill(7), clock, absoluteMs: 8 * 3_600_000, idleMs: 3_600_000 };
    const before = new SessionStore(options);
    const created = before.create({ personId: "auditor-1", label: "Auditor", roles: ["auditor"] });
    assert.notEqual(before.read(created.cookieValue), null);
    assert.equal(new SessionStore(options).read(created.cookieValue), null);
  });

  test("ends after a working day however busy", async () => {
    const client = harness.console();
    await client.signIn("auditor-1");
    for (let hour = 0; hour < 15; hour += 1) {
      harness.clock.advance(30 * 60_000);
      assert.notEqual((await client.graphql("{ session { expiresAt } }")).body.data.session, null, `after ${(hour + 1) / 2} h`);
    }
    harness.clock.advance(30 * 60_000);
    assert.equal((await client.graphql("{ session { expiresAt } }")).body.data.session, null, "after 8 h");
  });
});

describe("CSRF", () => {
  test("with a session, a mutation without the token is refused before the engine; with it, it passes", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    const token = client.csrf;
    client.csrf = null;
    harness.engine.clearCalls();
    const missing = await client.graphql("mutation ($o: OfferInput!) { createOffer(offer: $o) { __typename } }", { variables: { o: OFFER } });
    assert.equal(missing.status, 403, missing.text);
    assert.deepEqual(codes(missing), ["FORBIDDEN"]);
    const wrong = await client.graphql("mutation ($o: OfferInput!) { createOffer(offer: $o) { __typename } }", { variables: { o: OFFER }, headers: { "x-csrf-token": "x".repeat(43) } });
    assert.equal(wrong.status, 403);
    assert.equal(harness.engine.count("CreateChange"), 0);
    client.csrf = token;
    const right = await client.graphql("mutation ($o: OfferInput!) { createOffer(offer: $o) { __typename } }", { variables: { o: OFFER } });
    assert.equal(right.body.data.createOffer.__typename, "Change", right.text);
  });

  test("queries need no token", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    client.csrf = null;
    const answer = await client.graphql("{ changes { nodes { id } } }");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.errors, undefined);
  });

  test("another session's token does not do", async () => {
    const first = harness.console();
    await first.signIn("marketing-1");
    const second = harness.console();
    await second.signIn("marketing-2");
    first.csrf = second.csrf;
    const answer = await first.graphql("mutation ($o: OfferInput!) { createOffer(offer: $o) { __typename } }", { variables: { o: OFFER } });
    assert.equal(answer.status, 403);
  });
});

describe("CORS of the console's API", () => {
  test("the console's origin gets its preflight, with credentials", async () => {
    const answer = await harness.console().raw({ method: "OPTIONS", headers: { origin: CONSOLE_ORIGIN, "access-control-request-method": "POST" } });
    assert.equal(answer.status, 204);
    assert.equal(answer.headers["access-control-allow-origin"], CONSOLE_ORIGIN);
    assert.equal(answer.headers["access-control-allow-credentials"], "true");
    assert.match(String(answer.headers["access-control-allow-headers"]), /Idempotency-Key/);
  });

  test("any other origin is refused, preflight or not, and gets no CORS header", async () => {
    for (const origin of ["http://site.test:4632", "http://evil.test", "null"]) {
      const preflight = await harness.console().raw({ method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
      assert.equal(preflight.status, 403, origin);
      const post = await harness.console().graphql("{ people { id } }", { headers: { origin } });
      assert.equal(post.status, 403, origin);
      assert.equal(post.headers["access-control-allow-origin"], undefined);
    }
  });
});
