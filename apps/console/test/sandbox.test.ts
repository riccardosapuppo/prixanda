// The console in the demo's sandbox (src/lib/sandbox.ts), against a fake
// worker that speaks the protocol of packages/sandbox: the tab says hello as
// the console, waits for ready, sends its requests to the internal API with
// the gateway's headers and reads the replies as the HTTP transport reads the
// gateway's; it says the steps of the start, refuses another build's worker,
// passes on what changed and the reset, and runs the demo's commands.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGatewayClient, GatewayError } from "../src/lib/gateway.ts";
import { connectSandbox, missingInBrowser, type Port, READ_AGAIN, runCommand, type Sandbox, sandboxTransport } from "../src/lib/sandbox.ts";
import { CHANGES } from "sandbox/protocol";

type Listener = (event: { readonly data: unknown }) => void;

/** A worker on the other side of a port: it records what the tab sent, and speaks when the test says. */
function fakeWorker() {
  const sent: Record<string, unknown>[] = [];
  let listener: Listener = () => undefined;
  const port: Port = {
    postMessage: (message) => sent.push(message as Record<string, unknown>),
    addEventListener: (_type, given) => {
      listener = given;
    },
  };
  return { port, sent, speak: (data: unknown) => listener({ data }) };
}

const READY = { kind: "ready", info: { bootMs: 4200, alreadyRunning: false, build: "b1", now: "2026-10-26T08:00:00Z" } };
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("the console's tab of the demo", () => {
  it("says hello as the console, and sends nothing else before the worker is ready", async () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    assert.deepEqual(worker.sent, [{ kind: "hello", app: "console", build: "b1" }]);
    const asked = sandbox.graphql({}, "{}");
    await tick();
    assert.equal(worker.sent.length, 1, "a request waits for ready");
    worker.speak(READY);
    await tick();
    assert.equal(worker.sent[1]?.["kind"], "graphql");
    assert.equal(worker.sent[1]?.["api"], "internal");
    worker.speak({ kind: "reply", id: worker.sent[1]?.["id"], status: 200, headers: {}, body: "{}" });
    assert.deepEqual(await asked, { status: 200, headers: {}, body: "{}" });
  });

  it("shows the worker's steps while it starts, then ready", () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    const seen: string[] = [];
    sandbox.subscribe(() => seen.push(sandbox.status().state));
    worker.speak({ kind: "progress", step: "Loading Python", done: 1, of: 5 });
    assert.deepEqual(sandbox.status(), { state: "starting", step: "Loading Python", done: 1, of: 5 });
    worker.speak(READY);
    assert.equal(sandbox.status().state, "ready");
    // A message of the wrong shape is no message.
    worker.speak({ kind: "progress", step: 3 });
    assert.deepEqual(seen, ["starting", "ready"]);
  });

  it("refuses a worker of another build, and every request with it", async () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    worker.speak({ ...READY, info: { ...READY.info, build: "b2" } });
    assert.equal(sandbox.status().state, "other-build");
    await assert.rejects(sandbox.graphql({}, "{}"), /another version of the demo/);
  });

  it("passes on what the engine's jobs changed, and the reset", () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    const changed: string[][] = [];
    let resets = 0;
    sandbox.onChanged((what) => changed.push([...what]));
    sandbox.onReset(() => {
      resets += 1;
    });
    worker.speak({ kind: "changed", what: ["launches", "catalog"] });
    worker.speak({ kind: "changed", what: ["nothing-known"] });
    worker.speak({ kind: "reset" });
    assert.deepEqual(changed, [["launches", "catalog"]]);
    assert.equal(resets, 1);
  });

  it("reads again, for each change the worker names, the console's own queries", () => {
    for (const kind of CHANGES) assert.ok(READ_AGAIN[kind].length > 0, kind);
    assert.ok(READ_AGAIN.launches.includes("LaunchRun") && READ_AGAIN.launches.includes("Changes"));
    assert.ok(READ_AGAIN.audit.includes("AuditEvents"));
  });
});

