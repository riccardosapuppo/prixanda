// The data layer, without a browser: what the transport sends and reads back,
// what the API adds to every request and makes of every answer, and the keys
// of what a visitor may send more than once.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, createSiteApi } from "../src/data/api.ts";
import { ActionKeys, ID_SHAPE, newIdempotencyKey, newRequestId } from "../src/data/ids.ts";
import { type GraphqlRequest, type GraphqlResponse, httpTransport, type Transport, TransportFailure } from "../src/data/transport.ts";
import { SiteOffers, SiteRequestQuote } from "../src/graphql/generated.ts";

type Sent = { url: string; init: RequestInit };

/** A fetch that records what it was given and answers with `reply`. */
function recordingFetch(reply: () => Response | Promise<Response>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init: init ?? {} });
    return reply();
  };
  return { fetch: fake as typeof fetch, sent };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers } });

const request: GraphqlRequest = {
  operationName: "SiteOffers",
  query: "query SiteOffers($market: MarketCode!) { offers(market: $market) { id } }",
  variables: { market: "IT" },
  headers: { "X-Request-Id": "site-0000-test" },
};

describe("the HTTP transport", () => {
  it("posts the operation as JSON to the endpoint, with the request's headers and the configured credentials", async () => {
    const { fetch, sent } = recordingFetch(() => json({ data: { offers: [] } }));
    await httpTransport("http://127.0.0.1:4626/graphql", { credentials: "include", fetch }).send(request);
    assert.equal(sent.length, 1);
    const [only] = sent;
    assert.equal(only?.url, "http://127.0.0.1:4626/graphql");
    assert.equal(only?.init.method, "POST");
    assert.equal(only?.init.credentials, "include");
    assert.equal(only?.init.cache, "no-store");
    const headers = only?.init.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["X-Request-Id"], "site-0000-test");
    assert.deepEqual(JSON.parse(String(only?.init.body)), { operationName: "SiteOffers", query: request.query, variables: { market: "IT" } });
  });

  it("reads the data, the errors, the request id of the answer and Retry-After", async () => {
    const { fetch } = recordingFetch(() => json(
      { data: null, errors: [{ message: "slow down", extensions: { code: "X" } }, "not an error"], extensions: { requestId: "from-extensions-1" } },
      { status: 429, headers: { "retry-after": "7" } },
    ));
    const answer = await httpTransport("http://api.test/graphql", { credentials: "omit", fetch }).send(request);
    assert.equal(answer.status, 429);
    assert.equal(answer.data, null);
    assert.deepEqual(answer.errors, [{ message: "slow down", extensions: { code: "X" } }]);
    assert.equal(answer.requestId, "from-extensions-1");
    assert.equal(answer.retryAfter, 7);
  });

  it("prefers the X-Request-Id header to the extensions", async () => {
    const { fetch } = recordingFetch(() => json({ data: {}, extensions: { requestId: "from-extensions-2" } }, { headers: { "x-request-id": "from-header-2" } }));
    const answer = await httpTransport("http://api.test/graphql", { credentials: "omit", fetch }).send(request);
    assert.equal(answer.requestId, "from-header-2");
  });

  it("reads a body that is not JSON as no data", async () => {
    const { fetch } = recordingFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const answer = await httpTransport("http://api.test/graphql", { credentials: "omit", fetch }).send(request);
    assert.deepEqual({ status: answer.status, data: answer.data, errors: answer.errors }, { status: 502, data: null, errors: [] });
  });

  it("turns a request that never got an answer into a TransportFailure", async () => {
    const fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    await assert.rejects(httpTransport("http://api.test/graphql", { credentials: "omit", fetch }).send(request), TransportFailure);
  });

  it("lets an abort through as an abort", async () => {
    const controller = new AbortController();
    const fetch = (async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as typeof globalThis.fetch;
    await assert.rejects(
      httpTransport("http://api.test/graphql", { credentials: "omit", fetch }).send(request, controller.signal),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
  });
});

/** A transport that records the requests and answers with what the test gives it. */
function fakeTransport(answer: (request: GraphqlRequest) => GraphqlResponse | Promise<GraphqlResponse>): Transport & { requests: GraphqlRequest[] } {
  const requests: GraphqlRequest[] = [];
  return {
    requests,
    async send(sent) {
      requests.push(sent);
      return answer(sent);
    },
  };
}

const ok = (data: unknown): GraphqlResponse => ({ status: 200, data, errors: [], requestId: null, retryAfter: null });

describe("the site's API", () => {
  it("gives every request a new request id of the shape the gateway accepts", async () => {
    const transport = fakeTransport(() => ok({ offers: [] }));
    const api = createSiteApi(transport);
    await api.query(SiteOffers, { market: "IT" });
    await api.query(SiteOffers, { market: "IT" });
    const ids = transport.requests.map((sent) => sent.headers["X-Request-Id"] ?? "");
    assert.equal(ids.length, 2);
    for (const id of ids) assert.match(id, ID_SHAPE);
    assert.notEqual(ids[0], ids[1]);
  });

  it("sends the operation's own text and name", async () => {
    const transport = fakeTransport(() => ok({ offers: [] }));
    await createSiteApi(transport).query(SiteOffers, { market: "FR" });
    assert.deepEqual(
      { name: transport.requests[0]?.operationName, query: transport.requests[0]?.query, variables: transport.requests[0]?.variables },
      { name: "SiteOffers", query: SiteOffers.text, variables: { market: "FR" } },
    );
  });

  it("sends the action's idempotency key and the session's CSRF token with a mutation, never with a query", async () => {
    const transport = fakeTransport((sent) => ok(sent.operationName === "SiteOffers" ? { offers: [] } : { requestQuote: { __typename: "QuoteRefusal", code: "NOT_AVAILABLE", reason: "no" } }));
    const api = createSiteApi(transport, { csrfToken: () => "csrf-token-1" });
    await api.query(SiteOffers, { market: "IT" });
    await api.mutate(SiteRequestQuote, { plan: "student", market: "IT", offerId: "1" }, { idempotencyKey: "site-action-key-1" });
    const [query, mutation] = transport.requests;
    assert.equal(query?.headers["Idempotency-Key"], undefined);
    assert.equal(query?.headers["X-CSRF-Token"], undefined);
    assert.equal(mutation?.headers["Idempotency-Key"], "site-action-key-1");
    assert.equal(mutation?.headers["X-CSRF-Token"], "csrf-token-1");
  });

  it("sends no Idempotency-Key for a mutation that needs none, and no CSRF token without a session", async () => {
    const transport = fakeTransport(() => ok({ requestQuote: { __typename: "QuoteRefusal", code: "NOT_AVAILABLE", reason: "no" } }));
    await createSiteApi(transport).mutate(SiteRequestQuote, { plan: "student", market: "IT", offerId: null }, { idempotencyKey: null });
    assert.deepEqual(Object.keys(transport.requests[0]?.headers ?? {}), ["X-Request-Id"]);
  });

  it("returns a business refusal as data, not as an error", async () => {
    const refusal = { __typename: "QuoteRefusal", code: "NOT_ELIGIBLE", reason: "This offer is for new subscribers." };
    const api = createSiteApi(fakeTransport(() => ok({ requestQuote: refusal })));
    const answer = await api.mutate(SiteRequestQuote, { plan: "student", market: "IT", offerId: "1" }, { idempotencyKey: newIdempotencyKey() });
    assert.deepEqual(answer.requestQuote, refusal);
  });

  const failures: Array<[string, GraphqlResponse | "unreachable", string, boolean]> = [
    ["the engine is down", { status: 200, data: null, errors: [{ message: "engine", extensions: { code: "ENGINE_UNAVAILABLE" } }], requestId: "r-engine-1", retryAfter: null }, "ENGINE_UNAVAILABLE", true],
    ["a malformed request", { status: 400, data: null, errors: [{ message: "bad", extensions: { code: "BAD_USER_INPUT" } }], requestId: "r-bad-1", retryAfter: null }, "BAD_USER_INPUT", false],
    ["nothing found", { status: 200, data: null, errors: [{ message: "gone", extensions: { code: "NOT_FOUND" } }], requestId: null, retryAfter: null }, "NOT_FOUND", false],
    ["no session", { status: 200, data: null, errors: [{ message: "who", extensions: { code: "UNAUTHENTICATED" } }], requestId: null, retryAfter: null }, "UNAUTHENTICATED", false],
    ["a code the site does not know", { status: 200, data: null, errors: [{ message: "odd", extensions: { code: "SOMETHING_NEW" } }], requestId: null, retryAfter: null }, "INTERNAL", false],
    ["an error without a code", { status: 500, data: null, errors: [{ message: "boom" }], requestId: null, retryAfter: null }, "INTERNAL", false],
    ["too many requests", { status: 429, data: null, errors: [], requestId: null, retryAfter: 12 }, "RATE_LIMITED", true],
    ["an answer without data", { status: 502, data: null, errors: [], requestId: null, retryAfter: null }, "INTERNAL", false],
    ["the API cannot be reached", "unreachable", "UNREACHABLE", true],
  ];
  for (const [what, answer, code, transient] of failures) {
    it(`turns ${what} into an ApiError ${code}${transient ? ", worth asking again" : ""}`, async () => {
      const transport = fakeTransport(() => {
        if (answer === "unreachable") throw new TransportFailure("Failed to fetch");
        return answer;
      });
      const caught = await createSiteApi(transport).query(SiteOffers, { market: "IT" }).then(() => null, (error: unknown) => error);
      assert.ok(caught instanceof ApiError, `an ApiError, not ${String(caught)}`);
      assert.equal(caught.code, code);
      assert.equal(caught.transient, transient);
      // The reference the page shows: the answer's request id, or the one the site sent.
      const sent = transport.requests[0]?.headers["X-Request-Id"];
      assert.equal(caught.requestId, answer !== "unreachable" && answer.requestId ? answer.requestId : sent);
      if (code === "RATE_LIMITED") assert.equal(caught.retryAfter, 12);
    });
  }
});

describe("the site's identifiers", () => {
  it("are new every time and fit the gateway's shape", () => {
    const made = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const id of [newRequestId(), newIdempotencyKey()]) {
        assert.match(id, ID_SHAPE);
        made.add(id);
      }
    }
    assert.equal(made.size, 400);
  });

  it("say where they come from", () => {
    assert.match(newRequestId(), /^site-[0-9a-f-]{36}$/);
    assert.match(newIdempotencyKey(), /^site-action-[0-9a-f-]{36}$/);
  });
});

