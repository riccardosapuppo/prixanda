// The console in the demo's sandbox (src/lib/sandbox.ts), over the sandbox's
// own client (sandbox/client) and a fake worker that speaks the protocol of
// packages/sandbox: the console's requests go to the internal API with the
// gateway's headers and come back as the HTTP transport reads the gateway's;
// a worker that failed is a gateway that does not answer; the demo's
// commands give their result or the worker's words; and what the console
// reads again after a change names its own operations.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { connectBackend, type Port } from "sandbox/client";
import { CHANGES } from "sandbox/protocol";
import { createGatewayClient, GatewayError } from "../src/lib/gateway.ts";
import { openSandbox, READ_AGAIN, runCommand, type Sandbox, sandboxTransport } from "../src/lib/sandbox.ts";

type Listener = (event: { readonly data: unknown }) => void;

/** A worker on the other side of a port: it records what the tab sent, and answers each request with what the test gives. */
function fakeWorker(answer: (sent: Record<string, unknown>) => { status: number; headers?: Record<string, string>; body: string } | null = () => null) {
  const sent: Record<string, unknown>[] = [];
  let listener: Listener = () => undefined;
  const speak = (data: unknown) => listener({ data });
  const port: Port = {
    postMessage(message) {
      const entry = message as Record<string, unknown>;
      sent.push(entry);
      if (entry["kind"] === "hello") return;
      const reply = answer(entry);
      if (reply !== null) queueMicrotask(() => speak({ kind: "reply", id: entry["id"], status: reply.status, headers: reply.headers ?? {}, body: reply.body }));
    },
    addEventListener: (_type, given) => {
      listener = given;
    },
  };
  return { port, sent, speak };
}

const READY = { kind: "ready", info: { bootMs: 4200, alreadyRunning: false, build: "b1", now: "2026-10-26T08:00:00Z" } };

/** The console's tab, as openSandbox opens it in a browser: the console's app, this build. */
function consoleTab(answer?: Parameters<typeof fakeWorker>[0]): { sandbox: Sandbox; sent: Record<string, unknown>[]; speak: (data: unknown) => void } {
  const worker = fakeWorker(answer);
  const sandbox = connectBackend(worker.port, { app: "console", build: "b1" });
  return { sandbox, sent: worker.sent, speak: worker.speak };
}

describe("the console's tab of the demo", () => {
  it("is still starting while the page is built, without a browser", () => {
    assert.deepEqual(openSandbox("b1").status(), { state: "starting", step: null, done: 0, of: 0 });
  });

  it("says hello as the console, and asks the internal API once the worker is ready", async () => {
    const tab = consoleTab(() => ({ status: 200, body: JSON.stringify({ data: { ok: true } }) }));
    assert.deepEqual(tab.sent.slice(), [{ kind: "hello", app: "console", build: "b1" }]);
    tab.speak(READY);
    const client = createGatewayClient({ transport: sandboxTransport(tab.sandbox), csrfToken: () => "csrf-1", newRequestId: () => "console:r1" });
    assert.deepEqual(await client.run({ name: "Approve", kind: "mutation", text: "mutation Approve { ok }" }, {}, { idempotencyKey: "approve-change:k1" }), { ok: true });
    const request = tab.sent.find((message) => message["kind"] === "graphql");
    assert.equal(request?.["api"], "internal");
    assert.deepEqual(request?.["headers"], {
      "content-type": "application/json", accept: "application/json", "x-request-id": "console:r1", "idempotency-key": "approve-change:k1", "x-csrf-token": "csrf-1",
    });
    assert.deepEqual(JSON.parse(String(request?.["body"])), { query: "mutation Approve { ok }", variables: {}, operationName: "Approve" });
  });
});

describe("the console's requests through the worker", () => {
  it("turn the gateway's errors into the console's, with their code", async () => {
    const tab = consoleTab(() => ({ status: 200, body: JSON.stringify({ errors: [{ message: "This role cannot read this.", extensions: { code: "FORBIDDEN" } }] }) }));
    tab.speak(READY);
    const client = createGatewayClient({ transport: sandboxTransport(tab.sandbox), csrfToken: () => null, newRequestId: () => "console:r2" });
    await assert.rejects(client.run({ name: "Home", kind: "query", text: "query Home { x }" }, {}), (error) => error instanceof GatewayError && error.code === "FORBIDDEN");
  });

  it("say the demo's engine did not answer when the worker failed to start, in its words", async () => {
    const tab = consoleTab();
    tab.speak({ kind: "failed", reason: "IndexedDB refused in a private window" });
    const client = createGatewayClient({ transport: sandboxTransport(tab.sandbox), csrfToken: () => null, newRequestId: () => "console:r3" });
    await assert.rejects(client.run({ name: "People", kind: "query", text: "query People { x }" }, {}),
      (error) => error instanceof GatewayError && error.code === "UNREACHABLE" && /did not answer: IndexedDB refused in a private window\./.test(error.message));
  });

  it("say so when the worker answers without a GraphQL result", async () => {
    const tab = consoleTab(() => ({ status: 500, body: "not json" }));
    tab.speak(READY);
    const client = createGatewayClient({ transport: sandboxTransport(tab.sandbox), csrfToken: () => null, newRequestId: () => "console:r4" });
    await assert.rejects(client.run({ name: "People", kind: "query", text: "query People { x }" }, {}), (error) => error instanceof GatewayError && error.code === "BAD_RESPONSE");
  });
});

describe("the demo's commands", () => {
  it("give their result, or the worker's words when one cannot be done now", async () => {
    const tab = consoleTab((message) => {
      if (message["name"] === "arm-fault") return { status: 200, body: JSON.stringify({ armed: "publish" }) };
      if (message["name"] === "skip-to-next-launch") return { status: 200, body: JSON.stringify({ from: "2026-10-26T08:00:00Z", to: "2026-11-02T08:00:00Z", changed: ["catalog", "changes", "launches", "audit"] }) };
      return { status: 409, body: JSON.stringify({ error: "No launch is due on the demo's clock." }) };
    });
    tab.speak(READY);
    assert.deepEqual(await runCommand(tab.sandbox, "arm-fault", { step: "publish" }), { ok: true, result: { armed: "publish" } });
    assert.deepEqual(tab.sent.find((message) => message["name"] === "arm-fault")?.["args"], { step: "publish" });
    const skipped = await runCommand(tab.sandbox, "skip-to-next-launch");
    assert.ok(skipped.ok);
    assert.deepEqual([skipped.result.from, skipped.result.to, skipped.result.changed], ["2026-10-26T08:00:00Z", "2026-11-02T08:00:00Z", ["catalog", "changes", "launches", "audit"]]);
    assert.deepEqual(await runCommand(tab.sandbox, "clear-fault"), { ok: false, status: 409, error: "No launch is due on the demo's clock." });
  });
});

describe("what the console reads again", () => {
  it("names, for every change the worker reports, operations the console has", () => {
    const folder = new URL("../src/graphql/operations/", import.meta.url);
    const operations = new Set(readdirSync(folder).flatMap((file) => [...readFileSync(new URL(file, folder), "utf8").matchAll(/^(?:query|mutation) (\w+)/gm)].map((match) => match[1])));
    for (const kind of CHANGES) {
      assert.ok(READ_AGAIN[kind].length > 0, kind);
      for (const name of READ_AGAIN[kind]) assert.ok(operations.has(name), `${kind}: ${name} is not an operation of the console`);
    }
    assert.ok(READ_AGAIN.launches.includes("LaunchRun") && READ_AGAIN.launches.includes("Changes"));
  });
});
