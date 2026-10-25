// The site's side of the demo's sandbox (stage 8), against the protocol of
// packages/sandbox with a fake worker: the hello, the requests held until
// the worker is ready, a request as a graphql message and its reply read like
// the gateway's, a worker of another build, a worker that fails, what changed
// read again, a reset, an abort, the commands, and what a browser lacks.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHANGES, parseToWorker, type ToWorker } from "sandbox/protocol";
import { createSiteApi } from "../src/data/api.ts";
import { connectSandbox, missingInBrowser, type Port, READ_AGAIN, sandboxTransport } from "../src/data/sandbox.ts";
import { TransportFailure } from "../src/data/transport.ts";
import { SiteMarkets } from "../src/graphql/generated.ts";

/** A worker that keeps what the tab sent, and says what the test makes it say. */
function fakeWorker() {
  const sent: ToWorker[] = [];
  let deliver: (data: unknown) => void = () => undefined;
  const port: Port = {
    postMessage(message) {
      const read = parseToWorker(message);
      assert.ok(read, `the tab sent a message the worker can read: ${JSON.stringify(message)}`);
      sent.push(read);
    },
    addEventListener(_type, listener) {
      deliver = (data) => listener({ data });
    },
  };
  return { port, sent, say: (data: unknown) => deliver(data) };
}

