// The gateway in the browser (stage 8): the shell the sandbox's worker runs,
// against the fake engine in this process. It answers as the HTTP shell does,
// from the same core, schemas, limits and errors; its sessions are the
// worker's, one per API for every tab of the origin, as an origin's cookies.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startBrowserGateway, type BrowserGateway } from "../src/browser/gateway.ts";
import { createEngineClient } from "../src/core/engine.ts";
import { FakeEngine, LISTENERS } from "./support/fake-engine.ts";
import { TestClock, type Harness, startHarness } from "./support/harness.ts";

const JSON_HEADERS = { "content-type": "application/json" };
const body = (query: string, variables?: Record<string, unknown>) => JSON.stringify({ query, ...(variables ? { variables } : {}) });

/** One tab: it keeps the CSRF tokens it was given, and nothing else; the session is the worker's. */
class Tab {
  readonly #gateway: BrowserGateway;
  csrf: Record<"internal" | "public", string | null> = { internal: null, public: null };
  constructor(gateway: BrowserGateway) {
    this.#gateway = gateway;
  }

  async ask(api: "internal" | "public", query: string, options: { variables?: Record<string, unknown>; key?: string | false; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...JSON_HEADERS, ...options.headers };
    const token = this.csrf[api];
    if (token !== null && headers["x-csrf-token"] === undefined) headers["x-csrf-token"] = token;
    if (/^\s*mutation\b/.test(query) && options.key !== false && headers["idempotency-key"] === undefined) headers["idempotency-key"] = options.key ?? `key-${crypto.randomUUID()}`;
    const reply = await this.#gateway.request(api, { headers, body: body(query, options.variables) });
    return { ...reply, json: JSON.parse(reply.body) };
  }
}

const codes = (answer: { json: { errors?: Array<{ extensions?: { code?: string } }> } }) => (answer.json.errors ?? []).map((error) => error.extensions?.code);