describe("the keys of what a visitor may send more than once", () => {
  const numbered = () => {
    let made = 0;
    return () => `key-${(made += 1)}`;
  };

  it("sends a key again only to retry an attempt whose outcome is unknown, one key for each thing sent", () => {
    const keys = new ActionKeys<string>(numbered());
    assert.equal(keys.key("K7QM-3XTP-9WAD"), "key-1");
    assert.equal(keys.key("K7QM-3XTP-9WAD"), "key-1", "a retry after an error sends the same key");
    assert.equal(keys.key("ABCD-EFGH-JKMN"), "key-2", "another code, another key");
  });

  it("takes a new key after a definitive answer, success or refusal, and only for what was answered", () => {
    const keys = new ActionKeys<"yes" | "no">(numbered());
    keys.key("yes");
    keys.key("no");
    keys.answered("yes");
    assert.equal(keys.key("yes"), "key-3");
    assert.equal(keys.key("no"), "key-2");
    assert.match(new ActionKeys<string>().key("any"), /^site-action-[0-9a-f-]{36}$/, "by default, the site's own keys");
  });

  it("against an engine that answers a key with its first answer, lets a code refused while its payment was pending through once it settled", () => {
    // As the engine does: a key's answer is kept and given back to that key.
    let settled = false;
    const kept = new Map<string, string>();
    const engine = (key: string) => {
      if (!kept.has(key)) kept.set(key, settled ? "activated" : "refused: its payment is not settled yet");
      return kept.get(key);
    };
    const keys = new ActionKeys<string>(numbered());
    const send = (code: string) => {
      const answer = engine(keys.key(code));
      keys.answered(code);
      return answer;
    };
    assert.equal(send("K7QM-3XTP-9WAD"), "refused: its payment is not settled yet");
    settled = true;
    assert.equal(send("K7QM-3XTP-9WAD"), "activated");
  });
});