const READY = { kind: "ready", info: { bootMs: 3200, alreadyRunning: false, build: "b1", now: "2026-10-24T10:00:00Z" } };
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("the site's tab and the sandbox's worker", () => {
  it("says hello first, with the site and its build", () => {
    const worker = fakeWorker();
    connectSandbox(worker.port, { build: "b1" });
    assert.deepEqual(worker.sent, [{ kind: "hello", app: "site", build: "b1" }]);
  });

  it("reports the worker's steps while it starts, and holds the requests until it is ready", async () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    let changes = 0;
    sandbox.subscribe(() => (changes += 1));
    worker.say({ kind: "progress", step: "Loading Python", done: 2, of: 6 });
    assert.deepEqual(sandbox.status(), { state: "starting", step: "Loading Python", done: 2, of: 6 });
    const answer = sandboxTransport(sandbox).send({ operationName: "SiteMarkets", query: "{ markets { code } }", variables: {}, headers: { "X-Request-Id": "site-1" } });
    await tick();
    assert.equal(worker.sent.length, 1, "nothing is sent before ready");
    worker.say(READY);
    await tick();
    assert.equal(sandbox.status().state, "ready");
    assert.equal(changes, 2);
    const request = worker.sent[1];
    assert.ok(request?.kind === "graphql");
    assert.equal(request.api, "public");
    assert.deepEqual(request.headers, { "content-type": "application/json", "x-request-id": "site-1" });
    assert.deepEqual(JSON.parse(request.body), { operationName: "SiteMarkets", query: "{ markets { code } }", variables: {} });
    worker.say({ kind: "reply", id: request.id, status: 429, headers: { "x-request-id": "site-1", "retry-after": "3" }, body: JSON.stringify({ errors: [{ message: "slow down" }] }) });
    const read = await answer;
    assert.deepEqual(read, { status: 429, data: null, errors: [{ message: "slow down" }], requestId: "site-1", retryAfter: 3 });
  });

  it("carries the data layer's requests whole, as the HTTP transport does", async () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    worker.say(READY);
    const api = createSiteApi(sandboxTransport(sandbox), { csrfToken: () => null });
    const markets = api.query(SiteMarkets, {});
    await tick();
    await tick();
    const request = worker.sent.find((message) => message.kind === "graphql");
    assert.ok(request?.kind === "graphql");
    assert.match(request.headers["x-request-id"] ?? "", /^site-[0-9a-f-]{36}$/);
    worker.say({ kind: "reply", id: request.id, status: 200, headers: {}, body: JSON.stringify({ data: { markets: [] } }) });
    assert.deepEqual(await markets, { markets: [] });
  });

  it("refuses a worker of another build: the tab reloads to meet it", async () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    const waiting = sandbox.graphql({}, "{}");
    worker.say({ ...READY, info: { ...READY.info, build: "b2" } });
    await assert.rejects(waiting, TransportFailure);
    assert.equal(sandbox.status().state, "other-build");
  });

  it("says why the worker failed, and fails what waits", async () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    const waiting = sandbox.graphql({}, "{}");
    worker.say({ kind: "failed", reason: "IndexedDB is not available in a private window" });
    await assert.rejects(waiting, /IndexedDB/);
    assert.deepEqual(sandbox.status(), { state: "failed", reason: "IndexedDB is not available in a private window", browser: false });
  });

  it("says the demo cannot start when the worker's script never loaded", async () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    const waiting = sandbox.graphql({}, "{}");
    sandbox.broken("the demo's engine could not be loaded from this address");
    await assert.rejects(waiting, TransportFailure);
    assert.equal(sandbox.status().state, "failed");
  });

  it("passes on what changed, and the reset", () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    const seen: string[][] = [];
    let resets = 0;
    sandbox.onChanged((what) => seen.push([...what]));
    sandbox.onReset(() => (resets += 1));
    worker.say({ kind: "changed", what: ["catalog", "launches"] });
    worker.say({ kind: "changed", what: ["nonsense"] });
    worker.say({ kind: "reset" });
    assert.deepEqual(seen, [["catalog", "launches"]], "a message of the wrong shape is ignored");
    assert.equal(resets, 1);
  });

  it("drops an aborted request, and its late reply finds nobody", async () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    worker.say(READY);
    const stop = new AbortController();
    const waiting = sandbox.graphql({}, "{}", stop.signal);
    await tick();
    const request = worker.sent.find((message) => message.kind === "graphql");
    assert.ok(request);
    stop.abort();
    await assert.rejects(waiting);
    worker.say({ kind: "reply", id: request.id, status: 200, headers: {}, body: "{}" });
  });

  it("sends the demo's commands, with arguments only where they take some", async () => {
    const worker = fakeWorker();
    const sandbox = connectSandbox(worker.port, { build: "b1" });
    worker.say(READY);
    const reset = sandbox.command("reset");
    const armed = sandbox.command("arm-fault", { step: "publish" });
    await tick();
    const commands = worker.sent.filter((message) => message.kind === "command");
    assert.deepEqual(commands.map((command) => ({ name: command.name, args: command.args })), [
      { name: "reset", args: undefined }, { name: "arm-fault", args: { step: "publish" } },
    ]);
    for (const command of commands) worker.say({ kind: "reply", id: command.id, status: 200, headers: {}, body: "{}" });
    assert.equal((await reset).status, 200);
    assert.equal((await armed).status, 200);
  });
});

describe("what the site reads again, and what a browser lacks", () => {
  it("names a reading for every change the engine's jobs report", () => {
    assert.deepEqual(Object.keys(READ_AGAIN).sort(), [...CHANGES].sort());
    assert.ok(READ_AGAIN.catalog.some((key) => key[0] === "offers"));
    assert.ok(READ_AGAIN.accounts.some((key) => key[0] === "me"));
  });

  it("says what is missing for the demo to run", () => {
    const all = { WebAssembly: {}, indexedDB: {}, SharedWorker: class {}, Worker: class {} };
    assert.equal(missingInBrowser(all), null);
    assert.equal(missingInBrowser({ ...all, SharedWorker: undefined }), null, "a dedicated worker will do");
    assert.equal(missingInBrowser({ ...all, WebAssembly: undefined }), "WebAssembly");
    assert.equal(missingInBrowser({ ...all, indexedDB: undefined }), "IndexedDB");
    assert.equal(missingInBrowser({ WebAssembly: {}, indexedDB: {} }), "Web Workers");
  });
});
