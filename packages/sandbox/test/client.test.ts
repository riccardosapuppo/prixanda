// The tab's side of the sandbox, the client both apps use, over a
// MessageChannel to a worker the test plays: the hello, the steps and ready,
// each app's requests to its own API, a worker of another build or one that
// failed, the replies matched by id, an aborted request, what changed and a
// start over, and a worker that could not be reached at all.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { type Backend, BackendFailure, connectBackend, droppedConnection, missingInBrowser, stoppedBackend } from "../src/client.ts";
import { type FromWorker, parseToWorker, type ReadyInfo, type ToWorker } from "../src/protocol.ts";

const READY: ReadyInfo = { bootMs: 4200, alreadyRunning: false, build: "build-0001", now: "2026-10-24T08:00:00.000Z" };

/** The worker's end of the channel, played by the test: what the tab sent, and what to answer. */
class Worker {
  readonly received: ToWorker[] = [];
  readonly #port: MessagePort;
  readonly #waiters: Array<() => void> = [];

  constructor(port: MessagePort) {
    this.#port = port;
    port.addEventListener("message", (event) => {
      const message = parseToWorker((event as MessageEvent).data);
      assert.ok(message, `the tab sent a message of the wrong shape: ${JSON.stringify((event as MessageEvent).data)}`);
      this.received.push(message);
      for (const wake of this.#waiters.splice(0)) wake();
    });
    port.start();
  }

  send(message: FromWorker): void {
    this.#port.postMessage(message);
  }

  async next<T extends ToWorker>(pick: (message: ToWorker) => message is T): Promise<T> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = this.received.find(pick);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`the tab sent nothing of the kind; it sent ${JSON.stringify(this.received)}`);
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  close(): void {
    this.#port.close();
  }
}