/** A sandbox already ready, whose worker answers each request with what the test gives. */
function readySandbox(answer: (sent: Record<string, unknown>) => { status: number; headers?: Record<string, string>; body: string }): { sandbox: Sandbox; sent: Record<string, unknown>[] } {
  const worker = fakeWorker();
  const sandbox = connectSandbox(worker.port, { build: "b1" });
  worker.speak(READY);
  const post = worker.port.postMessage;
  worker.port.postMessage = (message) => {
    post(message);
    const sent = message as Record<string, unknown>;
    if (sent["kind"] === "hello") return;
    const reply = answer(sent);
    queueMicrotask(() => worker.speak({ kind: "reply", id: sent["id"], status: reply.status, headers: reply.headers ?? {}, body: reply.body }));
  };
  return { sandbox, sent: worker.sent };
}

describe("the console's requests through the worker", () => {
  it("carry the request id, the action's key and the CSRF token as the gateway reads them, and come back as data", async () => {
    const { sandbox, sent } = readySandbox(() => ({ status: 200, body: JSON.stringify({ data: { ok: true } }) }));
    const client = createGatewayClient({ transport: sandboxTransport(sandbox), csrfToken: () => "csrf-1", newRequestId: () => "console:r1" });
    const data = await client.run({ name: "Approve", kind: "mutation", text: "mutation Approve { ok }" }, {}, { idempotencyKey: "approve-change:k1" });
    assert.deepEqual(data, { ok: true });
    const request = sent.find((message) => message["kind"] === "graphql");
    assert.deepEqual(request?.["headers"], {
      "content-type": "application/json", accept: "application/json", "x-request-id": "console:r1", "idempotency-key": "approve-change:k1", "x-csrf-token": "csrf-1",
    });
    assert.deepEqual(JSON.parse(String(request?.["body"])), { query: "mutation Approve { ok }", variables: {}, operationName: "Approve" });
  });

  it("turns the gateway's errors into the console's, with their code", async () => {
    const { sandbox } = readySandbox(() => ({ status: 200, body: JSON.stringify({ errors: [{ message: "This role cannot read this.", extensions: { code: "FORBIDDEN" } }] }) }));
    const client = createGatewayClient({ transport: sandboxTransport(sandbox), csrfToken: () => null, newRequestId: () => "console:r2" });
    await assert.rejects(client.run({ name: "Home", kind: "query", text: "query Home { x }" }, {}), (error) => error instanceof GatewayError && error.code === "FORBIDDEN");
  });

  it("says the demo's engine did not answer when the worker failed to start", async () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    worker.speak({ kind: "failed", reason: "IndexedDB refused in a private window" });
    const client = createGatewayClient({ transport: sandboxTransport(sandbox), csrfToken: () => null, newRequestId: () => "console:r3" });
    await assert.rejects(client.run({ name: "People", kind: "query", text: "query People { x }" }, {}), (error) => error instanceof GatewayError && error.code === "UNREACHABLE" && /private window/.test(error.message));
  });
});

describe("the demo's commands", () => {
  it("returns a command's result, and the worker's words when it cannot be done now", async () => {
    const { sandbox, sent } = readySandbox((message) => message["name"] === "arm-fault"
      ? { status: 200, body: JSON.stringify({ armed: "publish" }) }
      : { status: 409, body: JSON.stringify({ error: "No launch is due on the demo's clock." }) });
    assert.deepEqual(await runCommand(sandbox, "arm-fault", { step: "publish" }), { ok: true, result: { armed: "publish" } });
    assert.deepEqual(sent.find((message) => message["name"] === "arm-fault")?.["args"], { step: "publish" });
    assert.deepEqual(await runCommand(sandbox, "skip-to-next-launch"), { ok: false, status: 409, error: "No launch is due on the demo's clock." });
    assert.equal(sent.find((message) => message["name"] === "skip-to-next-launch")?.["args"], undefined);
  });
});

describe("what a browser needs for the demo", () => {
  it("names the first thing missing", () => {
    const all = { WebAssembly: {}, indexedDB: {}, SharedWorker: class {}, Worker: class {} };
    assert.equal(missingInBrowser(all), null);
    assert.equal(missingInBrowser({ ...all, WebAssembly: undefined }), "WebAssembly");
    assert.equal(missingInBrowser({ ...all, indexedDB: null }), "IndexedDB");
    assert.equal(missingInBrowser({ WebAssembly: {}, indexedDB: {} }), "Web Workers");
    // A dedicated worker is enough (Chrome on Android): one tab at a time.
    assert.equal(missingInBrowser({ WebAssembly: {}, indexedDB: {}, Worker: class {} }), null);
  });
});
