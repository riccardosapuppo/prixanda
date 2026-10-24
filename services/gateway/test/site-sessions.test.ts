// The site's session: DEMONSTRATION MODE, not authentication. The entrance
// lists the demo's listeners; choosing one starts a session of the site's
// own, apart from the console's, and from then on the session, never the
// browser, says who the site acts for.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type GraphQLError, isObjectType } from "graphql";
import { engineCalls } from "../src/core/engine.ts";
import { buildPublicSchema } from "../src/core/schemas.ts";
import { connectEngine } from "../src/node/grpc.ts";
import { COOKIE, SITE_COOKIE } from "../src/node/sessions.ts";
import { LISTENERS } from "./support/fake-engine.ts";
import { codes, type Harness, SITE_ORIGIN, startHarness } from "./support/harness.ts";

const ME = "{ me { id market title account { subscription { plan } } } }";

describe("in development, where the site keeps sessions", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.close();
  });

  describe("the site's entrance", () => {
    test("lists the demo's listeners, each saying that it is simulated, and choosing one starts the site's session", async () => {
      const site = harness.site();
      harness.engine.clearCalls();
      const entrance = await site.graphql("{ demoListeners { id market title label plan studentVerified } me { id } }");
      assert.equal(entrance.body.errors, undefined, entrance.text);
      assert.deepEqual(entrance.body.data.demoListeners.map((listener: { id: string }) => listener.id), ["5001", "5002", "5003", "5004", "5005", "5006"]);
      for (const listener of entrance.body.data.demoListeners) assert.match(listener.label, /^Simulated listener\./);
      assert.equal(entrance.body.data.me, null);
      const call = harness.engine.calls.find((candidate) => candidate.method === "ListDemoListeners");
      assert.deepEqual([call?.actor, call?.role], [null, null], "the entrance acts for nobody");

      const entered = await site.graphql("mutation ($id: ID!) { signInAsListener(listenerId: $id) { id market title csrfToken expiresAt } }", {
        variables: { id: LISTENERS.verified },
      });
      assert.equal(entered.body.errors, undefined, entered.text);
      const me = entered.body.data.signInAsListener;
      assert.deepEqual({ id: me.id, market: me.market, title: me.title }, { id: "5001", market: "IT", title: "Student in Italy, verified" });
      assert.equal(me.expiresAt, "2026-10-24T09:00:00.000Z", "an hour without requests ends it, by the injected clock");
      const cookie = String(entered.headers["set-cookie"]);
      assert.match(cookie, new RegExp(`^${SITE_COOKIE}=`));
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      site.csrf = me.csrfToken;
      const back = await site.graphql(ME);
      assert.deepEqual(back.body.data.me, { id: "5001", market: "IT", title: "Student in Italy, verified", account: { subscription: { plan: "free" } } });
    });

    test("offers only the demo's listeners: any other id is not found, and a malformed one is refused", async () => {
      for (const [id, code] of [["5007", "NOT_FOUND"], ["1", "NOT_FOUND"], ["0", "BAD_USER_INPUT"], ["listener-1", "BAD_USER_INPUT"]] as const) {
        const site = harness.site();
        const answer = await site.graphql("mutation ($id: ID!) { signInAsListener(listenerId: $id) { id } }", { variables: { id } });
        assert.deepEqual(codes(answer), [code], id);
        assert.equal(answer.headers["set-cookie"], undefined, `${id}: no session was started`);
      }
    });

    test("names no subscriber in any argument: the listener's id travels once, to choose them at the entrance", () => {
      const schema = buildPublicSchema();
      const named: string[] = [];
      for (const type of Object.values(schema.getTypeMap())) {
        if (!isObjectType(type) || type.name.startsWith("__")) continue;
        for (const field of Object.values(type.getFields())) {
          for (const argument of field.args) if (/subscriber|listener/i.test(argument.name)) named.push(`${type.name}.${field.name}(${argument.name})`);
        }
      }
      assert.deepEqual(named, ["Mutation.signInAsListener(listenerId)"]);
    });
  });

  describe("what acts for a listener", () => {
    test("needs the site's session: without one it is UNAUTHENTICATED, and the engine hears nothing", async () => {
      const site = harness.site();
      harness.engine.clearCalls();
      const verify = await site.graphql("mutation { verifyStudent { __typename } }");
      assert.deepEqual(codes(verify), ["UNAUTHENTICATED"]);
      const confirm = await site.graphql('mutation { confirmSubscription(quoteId: "q_0123456789abcdef0123456789abcdef") { __typename } }');
      assert.deepEqual(codes(confirm), ["UNAUTHENTICATED"]);
      assert.equal(harness.engine.count("VerifyStudent") + harness.engine.count("ConfirmQuote") + harness.engine.count("GetAccount"), 0);
    });

    test("acts for the session's listener: the engine gets their id from the gateway, and no person of the team", async () => {
      const site = harness.site();
      await site.signInAsListener(LISTENERS.unverified);
      harness.engine.clearCalls();
      const verify = await site.graphql("mutation { verifyStudent { __typename } }", { key: "site-verify-0001" });
      assert.equal(verify.body.data.verifyStudent.__typename, "StudentVerification", verify.text);
      const call = harness.engine.calls.find((candidate) => candidate.method === "VerifyStudent");
      assert.equal((call?.message as { subscriberId: string } | undefined)?.subscriberId, "5002");
      assert.deepEqual([call?.actor, call?.role, call?.idempotencyKey], [null, null, "site-verify-0001"]);
    });

    test("the core's binding writes the session's listener over any subscriber a request names, and starts nothing without one", async () => {
      const connection = connectEngine(harness.engine.url, harness.engine.token);
      try {
        const settings = { requestId: "binding-check-0001", idempotencyKey: null, detailedErrors: false, timeouts: { readMs: 1_000, writeMs: 1_000 } };
        const asVerified = engineCalls(connection.client, settings, null, () => LISTENERS.verified);
        const { account } = await asVerified.subscribers.getAccount({ subscriberId: LISTENERS.freeInFrance });
        assert.equal(account?.market, "IT", "the account read is the session's listener's, not the one the request named");
        harness.engine.clearCalls();
        const nobody = engineCalls(connection.client, settings, null, () => null);
        await assert.rejects(nobody.subscribers.getAccount({ subscriberId: LISTENERS.freeInFrance }), (error: GraphQLError) => error.extensions["code"] === "UNAUTHENTICATED");
        assert.equal(harness.engine.count(), 0);
      } finally {
        connection.close();
      }
    });

    test("a request's log line names the listener, and no person", async () => {
      const site = harness.site();
      await site.signInAsListener(LISTENERS.freeInFrance);
      const answer = await site.graphql(ME);
      const line = harness.logs.find((entry) => entry["msg"] === "request" && entry["requestId"] === answer.headers["x-request-id"]);
      assert.equal(line?.["listener"], "5004");
      assert.equal(line?.["person"], undefined);
    });
  });

  describe("the site's session and the console's", () => {
    test("are apart: each API reads its own cookie, and a value of one does not verify in the other", async () => {
      const site = harness.site();
      await site.signInAsListener(LISTENERS.verified);
      const person = harness.console();
      await person.signIn("auditor-1");
      assert.ok(site.cookie && person.cookie);
      // A browser sends both cookies to both ports of one host.
      const both = `${COOKIE}=${person.cookie}; ${SITE_COOKIE}=${site.cookie}`;
      const onSite = await harness.site().raw({ headers: { "content-type": "application/json", cookie: both }, body: JSON.stringify({ query: "{ me { id } }" }) });
      assert.deepEqual(onSite.body.data.me, { id: "5001" });
      const onConsole = await harness.console().raw({ headers: { "content-type": "application/json", cookie: both }, body: JSON.stringify({ query: "{ session { person { id } } }" }) });
      assert.deepEqual(onConsole.body.data.session, { person: { id: "auditor-1" } });
      // Each cookie's value under the other's name: signed for another store, so worth nothing.
      const swappedOnSite = await harness.site().raw({ headers: { "content-type": "application/json", cookie: `${SITE_COOKIE}=${person.cookie}` }, body: JSON.stringify({ query: "{ me { id } }" }) });
      assert.equal(swappedOnSite.body.data.me, null);
      const swappedOnConsole = await harness.console().raw({ headers: { "content-type": "application/json", cookie: `${COOKIE}=${site.cookie}` }, body: JSON.stringify({ query: "{ session { person { id } } }" }) });
      assert.equal(swappedOnConsole.body.data.session, null);
    });
  });

  describe("CSRF on the site", () => {
    test("with the site's session, a mutation without its token is refused before the engine; with it, it passes", async () => {
      const site = harness.site();
      await site.signInAsListener(LISTENERS.verified);
      const token = site.csrf;
      site.csrf = null;
      harness.engine.clearCalls();
      const missing = await site.graphql("mutation { verifyStudent { __typename } }");
      assert.equal(missing.status, 403, missing.text);
      assert.deepEqual(codes(missing), ["FORBIDDEN"]);
      const quote = await site.graphql('mutation { requestQuote(plan: "student", market: "IT") { __typename } }');
      assert.equal(quote.status, 403, "a quote asked inside the session is the listener's: it needs the token too");
      assert.equal(harness.engine.count(), 0);
      const other = harness.site();
      await other.signInAsListener(LISTENERS.unverified);
      site.csrf = other.csrf;
      assert.equal((await site.graphql("mutation { verifyStudent { __typename } }")).status, 403, "another session's token does not do");
      site.csrf = token;
      const right = await site.graphql("mutation { verifyStudent { __typename } }");
      assert.equal(right.body.data.verifyStudent.__typename, "StudentVerification", right.text);
      site.csrf = null;
      assert.equal((await site.graphql(ME)).status, 200, "queries need no token");
    });
  });

  describe("leaving", () => {
    test("signing out ends the session on the server, not only in the browser", async () => {
      const site = harness.site();
      await site.signInAsListener(LISTENERS.verified);
      const kept = site.cookie;
      const out = await site.graphql("mutation { signOutListener }");
      assert.equal(out.body.data.signOutListener, true);
      assert.match(String(out.headers["set-cookie"]), new RegExp(`^${SITE_COOKIE}=;.*Max-Age=0`));
      const replay = harness.site();
      replay.cookie = kept;
      assert.equal((await replay.graphql("{ me { id } }")).body.data.me, null);
      assert.equal((await harness.site().graphql("mutation { signOutListener }")).body.data.signOutListener, false, "no session: nothing to end");
    });

    test("choosing another listener gives a new cookie and ends the old session", async () => {
      const site = harness.site();
      await site.signInAsListener(LISTENERS.verified);
      const first = site.cookie;
      await site.signInAsListener(LISTENERS.paidBefore);
      assert.notEqual(site.cookie, first);
      assert.deepEqual((await site.graphql("{ me { id } }")).body.data.me, { id: "5003" });
      const replay = harness.site();
      replay.cookie = first;
      assert.equal((await replay.graphql("{ me { id } }")).body.data.me, null);
    });
  });
});