const isGraphql = (message: ToWorker): message is Extract<ToWorker, { kind: "graphql" }> => message.kind === "graphql";
const isCommand = (message: ToWorker): message is Extract<ToWorker, { kind: "command" }> => message.kind === "command";
const settles = (promise: Promise<unknown>, ms = 100) => Promise.race([promise.then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

let channels: MessageChannel[] = [];
afterEach(() => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  channels = [];
});

function open(app: "site" | "console", build = "build-0001"): { backend: Backend; worker: Worker } {
  const channel = new MessageChannel();
  channels.push(channel);
  const worker = new Worker(channel.port2);
  return { backend: connectBackend(channel.port1, { app, build }), worker };
}

describe("the sandbox's client", () => {
  test("says hello with its app and build, shows the worker's steps, then is ready", async () => {
    const { backend, worker } = open("console");
    assert.deepEqual(await worker.next((message): message is ToWorker => message.kind === "hello"), { kind: "hello", app: "console", build: "build-0001" });
    const seen: string[] = [];
    backend.subscribe(() => seen.push(backend.status().state));
    assert.deepEqual(backend.status(), { state: "starting", step: null, done: 0, of: 0 });
    worker.send({ kind: "progress", step: "Loading Python", done: 1, of: 6 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(backend.status(), { state: "starting", step: "Loading Python", done: 1, of: 6 });
    worker.send({ kind: "ready", info: READY });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(backend.status(), { state: "ready", info: READY });
    // A step that comes after ready changes nothing.
    worker.send({ kind: "progress", step: "Late", done: 7, of: 7 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(backend.status().state, "ready");
    assert.deepEqual(seen, ["starting", "ready"]);
  });

  test("sends each app's requests to its own API, after ready, and matches the replies by id in any order", async () => {
    for (const [app, api] of [["site", "public"], ["console", "internal"]] as const) {
      const { backend, worker } = open(app);
      const first = backend.graphql({ "content-type": "application/json" }, '{"query":"{ a }"}');
      const second = backend.graphql({ "content-type": "application/json", "x-csrf-token": "t" }, '{"query":"{ b }"}');
      assert.equal(await settles(first), false, "nothing is sent before ready");
      assert.equal(worker.received.filter(isGraphql).length, 0);
      worker.send({ kind: "ready", info: READY });
      await worker.next((message): message is Extract<ToWorker, { kind: "graphql" }> => isGraphql(message) && message.body.includes("b"));
      const [one, two] = worker.received.filter(isGraphql);
      assert.ok(one && two);
      assert.deepEqual([one.api, two.api], [api, api]);
      assert.deepEqual(two.headers, { "content-type": "application/json", "x-csrf-token": "t" });
      worker.send({ kind: "reply", id: two.id, status: 200, headers: { "content-type": "application/json" }, body: '{"data":{"b":2}}' });
      worker.send({ kind: "reply", id: one.id, status: 400, headers: {}, body: '{"errors":[]}' });
      assert.deepEqual(await second, { status: 200, headers: { "content-type": "application/json" }, body: '{"data":{"b":2}}' });
      assert.deepEqual(await first, { status: 400, headers: {}, body: '{"errors":[]}' });
    }
  });

  test("sends the demo's commands with their arguments", async () => {
    const { backend, worker } = open("console");
    worker.send({ kind: "ready", info: READY });
    const armed = backend.command("arm-fault", { step: "publish" });
    const status = backend.command("status");
    const sent = await worker.next((message): message is Extract<ToWorker, { kind: "command" }> => isCommand(message) && message.name === "status");
    const arm = worker.received.filter(isCommand).find((message) => message.name === "arm-fault");
    assert.deepEqual(arm && { name: arm.name, args: arm.args }, { name: "arm-fault", args: { step: "publish" } });
    assert.equal("args" in sent, false, "status takes no arguments");
    worker.send({ kind: "reply", id: sent.id, status: 200, headers: {}, body: "{}" });
    worker.send({ kind: "reply", id: arm?.id ?? -1, status: 200, headers: {}, body: '{"armed":"publish"}' });
    assert.equal((await status).status, 200);
    assert.equal((await armed).body, '{"armed":"publish"}');
  });

  test("a worker of another build: the tab is told so, and its requests are refused", async () => {
    const { backend, worker } = open("site");
    const waiting = backend.graphql({}, "{}");
    worker.send({ kind: "ready", info: { ...READY, build: "build-0002" } });
    await assert.rejects(waiting, (error: unknown) => error instanceof BackendFailure && /another version of the demo/.test(error.message));
    assert.deepEqual(backend.status(), { state: "other-build", info: { ...READY, build: "build-0002" } });
    await assert.rejects(backend.command("status"), BackendFailure);
    assert.equal(worker.received.filter(isGraphql).length, 0, "nothing was sent to a worker of another build");
  });

  test("a worker that failed to start: its reason, the waiting requests refused, and the later ones too", async () => {
    const { backend, worker } = open("site");
    const waiting = backend.graphql({}, "{}");
    worker.send({ kind: "failed", reason: "IndexedDB is not available in this browser." });
    await assert.rejects(waiting, { name: "BackendFailure", message: "IndexedDB is not available in this browser." });
    assert.deepEqual(backend.status(), { state: "failed", reason: "IndexedDB is not available in this browser.", browser: false });
    await assert.rejects(backend.graphql({}, "{}"), BackendFailure);
  });

  test("an aborted request rejects at once, and its late reply finds nobody", async () => {
    const { backend, worker } = open("site");
    worker.send({ kind: "ready", info: READY });
    const controller = new AbortController();
    const asked = backend.graphql({}, '{"query":"{ slow }"}', controller.signal);
    const sent = await worker.next(isGraphql);
    controller.abort(new Error("the page moved on"));
    await assert.rejects(asked, { message: "the page moved on" });
    worker.send({ kind: "reply", id: sent.id, status: 200, headers: {}, body: "{}" });
    const after = backend.graphql({}, '{"query":"{ next }"}');
    const next = await worker.next((message): message is Extract<ToWorker, { kind: "graphql" }> => isGraphql(message) && message.id !== sent.id);
    worker.send({ kind: "reply", id: next.id, status: 200, headers: {}, body: '{"data":{}}' });
    assert.equal((await after).body, '{"data":{}}');
    // Aborted before it was sent: never sent.
    const gone = new AbortController();
    gone.abort();
    await assert.rejects(backend.graphql({}, "{}", gone.signal));
    assert.equal(worker.received.filter(isGraphql).length, 2);
  });

  test("tells its listeners what changed and when the demo started over, until they leave", async () => {
    const { backend, worker } = open("site");
    const changed: string[][] = [];
    let resets = 0;
    const leave = backend.onChanged((what) => changed.push([...what]));
    backend.onReset(() => {
      resets += 1;
    });
    worker.send({ kind: "ready", info: READY });
    worker.send({ kind: "changed", what: ["catalog", "launches"] });
    worker.send({ kind: "reset" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    leave();
    worker.send({ kind: "changed", what: ["accounts"] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(changed, [["catalog", "launches"]]);
    assert.equal(resets, 1);
  });

  test("ignores what is not the protocol's", async () => {
    const { backend, worker } = open("site");
    const port = (worker as unknown as { send(message: unknown): void });
    for (const wrong of [{ kind: "ready" }, { kind: "reply", id: "1" }, "ready", null]) port.send(wrong);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(backend.status().state, "starting");
  });

  test("a worker that could not be reached: failed before ready, and nothing changes after ready", async () => {
    const { backend } = open("site");
    const waiting = backend.graphql({}, "{}");
    backend.broken("the demo's engine could not be loaded from this address");
    await assert.rejects(waiting, BackendFailure);
    assert.deepEqual(backend.status(), { state: "failed", reason: "the demo's engine could not be loaded from this address", browser: false });
    const other = open("site");
    other.worker.send({ kind: "ready", info: READY });
    await new Promise((resolve) => setTimeout(resolve, 20));
    other.backend.broken("an error after ready");
    assert.equal(other.backend.status().state, "ready");
  });

  test("names what a browser lacks to run the demo, and a stopped backend answers as its state says", async () => {
    const all = { WebAssembly: {}, indexedDB: {}, SharedWorker: class {}, Worker: class {} };
    assert.equal(missingInBrowser(all), null);
    assert.equal(missingInBrowser({ ...all, SharedWorker: undefined }), null, "a dedicated worker will do");
    assert.equal(missingInBrowser({ ...all, WebAssembly: undefined }), "WebAssembly");
    assert.equal(missingInBrowser({ ...all, indexedDB: null }), "IndexedDB");
    assert.equal(missingInBrowser({ ...all, SharedWorker: undefined, Worker: undefined }), "Web Workers");
    const failed = stoppedBackend({ state: "failed", reason: "IndexedDB", browser: true });
    await assert.rejects(failed.graphql({}, "{}"), { name: "BackendFailure", message: "IndexedDB" });
    await assert.rejects(failed.command("status"), BackendFailure);
    const rendering = stoppedBackend({ state: "starting", step: null, done: 0, of: 0 });
    assert.equal(await settles(rendering.graphql({}, "{}")), false, "a page rendered at build time waits");
  });

  test("tells a download the network dropped from a demo that failed", () => {
    for (const reason of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed", "network error",
      "/sandbox/engine/snapshot-29f12910851e.tar.gz answered 503"]) {
      assert.equal(droppedConnection(reason), true, reason);
    }
    for (const reason of ["IndexedDB", "the demo's engine could not be loaded from this address",
      "/sandbox/engine/manifest.json answered 404", "The data kept in this browser came from another build"]) {
      assert.equal(droppedConnection(reason), false, reason);
    }
  });
});
