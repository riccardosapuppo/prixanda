// How the console talks to the gateway: the HTTP transport (headers, the
// session's cookie, failures said as codes), the client (data, or an error
// with the gateway's code and the request id), and the idempotency key of an
// action, kept until the action's outcome is known.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Operation } from "../src/graphql/operation.ts";
import { ActionKey, runAction, stableText } from "../src/lib/action-key.ts";
import { createGatewayClient, explain, GatewayError, type GraphQLRequest, type GraphQLTransport, httpTransport } from "../src/lib/gateway.ts";
import { ID_SHAPE, newIdempotencyKey, newRequestId } from "../src/lib/ids.ts";

const READ: Operation<{ readonly ok: boolean }, Record<string, never>> = { name: "Read", kind: "query", text: "query Read { ok }" };
const CREATE: Operation<{ readonly id: string }, { readonly title: string }> = { name: "CreateOffer", kind: "mutation", text: "mutation CreateOffer($title: String!) { id }" };

type Seen = { url: string; init: RequestInit };

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const record = { url: String(input), init: init ?? {} };
      seen.push(record);
      return respond(record);
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("the HTTP transport", () => {
  it("posts the operation with the request id, the action's key, the CSRF token and the session cookie", async () => {
    const fake = fakeFetch(() => json({ data: { ok: true }, extensions: { requestId: "console:abc12345" } }));
    const transport = httpTransport("http://127.0.0.1:4621/graphql", fake.fetch);
    const result = await transport.execute({ operationName: "CreateOffer", query: CREATE.text, variables: { title: "A" }, requestId: "console:abc12345", idempotencyKey: "create:1234-5678", csrfToken: "token" });
    assert.deepEqual(result.data, { ok: true });
    const sent = fake.seen[0];
    assert.ok(sent);
    assert.equal(sent.init.method, "POST");
    assert.equal(sent.init.credentials, "include");
    const headers = sent.init.headers as Record<string, string>;
    assert.equal(headers["x-request-id"], "console:abc12345");
    assert.equal(headers["idempotency-key"], "create:1234-5678");
    assert.equal(headers["x-csrf-token"], "token");
    assert.equal(headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(String(sent.init.body)), { query: CREATE.text, variables: { title: "A" }, operationName: "CreateOffer" });
  });

  it("a gateway that does not answer is UNREACHABLE; an answer it cannot read is BAD_RESPONSE", async () => {
    const down = httpTransport("http://127.0.0.1:1/graphql", async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(down.execute({ operationName: "Read", query: READ.text, variables: {}, requestId: "console:x1234567" }), (error) => error instanceof GatewayError && error.code === "UNREACHABLE");
    const cut = httpTransport("http://127.0.0.1:4621/graphql", fakeFetch(() => new Response("{\"data\": {\"crea", { status: 200 })).fetch);
    await assert.rejects(cut.execute({ operationName: "Read", query: READ.text, variables: {}, requestId: "console:x1234567" }), (error) => error instanceof GatewayError && error.code === "BAD_RESPONSE");
  });

  it("passes on the seconds a 429 asks to wait", async () => {
    const transport = httpTransport("http://127.0.0.1:4621/graphql", fakeFetch(() => json({ errors: [{ message: "Too many", extensions: { code: "RATE_LIMITED" } }] }, 429, { "retry-after": "7" })).fetch);
    const result = await transport.execute({ operationName: "Read", query: READ.text, variables: {}, requestId: "console:x1234567" });
    assert.equal(result.retryAfterSeconds, 7);
    assert.equal(result.status, 429);
  });
});

function scripted(answers: ((request: GraphQLRequest) => unknown)[]): { transport: GraphQLTransport; requests: GraphQLRequest[] } {
  const requests: GraphQLRequest[] = [];
  return {
    requests,
    transport: {
      async execute(request) {
        requests.push(request);
        const next = answers.shift();
        if (!next) throw new Error("no more answers");
        const answer = next(request);
        if (answer instanceof Error) throw answer;
        return answer as never;
      },
    },
  };
}

describe("the gateway client", () => {
  it("returns the data, and sends the CSRF token with mutations only", async () => {
    const { transport, requests } = scripted([() => ({ data: { ok: true } }), () => ({ data: { id: "7" } })]);
    const client = createGatewayClient({ transport, csrfToken: () => "token", newRequestId });
    assert.deepEqual(await client.run(READ, {}), { ok: true });
    assert.deepEqual(await client.run(CREATE, { title: "A" }, { idempotencyKey: "create:12345678" }), { id: "7" });
    assert.equal(requests[0]?.csrfToken, undefined);
    assert.equal(requests[1]?.csrfToken, "token");
    assert.match(requests[0]?.requestId ?? "", ID_SHAPE);
  });

  it("turns the first error into a GatewayError with its code and the request id", async () => {
    const { transport } = scripted([() => ({ errors: [{ message: "Revenue is for finance.", extensions: { code: "FORBIDDEN" } }], extensions: { requestId: "gw:12345678" } })]);
    const client = createGatewayClient({ transport, csrfToken: () => null, newRequestId });
    await assert.rejects(client.run(READ, {}), (error) => error instanceof GatewayError && error.code === "FORBIDDEN" && error.requestId === "gw:12345678");
  });

  it("refuses to send a mutation without its action's key", async () => {
    const { transport } = scripted([() => ({ data: { id: "1" } })]);
    const client = createGatewayClient({ transport, csrfToken: () => null, newRequestId });
    await assert.rejects(client.run(CREATE, { title: "A" }), /give it the action's idempotency key/);
  });

  it("says what happened and what to do, for every code", () => {
    for (const code of ["UNREACHABLE", "ENGINE_UNAVAILABLE", "RATE_LIMITED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "BAD_USER_INPUT", "BAD_RESPONSE", "INTERNAL_SERVER_ERROR"] as const) {
      const said = explain(new GatewayError(code, "detail", "console:12345678", 3));
      assert.ok(said.title.length > 10, code);
      assert.equal(said.requestId, "console:12345678");
    }
  });
});

describe("an action keeps its idempotency key until its outcome is known", () => {
  it("retrying after a broken answer sends the same key, so the engine replays instead of creating twice", async () => {
    const broken = new GatewayError("BAD_RESPONSE", "The gateway answered 200 without a GraphQL result.", "console:12345678");
    const { transport, requests } = scripted([() => broken, () => ({ data: { id: "7" } })]);
    const client = createGatewayClient({ transport, csrfToken: () => "token", newRequestId });
    const keys = new ActionKey("create-offer");
    await assert.rejects(runAction(client, CREATE, { title: "Student Autumn Pass" }, keys));
    assert.equal(await runAction(client, CREATE, { title: "Student Autumn Pass" }, keys).then((data) => data.id), "7");
    assert.ok(requests[0]?.idempotencyKey);
    assert.equal(requests[1]?.idempotencyKey, requests[0]?.idempotencyKey);
  });

  it("keeps it after every other failure too: no answer, an engine that did not answer, a 429", async () => {
    for (const code of ["UNREACHABLE", "ENGINE_UNAVAILABLE", "RATE_LIMITED", "INTERNAL_SERVER_ERROR"] as const) {
      const keys = new ActionKey("approve-change");
      const { transport, requests } = scripted([() => new GatewayError(code, "failed", "console:12345678"), () => ({ data: { id: "1" } })]);
      const client = createGatewayClient({ transport, csrfToken: () => null, newRequestId });
      await assert.rejects(runAction(client, CREATE, { title: "A" }, keys));
      await runAction(client, CREATE, { title: "A" }, keys);
      assert.equal(requests[1]?.idempotencyKey, requests[0]?.idempotencyKey, code);
    }
  });

  it("a refusal is an answer too: approving again after a stale version, or scheduling again, goes with a new key", async () => {
    // The engine keeps a refusal under its key: the same key would get the same refusal back, whatever changed since.
    const refused = { data: { approveChange: { __typename: "Refusal", code: "STALE_VERSION", reason: "Version 3 was saved after the version you signed." } } };
    const { transport, requests } = scripted([() => refused, () => ({ data: { approveChange: { __typename: "Change", state: "APPROVED" } } })]);
    const client = createGatewayClient({ transport, csrfToken: () => "token", newRequestId });
    const keys = new ActionKey("approve-change");
    const approve = { title: "the same variables, the same request" };
    await runAction(client, CREATE, approve, keys);
    await runAction(client, CREATE, approve, keys);
    assert.ok(requests[0]?.idempotencyKey && requests[1]?.idempotencyKey);
    assert.notEqual(requests[1]?.idempotencyKey, requests[0]?.idempotencyKey);
  });

  it("an answer closes the action: the next one gets a new key; another request gets another key", async () => {
    const keys = new ActionKey("save", (action) => `${action}:${Math.random().toString(36).slice(2, 12)}`);
    const first = keys.keyFor({ title: "A" });
    assert.equal(keys.keyFor({ title: "A" }), first);
    const other = keys.keyFor({ title: "B" });
    assert.notEqual(other, first);
    keys.answered();
    assert.equal(keys.pending, null);
    assert.notEqual(keys.keyFor({ title: "B" }), other);
  });

  it("the same variables in another order are the same request", () => {
    assert.equal(stableText({ b: 1, a: { d: [1, 2], c: null } }), stableText({ a: { c: null, d: [1, 2] }, b: 1 }));
  });

  it("makes ids the gateway accepts", () => {
    assert.match(newRequestId(), ID_SHAPE);
    assert.match(newIdempotencyKey("approve-change"), ID_SHAPE);
    assert.match(newIdempotencyKey("--"), ID_SHAPE);
  });
});
