// The request id (§11.1): born in the console or the site, kept by the
// gateway when well formed and made new otherwise, sent to the engine with
// every call of the request, returned in X-Request-Id and in the response's
// extensions, written in the gateway's log and, by the engine, in the audit
// log.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CONSOLE_ORIGIN, type Harness, startHarness } from "./support/harness.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let harness: Harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness.close();
});

describe("a well-formed request id", () => {
  test("is kept: in the header, the extensions, every engine call and the log line", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    harness.engine.clearCalls();
    const answer = await client.graphql("{ changes { nodes { id details { title } } } markets { code } }", { headers: { "x-request-id": "console-7f3a-0001" } });
    assert.equal(answer.headers["x-request-id"], "console-7f3a-0001");
    assert.equal(answer.body.extensions.requestId, "console-7f3a-0001");
    assert.ok(harness.engine.count() >= 2);
    assert.deepEqual([...new Set(harness.engine.calls.map((call) => call.requestId))], ["console-7f3a-0001"]);
    const line = harness.logs.find((entry) => entry["msg"] === "request" && entry["requestId"] === "console-7f3a-0001");
    assert.ok(line, "the log has the request");
    assert.equal(line["status"], 200);
    assert.equal(line["person"], "marketing-1");
    assert.equal(line["engineCalls"], harness.engine.count());
  });

  test("reaches the audit log through the engine (§11.1)", async () => {
    const lead = harness.console();
    await lead.signIn("commercial-lead-1");
    const created = await lead.graphql(`mutation { createListPrice(listPrice: { title: "x", plan: "duo", market: "IT", amount: { amountMinor: "1500", currency: "EUR" }, startsLocal: "2027-01-01T00:00" }) { __typename } }`, {
      headers: { "x-request-id": "console-audit-0001" },
    });
    assert.equal(created.body.data.createListPrice.__typename, "Change", created.text);
    const auditor = harness.console();
    await auditor.signIn("auditor-1");
    const log = await auditor.graphql('{ auditEvents(filter: { action: "change.created" }) { nodes { requestId actor actorRole } } }');
    assert.deepEqual(log.body.data.auditEvents.nodes[0], { requestId: "console-audit-0001", actor: "commercial-lead-1", actorRole: "COMMERCIAL_LEAD" }, log.text);
  });
});

describe("a missing or malformed request id", () => {
  for (const [what, header] of [["missing", undefined], ["too short", "abc"], ["with spaces", "has spaces in it"], ["too long", "r".repeat(101)], ["starting with a dot", ".hidden-request"]] as const) {
    test(`${what}: a new UUID takes its place, and the engine never sees the bad one`, async () => {
      const client = harness.console();
      await client.signIn("auditor-1");
      harness.engine.clearCalls();
      const answer = await client.graphql("{ changes { nodes { id } } }", header === undefined ? {} : { headers: { "x-request-id": header } });
      const id = String(answer.headers["x-request-id"]);
      assert.match(id, UUID);
      assert.equal(answer.body.extensions.requestId, id);
      assert.deepEqual(harness.engine.calls.map((call) => call.requestId), [id]);
    });
  }

  test("two requests without one get two different ids", async () => {
    const client = harness.console();
    const first = await client.graphql("{ people { id } }");
    const second = await client.graphql("{ people { id } }");
    assert.notEqual(first.headers["x-request-id"], second.headers["x-request-id"]);
  });
});

describe("answers that never reach GraphQL carry the id too", () => {
  test("a wrong path, a wrong content type, a refused origin", async () => {
    const client = harness.console();
    const cases = [
      await client.raw({ method: "GET", path: "/nothing", headers: { "x-request-id": "outside-0000001" } }),
      await client.raw({ headers: { "content-type": "text/plain", "x-request-id": "outside-0000002" }, body: "{}" }),
      await client.raw({ headers: { "content-type": "application/json", origin: "http://evil.test", "x-request-id": "outside-0000003" }, body: "{}" }),
    ];
    assert.deepEqual(cases.map((answer) => answer.status), [404, 415, 403]);
    assert.deepEqual(cases.map((answer) => answer.headers["x-request-id"]), ["outside-0000001", "outside-0000002", "outside-0000003"]);
    assert.deepEqual(cases.map((answer) => answer.body.extensions.requestId), ["outside-0000001", "outside-0000002", "outside-0000003"]);
  });

  test("the console's page can read it: it is an exposed header", async () => {
    const answer = await harness.console().graphql("{ people { id } }", { headers: { origin: CONSOLE_ORIGIN } });
    assert.match(String(answer.headers["access-control-expose-headers"]), /X-Request-Id/);
  });
});
