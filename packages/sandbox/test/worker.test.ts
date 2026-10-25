// The sandbox's backend, as the tabs see it over MessageChannel ports: one
// start for the whole origin, the APIs answered as over HTTP with the
// sessions shared by every tab, the engine's jobs told to every tab, and the
// demo's commands. The engine is the gateway's fake one behind the binary
// call of the engine in the page.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { LISTENERS } from "../../../services/gateway/test/support/fake-engine.ts";
import type { StartEngine } from "../src/gateway/engine-port.ts";
import { type FromWorker, parseFromWorker, type ToWorker } from "../src/protocol.ts";
import { type Backend, createBackend, WAITING_FOR_DATA } from "../src/worker.ts";
import { type FakeBrowserEngine, fakeBrowserEngine } from "./support/fake-browser-engine.ts";

/** A tab: its end of a MessageChannel, what it received, and the requests it made. */
class Tab {
  readonly received: FromWorker[] = [];
  readonly #port: MessagePort;
  readonly #waiters: Array<() => void> = [];
  #next = 0;
  csrf: string | null = null;

  constructor(port: MessagePort) {
    this.#port = port;
    port.addEventListener("message", (event) => {
      const message = parseFromWorker((event as MessageEvent).data);
      assert.ok(message, `the worker sent a message of the wrong shape: ${JSON.stringify((event as MessageEvent).data)}`);
      this.received.push(message);
      for (const wake of this.#waiters.splice(0)) wake();
    });
    port.start();
  }

  send(message: ToWorker): void {
    this.#port.postMessage(message);
  }

  /** The first message received that `pick` accepts, waiting for it. */
  async next<T extends FromWorker>(pick: (message: FromWorker) => message is T, ms = 5_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.received.find(pick);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`nothing came in ${ms} ms; received ${JSON.stringify(this.received)}`);
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  async graphql(api: "internal" | "public", query: string, variables?: Record<string, unknown>) {
    const id = ++this.#next;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.csrf !== null) headers["x-csrf-token"] = this.csrf;
    if (/^\s*mutation\b/.test(query)) headers["idempotency-key"] = `key-${crypto.randomUUID()}`;
    this.send({ kind: "graphql", id, api, headers, body: JSON.stringify({ query, ...(variables ? { variables } : {}) }) });
    const reply = await this.next((message): message is Extract<FromWorker, { kind: "reply" }> => message.kind === "reply" && message.id === id);
    return { ...reply, json: JSON.parse(reply.body) };
  }

  async command(name: Extract<ToWorker, { kind: "command" }>["name"], args?: unknown) {
    const id = ++this.#next;
    this.send({ kind: "command", id, name, ...(args === undefined ? {} : { args }) });
    const reply = await this.next((message): message is Extract<FromWorker, { kind: "reply" }> => message.kind === "reply" && message.id === id);
    return { status: reply.status, json: JSON.parse(reply.body) };
  }

  close(): void {
    this.#port.close();
  }
}

const isReady = (message: FromWorker): message is Extract<FromWorker, { kind: "ready" }> => message.kind === "ready";
const isFailed = (message: FromWorker): message is Extract<FromWorker, { kind: "failed" }> => message.kind === "failed";
const isChanged = (message: FromWorker): message is Extract<FromWorker, { kind: "changed" }> => message.kind === "changed";
const isReset = (message: FromWorker): message is Extract<FromWorker, { kind: "reset" }> => message.kind === "reset";
const isProgress = (message: FromWorker): message is Extract<FromWorker, { kind: "progress" }> => message.kind === "progress";

let open: Array<{ backend: Backend; tabs: Tab[] }> = [];

function start(engine: FakeBrowserEngine, options: {
  /** The engine's start fails with this reason, every time or the first `failures` times. */
  failWith?: string;
  failures?: number;
  tickEveryMs?: number;
  /** The engine's start waits for this after its first step. */
  gate?: Promise<void>;
  /** The origin's Web Locks (Node's own), for the lock on the data. */
  locks?: boolean;
  database?: string;
} = {}) {
  let starts = 0;
  const logged: Array<{ level: string; line: string }> = [];
  const database = options.database ?? "idb://plancia-sandbox";
  const startEngine: StartEngine = async ({ token, onProgress, base, database: given }) => {
    starts += 1;
    assert.equal(token, engine.fake.token, "the worker's token is the one the engine checks");
    assert.deepEqual([base, given], ["/sandbox/", database]);
    onProgress?.("Loading the engine");
    await options.gate;
    onProgress?.("Opening the database");
    if (options.failWith && starts <= (options.failures ?? Infinity)) throw new Error(options.failWith);
    return engine;
  };
  const backend = createBackend({
    startEngine, build: "build-0001", base: "/sandbox/", database, shared: true, token: engine.fake.token,
    tickEveryMs: options.tickEveryMs ?? 60_000,
    ...(options.locks ? { locks: navigator.locks } : {}),
    log: (level, line) => {
      logged.push({ level, line });
    },
  });
  const opened = { backend, tabs: [] as Tab[] };
  open.push(opened);
  const tab = () => {
    const channel = new MessageChannel();
    backend.connect(channel.port2 as unknown as Parameters<Backend["connect"]>[0]);
    const created = new Tab(channel.port1);
    opened.tabs.push(created);
    return created;
  };
  return { backend, tab, starts: () => starts, logged };
}

afterEach(async () => {
  for (const { backend, tabs } of open) {
    for (const tab of tabs) tab.close();
    await backend.close();
  }
  open = [];
});

describe("the sandbox's backend", () => {
  test("starts once for the whole origin: the first tab sees the steps and ready, a later one ready at once, already running", async () => {
    const engine = fakeBrowserEngine();
    const { tab, starts } = start(engine);
    const first = tab();
    first.send({ kind: "hello", app: "site", build: "build-0001" });
    const ready = await first.next(isReady);
    assert.deepEqual({ ...ready.info, bootMs: 0 }, { bootMs: 0, alreadyRunning: false, build: "build-0001", now: "2026-10-24T08:00:00.000Z" });
    assert.deepEqual(first.received.filter((message) => message.kind === "progress").map((message) => message.kind === "progress" && [message.step, message.done]),
      [["Loading the engine", 1], ["Opening the database", 2], ["Starting the gateway", 3]]);
    const second = tab();
    second.send({ kind: "hello", app: "console", build: "build-0001" });
    const again = await second.next(isReady);
    assert.equal(again.info.alreadyRunning, true);
    assert.equal(again.info.bootMs, ready.info.bootMs, "the first tab's start");
    assert.equal(starts(), 1, "one engine for every tab");
  });

  test("answers a graphql message as POST /graphql: the status, the headers, the JSON body, with the tab's id", async () => {
    const engine = fakeBrowserEngine();
    const { tab, logged } = start(engine);
    const site = tab();
    site.send({ kind: "hello", app: "site", build: "build-0001" });
    await site.next(isReady);
    const answer = await site.graphql("public", "{ markets { code } }");
    assert.equal(answer.status, 200, answer.body);
    assert.deepEqual(logged, [{ level: "debug", line: "gateway: request" }], "the gateway's line for the request, on debug");
    assert.equal(answer.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(answer.json.data.markets.map((market: { code: string }) => market.code), ["IT", "FR", "DE", "GB"]);
    assert.ok(engine.calls.includes("ListMarkets"), "the gateway called the engine in the page");
  });

  test("keeps the sessions for every tab: a listener chosen in the site's tab is the other site tab's too, and the console's session apart", async () => {
    const engine = fakeBrowserEngine();
    const { tab } = start(engine);
    const [first, second] = [tab(), tab()];
    for (const each of [first, second]) {
      each.send({ kind: "hello", app: "site", build: "build-0001" });
      await each.next(isReady);
    }
    const entered = await first.graphql("public", "mutation ($id: ID!) { signInAsListener(listenerId: $id) { id } }", { id: LISTENERS.verified });
    assert.equal(entered.json.data.signInAsListener.id, LISTENERS.verified, entered.body);
    assert.equal((await second.graphql("public", "{ me { id } }")).json.data.me.id, LISTENERS.verified);
    assert.equal((await second.graphql("internal", "{ session { person { id } } }")).json.data.session, null);
  });

  test("runs the engine's jobs after a request and on its timer, and tells every tab what they changed", async () => {
    const engine = fakeBrowserEngine();
    const { tab, backend } = start(engine, { tickEveryMs: 20 });
    const [site, console] = [tab(), tab()];
    site.send({ kind: "hello", app: "site", build: "build-0001" });
    console.send({ kind: "hello", app: "console", build: "build-0001" });
    await site.next(isReady);
    await console.next(isReady);
    engine.nextChanges = ["catalog", "launches"];
    await site.graphql("public", "{ markets { code } }");
    await backend.runJobs();
    for (const each of [site, console]) assert.deepEqual((await each.next(isChanged)).what, ["catalog", "launches"]);
    const before = engine.ticks;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(engine.ticks > before, "the timer runs the jobs too");
  });

  test("the demo's commands: where it stands, the fault armed and cleared, the next launch skipped to, and a start over every tab hears", async () => {
    const engine = fakeBrowserEngine();
    const { tab } = start(engine);
    const [console, site] = [tab(), tab()];
    console.send({ kind: "hello", app: "console", build: "build-0001" });
    site.send({ kind: "hello", app: "site", build: "build-0001" });
    await console.next(isReady);
    await site.next(isReady);
    engine.due = new Date("2026-10-26T07:59:00Z");
    assert.deepEqual(await console.command("status"), {
      status: 200,
      json: { build: "build-0001", now: "2026-10-24T08:00:00.000Z", nextDue: "2026-10-26T07:59:00.000Z", armed: null, shared: true },
    });
    assert.deepEqual(await console.command("arm-fault", { step: "publish" }), { status: 200, json: { armed: "publish" } });
    assert.equal((await console.command("status")).json.armed, "publish");
    assert.equal((await console.command("arm-fault", { step: "everything" })).status, 400);
    assert.deepEqual(await console.command("clear-fault"), { status: 200, json: { armed: null } });
    // Nothing due: 409. A launch due: the clock to its change's start, and every tab reads again.
    assert.deepEqual(await console.command("skip-to-next-launch"), { status: 409, json: { error: "No launch is due." } });
    engine.skip = { from: new Date("2026-10-24T08:00:00Z"), to: new Date("2026-10-26T08:00:00Z"), changed: ["catalog", "launches", "accounts"] };
    assert.deepEqual(await console.command("skip-to-next-launch"), {
      status: 200, json: { from: "2026-10-24T08:00:00.000Z", to: "2026-10-26T08:00:00.000Z", changed: ["catalog", "launches", "accounts"] },
    });
    assert.deepEqual((await site.next(isChanged)).what, ["catalog", "launches", "accounts"]);
    // Start over: the engine back to its snapshot, every session ended, every tab told.
    const entered = await site.graphql("public", "mutation ($id: ID!) { signInAsListener(listenerId: $id) { id } }", { id: LISTENERS.unverified });
    assert.equal(entered.status, 200);
    assert.equal((await console.command("reset")).status, 200);
    assert.equal(engine.resets, 1);
    for (const each of [console, site]) await each.next(isReset);
    assert.equal((await site.graphql("public", "{ me { id } }")).json.data.me, null, "the sessions ended with the demo");
  });

  test("runs the jobs before a command's answer: the engine's saving of a moved clock is done when the tab hears it", async () => {
    const engine = fakeBrowserEngine();
    // Jobs that take a while, as the engine's do when they wait for its saving: counted when they end.
    const tick = engine.tick.bind(engine);
    let ended = 0;
    engine.tick = async () => {
      const ran = await tick();
      await new Promise((resolve) => setTimeout(resolve, 40));
      ended += 1;
      return ran;
    };
    const { tab } = start(engine);
    const console = tab();
    console.send({ kind: "hello", app: "console", build: "build-0001" });
    await console.next(isReady);
    for (const [name, args] of [["arm-fault", { step: "notify" }], ["clear-fault", undefined], ["skip-to-next-launch", undefined], ["reset", undefined]] as const) {
      const before = ended;
      await console.command(name, args);
      assert.ok(ended > before, `${name}: the jobs ended before its answer`);
    }
  });

  test("runs none of its own jobs while a skip runs them, nor while the demo starts over: the skip tells all they changed", async () => {
    const engine = fakeBrowserEngine();
    const { tab } = start(engine, { tickEveryMs: 5 });
    const console = tab();
    console.send({ kind: "hello", app: "console", build: "build-0001" });
    await console.next(isReady);
    const beside: Record<string, number> = {};
    const slow = <T>(name: string, work: () => Promise<T>) => async (): Promise<T> => {
      const before = engine.ticks;
      await new Promise((resolve) => setTimeout(resolve, 100));
      beside[name] = engine.ticks - before;
      return work();
    };
    engine.skipToNextLaunch = slow("skip", engine.skipToNextLaunch.bind(engine));
    engine.reset = slow("reset", engine.reset.bind(engine));
    engine.skip = { from: new Date("2026-10-24T08:00:00Z"), to: new Date("2026-10-26T08:00:00Z"), changed: ["catalog", "launches"] };
    assert.equal((await console.command("skip-to-next-launch")).status, 200);
    assert.equal((await console.command("reset")).status, 200);
    assert.deepEqual(beside, { skip: 0, reset: 0 });
    const ticks = engine.ticks;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(engine.ticks > ticks, "the timer's jobs go on after them");
  });

  test("ignores a message of the wrong shape, and answers the next one", async () => {
    const engine = fakeBrowserEngine();
    const { tab } = start(engine);
    const site = tab();
    site.send({ kind: "hello", app: "site", build: "build-0001" });
    await site.next(isReady);
    const count = site.received.length;
    for (const wrong of [{ kind: "graphql", id: -1 }, { kind: "drop-tables" }, "hello", null]) site.send(wrong as unknown as ToWorker);
    const answer = await site.graphql("public", "{ markets { code } }");
    assert.equal(answer.status, 200);
    assert.equal(site.received.length, count + 1, "only the good request got an answer");
  });

  test("an engine that cannot start: every tab is told why, and a request gets 503", async () => {
    const engine = fakeBrowserEngine();
    const { tab, logged } = start(engine, { failWith: "IndexedDB is not available in this browser." });
    const site = tab();
    site.send({ kind: "hello", app: "site", build: "build-0001" });
    assert.equal((await site.next(isFailed)).reason, "IndexedDB is not available in this browser.");
    const answer = await site.graphql("public", "{ markets { code } }");
    assert.equal(answer.status, 503);
    assert.equal(answer.json.errors[0].extensions.code, "ENGINE_UNAVAILABLE");
    assert.equal((await site.command("status")).status, 503);
    assert.deepEqual(logged.filter((each) => each.level === "error"), [{ level: "error", line: "the demo could not start" }], "a red line in the worker's console");
  });

  test("a start that failed is tried again by the next hello, a reload's, and then serves every tab", async () => {
    const engine = fakeBrowserEngine();
    const { tab, starts } = start(engine, { failWith: "pyodide.asm.wasm answered 503", failures: 1 });
    const first = tab();
    first.send({ kind: "hello", app: "site", build: "build-0001" });
    assert.equal((await first.next(isFailed)).reason, "pyodide.asm.wasm answered 503");
    const reloaded = tab();
    reloaded.send({ kind: "hello", app: "site", build: "build-0001" });
    const ready = await reloaded.next(isReady);
    assert.equal(ready.info.alreadyRunning, false, "a new start");
    assert.deepEqual(reloaded.received.filter(isProgress).map((message) => [message.step, message.done]),
      [["Loading the engine", 1], ["Opening the database", 2], ["Starting the gateway", 3]], "its steps counted again from the first");
    assert.equal((await reloaded.graphql("public", "{ markets { code } }")).status, 200);
    assert.equal(starts(), 2);
  });

  test("a tab that comes in while the worker starts sees the latest step at once, then ready with the others", async () => {
    const engine = fakeBrowserEngine();
    let release = () => {};
    const { tab, starts } = start(engine, { gate: new Promise<void>((resolve) => { release = resolve; }) });
    const first = tab();
    first.send({ kind: "hello", app: "console", build: "build-0001" });
    await first.next(isProgress);
    const second = tab();
    second.send({ kind: "hello", app: "site", build: "build-0001" });
    try {
      assert.deepEqual(await second.next(isProgress, 1_000), { kind: "progress", step: "Loading the engine", done: 1, of: 6 });
    } finally {
      // The start goes on whatever the assertion found: a start held for ever would hold the backend's close too.
      release();
    }
    for (const each of [first, second]) await each.next(isReady);
    assert.equal((await second.next(isReady)).info.alreadyRunning, true);
    assert.deepEqual(second.received.filter(isProgress).map((message) => message.step), ["Loading the engine", "Opening the database", "Starting the gateway"]);
    assert.equal(starts(), 1);
  });

  test("the data is one worker's at a time: a second worker on it waits, says so, and starts when the first one ends", async () => {
    const database = `idb://locks-${crypto.randomUUID()}`;
    const first = start(fakeBrowserEngine(), { locks: true, database });
    const one = first.tab();
    one.send({ kind: "hello", app: "site", build: "build-0001" });
    await one.next(isReady);
    const second = start(fakeBrowserEngine(), { locks: true, database });
    const two = second.tab();
    two.send({ kind: "hello", app: "site", build: "build-0001" });
    assert.deepEqual(await two.next(isProgress), { kind: "progress", step: WAITING_FOR_DATA, done: 1, of: 6 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(two.received.some((message) => message.kind === "ready"), false, "it waits while the first holds the data");
    assert.equal(second.starts(), 0, "its engine did not start beside the first one");
    await first.backend.close();
    await two.next(isReady);
    assert.equal(second.starts(), 1);
    // A worker alone on its data does not wait.
    const alone = start(fakeBrowserEngine(), { locks: true, database: `idb://locks-${crypto.randomUUID()}` });
    const three = alone.tab();
    three.send({ kind: "hello", app: "site", build: "build-0001" });
    await three.next(isReady);
    assert.equal(three.received.some((message) => message.kind === "progress" && message.step === WAITING_FOR_DATA), false);
  });
});