describe("the gateway in the browser", () => {
  let clock: TestClock;
  let engine: FakeEngine;
  let gateway: BrowserGateway;
  before(async () => {
    clock = new TestClock();
    engine = new FakeEngine({ clock: clock.now });
    let next = 0;
    gateway = await startBrowserGateway({ engine: createEngineClient(engine.inProcessTransport()), clock: clock.now, newId: () => `req-${String(++next).padStart(4, "0")}` });
  });
  after(async () => {
    await gateway.stop();
  });

  test("answers the site's API as the HTTP shell does: status, request id, JSON body", async () => {
    const tab = new Tab(gateway);
    const answer = await tab.ask("public", "{ markets { code } }", { headers: { "x-request-id": "tab-request-0001" } });
    assert.equal(answer.status, 200, answer.body);
    assert.deepEqual(answer.json.data.markets.map((market: { code: string }) => market.code), ["IT", "FR", "DE", "GB"]);
    assert.equal(answer.headers["x-request-id"], "tab-request-0001");
    assert.equal(answer.json.extensions.requestId, "tab-request-0001");
    // The engine heard the request's id, and nobody: the catalog acts for nobody.
    const call = engine.calls.find((candidate) => candidate.method === "ListMarkets");
    assert.deepEqual([call?.requestId, call?.actor], ["tab-request-0001", null]);
  });

  test("one session per API for every tab: a listener chosen in one tab is everyone's, and signing out ends it for all", async () => {
    const first = new Tab(gateway);
    const second = new Tab(gateway);
    const entered = await first.ask("public", "mutation ($id: ID!) { signInAsListener(listenerId: $id) { id csrfToken } }", { variables: { id: LISTENERS.verified } });
    assert.equal(entered.json.data.signInAsListener.id, LISTENERS.verified, entered.body);
    first.csrf.public = entered.json.data.signInAsListener.csrfToken;
    const seen = await second.ask("public", "{ me { id csrfToken } }");
    assert.equal(seen.json.data.me.id, LISTENERS.verified, "the other tab has the same session, as with a cookie");
    second.csrf.public = seen.json.data.me.csrfToken;
    const left = await second.ask("public", "mutation { signOutListener }");
    assert.equal(left.json.data.signOutListener, true, left.body);
    assert.equal((await first.ask("public", "{ me { id } }")).json.data.me, null, "signed out in every tab");
  });

  test("a mutation needs the session's CSRF token while a session exists", async () => {
    const tab = new Tab(gateway);
    const entered = await tab.ask("public", "mutation ($id: ID!) { signInAsListener(listenerId: $id) { csrfToken } }", { variables: { id: LISTENERS.unverified } });
    const token = entered.json.data.signInAsListener.csrfToken as string;
    const without = await tab.ask("public", "mutation { verifyStudent { __typename } }");
    assert.equal(without.status, 403, without.body);
    assert.deepEqual(codes(without), ["FORBIDDEN"]);
    const wrong = await tab.ask("public", "mutation { verifyStudent { __typename } }", { headers: { "x-csrf-token": `${token}x` } });
    assert.equal(wrong.status, 403);
    tab.csrf.public = token;
    const right = await tab.ask("public", "mutation { verifyStudent { __typename } }");
    assert.equal(right.json.data.verifyStudent.__typename, "StudentVerification", right.body);
    await tab.ask("public", "mutation { signOutListener }");
  });

  test("the console's API: a person of the demo, the roles the engine lists, the matrix before the engine; the site's session apart", async () => {
    const tab = new Tab(gateway);
    const signed = await tab.ask("internal", 'mutation { signIn(personId: "finance-1") { csrfToken roles person { id } } }');
    assert.deepEqual(signed.json.data.signIn.roles, ["FINANCE"], signed.body);
    tab.csrf.internal = signed.json.data.signIn.csrfToken;
    engine.clearCalls();
    const refused = await tab.ask("internal", 'mutation { suspendChange(changeId: "1", reason: "Stop.") { __typename ... on Refusal { code } } }');
    assert.equal(refused.json.data.suspendChange.code, "ROLE_NOT_ALLOWED", refused.body);
    assert.equal(engine.count("SuspendChange"), 0, "refused before the engine");
    // The site has no listener for it: each API reads its own session only.
    assert.equal((await tab.ask("public", "{ me { id } }")).json.data.me, null);
  });

  test("refuses what the HTTP shell refuses: not JSON, not application/json, a body over 64 KiB, a malformed or missing Idempotency-Key", async () => {
    const raw = (headers: Record<string, string>, text: string) => gateway.request("public", { headers, body: text });
    assert.equal((await raw(JSON_HEADERS, "{ not json")).status, 400);
    assert.equal((await raw({ "content-type": "text/plain" }, body("{ markets { code } }"))).status, 415);
    assert.equal((await raw(JSON_HEADERS, JSON.stringify({ query: `{ markets { code } } #${"x".repeat(70_000)}` }))).status, 413);
    const malformed = await raw({ ...JSON_HEADERS, "idempotency-key": "no" }, body('mutation { requestQuote(plan: "family", market: "IT") { __typename } }'));
    assert.equal(malformed.status, 400);
    const tab = new Tab(gateway);
    const missing = await tab.ask("public", 'mutation { requestQuote(plan: "family", market: "IT") { __typename } }', { key: false });
    assert.deepEqual(codes(missing), ["BAD_USER_INPUT"], missing.body);
    // The schema's own limits hold too: the site's depth is the HTTP shell's.
    const deep = await tab.ask("public", "{ me { account { prepaidCodes { payment { receipt { amount } } } } } } ");
    assert.equal(deep.status, 200, deep.body);
  });

  test("the sessions end after an hour without a request, by the browser's clock, and all at once when the demo starts over", async () => {
    const tab = new Tab(gateway);
    await tab.ask("public", "mutation ($id: ID!) { signInAsListener(listenerId: $id) { id } }", { variables: { id: LISTENERS.paidBefore } });
    clock.advance(59 * 60 * 1000);
    assert.equal((await tab.ask("public", "{ me { id } }")).json.data.me.id, LISTENERS.paidBefore);
    clock.advance(60 * 60 * 1000);
    assert.equal((await tab.ask("public", "{ me { id } }")).json.data.me, null, "an hour without a request");
    await tab.ask("public", "mutation ($id: ID!) { signInAsListener(listenerId: $id) { id } }", { variables: { id: LISTENERS.paidBefore } });
    await tab.ask("internal", 'mutation { signIn(personId: "auditor-1") { csrfToken } }');
    gateway.reset();
    assert.equal((await tab.ask("public", "{ me { id } }")).json.data.me, null);
    assert.equal((await tab.ask("internal", "{ session { person { id } } }")).json.data.session, null);
  });
});

describe("the same request through both shells", () => {
  let harness: Harness;
  let gateway: BrowserGateway;
  before(async () => {
    harness = await startHarness();
    gateway = await startBrowserGateway({ engine: createEngineClient(harness.engine.inProcessTransport()), clock: harness.clock.now });
  });
  after(async () => {
    await gateway.stop();
    await harness.close();
  });

  test("gets the same answer, but for its request id", async () => {
    const queries = [
      '{ offers(market: "IT") { id title price breakdown { artists topUp } } plans(market: "IT") { code listPrice } }',
      '{ prices(market: "DE", plan: "family") { amount validFrom } }',
      "{ markets { code nope } }",
      '{ offers(market: "XX") { id } }',
    ];
    for (const query of queries) {
      const overHttp = await harness.site().graphql(query, { headers: { "x-request-id": "both-shells-0001" } });
      const inBrowser = await gateway.request("public", { headers: { ...JSON_HEADERS, "x-request-id": "both-shells-0001" }, body: body(query) });
      assert.equal(inBrowser.status, overHttp.status, query);
      assert.deepEqual(JSON.parse(inBrowser.body), overHttp.body, query);
    }
  });
});