describe("in production", () => {
  test("the site keeps no sessions: nobody to choose, no cookie, no credentials, and nothing acts for a listener", async () => {
    const production = await startHarness({ env: { GATEWAY_ENV: "production", GATEWAY_ENDPOINTS: "public" } });
    try {
      assert.equal(production.config.siteSessions, false);
      assert.equal(production.config.sessionSecret, null, "no API keeps sessions, so no key signs any");
      const site = production.site();
      production.engine.clearCalls();
      const entrance = await site.graphql("{ demoListeners { id } me { id } }");
      assert.deepEqual(entrance.body.data, { demoListeners: [], me: null });
      assert.equal(production.engine.count("ListDemoListeners"), 0);
      const enter = await site.graphql(`mutation { signInAsListener(listenerId: "${LISTENERS.verified}") { id } }`);
      assert.deepEqual(codes(enter), ["FORBIDDEN"]);
      assert.equal(enter.headers["set-cookie"], undefined);
      assert.deepEqual(codes(await site.graphql("mutation { verifyStudent { __typename } }")), ["UNAUTHENTICATED"]);
      const preflight = await site.raw({ method: "OPTIONS", headers: { origin: SITE_ORIGIN, "access-control-request-method": "POST" } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers["access-control-allow-credentials"], undefined);
      // The catalog and anonymous quotes are what a production site may serve.
      const quote = await site.graphql('mutation { requestQuote(plan: "student", market: "IT", offerId: "9001") { __typename ... on Quote { price } } }', { key: "production-quote-01" });
      assert.deepEqual(quote.body.data.requestQuote, { __typename: "Quote", price: { amountMinor: "299", currency: "EUR" } });
    } finally {
      await production.close();
    }
  });
});
