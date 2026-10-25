// Idempotency: a mutation names its action with an Idempotency-Key, the
// gateway passes it to the engine untouched, and the engine answers a repeat
// with what it answered the first time (the engine's behaviour 2, proto/README.md). The
// gateway never makes a key up, and one request carries one mutation.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { codes, type Harness, startHarness } from "./support/harness.ts";

const OFFER = {
  title: "Once only", plan: "student", audience: { segment: "NEVER_PAID", needsStudentCheck: true },
  prices: [{ market: "IT", fixed: { amountMinor: "299", currency: "EUR" } }], monthsAtOfferPrice: 3,
  periods: [{ market: "IT", startsLocal: "2026-11-02T09:00" }], nonCombinabilityGroup: "student",
  pages: [{ market: "IT", title: "Once only", text: "Text", terms: "Terms" }],
};
const CREATE = "mutation ($o: OfferInput!) { createOffer(offer: $o) { __typename ... on Change { id title } } }";

let harness: Harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness.close();
});

describe("Idempotency-Key", () => {
  test("a mutation without one is refused before the engine: the gateway does not invent keys", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    harness.engine.clearCalls();
    const answer = await client.graphql(CREATE, { variables: { o: OFFER }, key: false });
    assert.deepEqual(codes(answer), ["BAD_USER_INPUT"]);
    assert.match(answer.body.errors[0].message, /Idempotency-Key/);
    assert.equal(harness.engine.count("CreateChange"), 0);
  });

  test("a malformed one is refused with 400, and never forwarded", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    harness.engine.clearCalls();
    for (const key of ["short", "has space in it", "-starts-with-dash", "x".repeat(101), "semi;colon-key"]) {
      const answer = await client.graphql(CREATE, { variables: { o: OFFER }, key });
      assert.equal(answer.status, 400, key);
      assert.deepEqual(codes(answer), ["BAD_USER_INPUT"], key);
    }
    assert.equal(harness.engine.count(), 0);
  });

  test("the same key and the same mutation give the first answer again, and one change", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    const before = harness.engine.changes.size;
    const replays = harness.engine.replays;
    const first = await client.graphql(CREATE, { variables: { o: OFFER }, key: "create-offer-0001" });
    const again = await client.graphql(CREATE, { variables: { o: OFFER }, key: "create-offer-0001" });
    assert.equal(first.body.data.createOffer.__typename, "Change", first.text);
    assert.deepEqual(again.body.data, first.body.data);
    assert.equal(harness.engine.changes.size, before + 1);
    assert.equal(harness.engine.replays, replays + 1);
    const forwarded = harness.engine.calls.filter((call) => call.method === "CreateChange").slice(-2).map((call) => call.idempotencyKey);
    assert.deepEqual(forwarded, ["create-offer-0001", "create-offer-0001"]);
  });

  test("the same key for another request is refused by the engine, and the console hears why", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    await client.graphql(CREATE, { variables: { o: OFFER }, key: "create-offer-0002" });
    const other = await client.graphql(CREATE, { variables: { o: { ...OFFER, title: "Another" } }, key: "create-offer-0002" });
    assert.deepEqual(codes(other), ["BAD_USER_INPUT"]);
    assert.match(other.body.errors[0].message, /idempotency-key was used for another request/);
  });

  test("the same key from another person is refused too", async () => {
    const first = harness.console();
    await first.signIn("marketing-1");
    await first.graphql(CREATE, { variables: { o: OFFER }, key: "create-offer-0003" });
    const second = harness.console();
    await second.signIn("marketing-2");
    const answer = await second.graphql(CREATE, { variables: { o: OFFER }, key: "create-offer-0003" });
    assert.deepEqual(codes(answer), ["BAD_USER_INPUT"]);
  });

  test("reads never carry a key to the engine, even when the client sends one", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    harness.engine.clearCalls();
    await client.graphql("{ changes { nodes { id } } markets { code } }", { headers: { "idempotency-key": "read-key-00001" } });
    assert.ok(harness.engine.count() >= 2);
    assert.deepEqual(harness.engine.calls.map((call) => call.idempotencyKey), harness.engine.calls.map(() => null));
  });

  test("signing in and out need no key: they change the gateway's session, not the engine", async () => {
    const client = harness.console();
    const answer = await client.graphql('mutation { signIn(personId: "auditor-1") { csrfToken } }', { key: false });
    assert.equal(answer.body.errors, undefined, answer.text);
    client.csrf = answer.body.data.signIn.csrfToken;
    const out = await client.graphql("mutation { signOut }", { key: false });
    assert.equal(out.body.data.signOut, true);
  });
});

describe("one mutation per request", () => {
  test("two mutations in one request are refused before anything runs", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    harness.engine.clearCalls();
    const answer = await client.graphql(`mutation ($o: OfferInput!) { a: createOffer(offer: $o) { __typename } b: createOffer(offer: $o) { __typename } }`, { variables: { o: OFFER } });
    assert.deepEqual(codes(answer), ["GRAPHQL_VALIDATION_FAILED"]);
    assert.match(answer.body.errors[0].message, /One mutation per request/);
    assert.equal(harness.engine.count(), 0);
  });

  test("a fragment does not hide a second one", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    const answer = await client.graphql(`mutation ($o: OfferInput!) { ...Both } fragment Both on Mutation { createOffer(offer: $o) { __typename } signOut }`, { variables: { o: OFFER } });
    assert.deepEqual(codes(answer), ["GRAPHQL_VALIDATION_FAILED"]);
  });
});

describe("the site's quotes", () => {
  test("need a key, and the same key gives the same quote", async () => {
    const site = harness.site();
    const query = 'mutation { requestQuote(plan: "student", market: "IT", offerId: "9001") { __typename ... on Quote { id price } } }';
    const missing = await site.graphql(query, { key: false });
    assert.deepEqual(codes(missing), ["BAD_USER_INPUT"]);
    const first = await site.graphql(query, { key: "quote-key-0001" });
    const again = await site.graphql(query, { key: "quote-key-0001" });
    assert.equal(first.body.data.requestQuote.__typename, "Quote", first.text);
    assert.deepEqual(again.body.data, first.body.data);
    const fresh = await site.graphql(query, { key: "quote-key-0002" });
    assert.notEqual(fresh.body.data.requestQuote.id, first.body.data.requestQuote.id);
  });
});
