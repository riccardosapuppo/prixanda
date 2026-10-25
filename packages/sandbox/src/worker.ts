// The sandbox's backend (stage 8): one for the whole origin, in a
// SharedWorker that every tab of the site and of the console talks to over
// the protocol (protocol.ts); where SharedWorker is missing, a dedicated
// worker for one tab. It holds, in one thread, the engine in the page and the
// gateway's browser shell over it, and it runs the engine's jobs:
//   - the first hello starts them, once: the engine (startEngine, the
//     engine's side of the package, with a random internal token), then the
//     gateway, whose EngineClient reaches the engine through browserTransport;
//     every tab sees the steps (one that comes in meanwhile, the latest at
//     once), then ready, or failed; after a failed start, the next hello (a
//     reload) tries again;
//   - a graphql message goes to the gateway, as POST /graphql would over HTTP;
//   - the jobs run on a timer and after every request, and when they change
//     something every tab is told what to read again;
//   - the demo's commands: where it stands, start over, arm or clear the
//     simulated fault, skip to the next launch. A start over and a skip run
//     one at a time, with no jobs beside them, each on the engine of the
//     moment it begins. A start over that leaves the engine with no data open
//     stops the jobs; the next hello waits for any start over or skip under
//     way, then, if the data is still not open, lets that engine go and
//     starts the demo again: a start over tried again meanwhile that opened
//     the data keeps the engine, and no second one starts beside it.
// The engine's data in IndexedDB is one worker's at a time: before the engine
// starts, the worker takes the origin's lock on it (Web Locks) and keeps it
// while it lives. The one SharedWorker waits for it only a moment, after a
// reload, while the one before it ends; where each tab has a dedicated worker,
// a second tab waits, and says so, until the first one closes, instead of
// opening the same database beside it.
// This file holds the logic; backend.ts binds it to the worker's global scope
// and to the engine, and the tests to MessageChannel ports and a fake engine.
import { createEngineClient } from "gateway/engine";
import { type BrowserGateway, startBrowserGateway } from "gateway/browser";
import type { BrowserEngine, StartEngine } from "./gateway/engine-port.ts";
import { browserTransport } from "./gateway/transport.ts";
import {
  type Changed, type Command, type CommandError, type CommandResults, type FromWorker, type GraphqlRequest, parseArmFault, parseToWorker,
  type ReadyInfo, type Status,
} from "./protocol.ts";

/**
 * A tab's end of the channel: a MessagePort of the SharedWorker, or the
 * dedicated worker's own scope. A port says "close" when its tab went away
 * where the platform tells (Node's ports do; Chromium tells a SharedWorker
 * nothing, and a closed tab's port stays, its messages going nowhere).
 */
export type Port = {
  postMessage(message: FromWorker): void;
  addEventListener(type: "message" | "close", listener: (event: { readonly data?: unknown }) => void): void;
  start?(): void;
};

export type BackendOptions = {
  readonly startEngine: StartEngine;
  /** The build's fingerprint: ready says it, and a tab of another build reloads. */
  readonly build: string;
  /** Where the build serves the sandbox's files: /sandbox/. */
  readonly base: string;
  /** Where the engine keeps its data: idb://<name>, a database of IndexedDB. */
  readonly database: string;
  /** A SharedWorker, or a dedicated worker for one tab. */
  readonly shared: boolean;
  /** How often the engine's jobs run while the worker lives. */
  readonly tickEveryMs?: number;
  /** The internal token the engine checks on every call; random by default. */
  readonly token?: string;
  /** Milliseconds, for how long the start took. */
  readonly monotonic?: () => number;
  /** The sessions' clock: the browser's time. */
  readonly clock?: () => Date;
  /** The origin's Web Locks (navigator.locks): the lock on the database is taken before the engine starts. */
  readonly locks?: Locks;
  /** Where the worker's lines go: the browser's console by default, on debug as the engine's, but for what broke. */
  readonly log?: Log;
};

export type Log = (level: "debug" | "error", line: string, fields?: unknown) => void;

const toConsole: Log = (level, line, fields) => (level === "error" ? console.error : console.debug)(`[sandbox] ${line}`, ...(fields === undefined ? [] : [fields]));

/** As much of the Web Locks API as the worker asks of it. */
export type Locks = {
  request(
    name: string, options: { readonly ifAvailable?: boolean; readonly signal?: AbortSignal }, callback: (lock: unknown) => Promise<void>,
  ): Promise<unknown>;
};

/** The step a tab is shown while another worker holds the demo's data. */
export const WAITING_FOR_DATA = "Waiting for the demo in another tab of this browser to close";

/**
 * Takes the lock named `name` and holds it until `until` aborts: in a worker,
 * never, so that it goes with the worker. Resolves once it holds it, after
 * onWait if another held it first.
 */
export async function holdLock(locks: Locks, name: string, until: AbortSignal, onWait: () => void): Promise<void> {
  const released = new Promise<void>((resolve) => until.addEventListener("abort", () => resolve(), { once: true }));
  const free = await new Promise<boolean>((resolve, reject) => {
    locks.request(name, { ifAvailable: true }, async (lock) => {
      resolve(lock !== null);
      if (lock !== null) await released;
    }).catch(reject);
  });
  if (free) return;
  onWait();
  await new Promise<void>((resolve, reject) => {
    locks.request(name, { signal: until }, async () => {
      resolve();
      await released;
    }).catch(reject);
  });
}

export type Backend = {
  /** A new tab: it says hello first. */
  connect(port: Port): void;
  /** Runs the jobs now; resolves when they ran (for the tests). */
  runJobs(): Promise<void>;
  close(): Promise<void>;
};

/** The steps the tabs are shown while the worker starts: the engine's five (PROGRESS_STEPS of src/engine/), then the gateway's. */
const BOOT_STEPS = 6;

type Progress = Extract<FromWorker, { kind: "progress" }>;
type Booted = { engine: BrowserEngine; gateway: BrowserGateway; info: Omit<ReadyInfo, "alreadyRunning" | "now"> };

const json = (value: unknown) => JSON.stringify(value);
const JSON_TYPE = { "content-type": "application/json; charset=utf-8" };

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createBackend(options: BackendOptions): Backend {
  const monotonic = options.monotonic ?? (() => performance.now());
  const log = options.log ?? toConsole;
  const token = options.token ?? randomToken();
  const tabs = new Set<Port>();
  let booting: Promise<Booted> | null = null;
  /** What the last start gave, once ready, until a restart lets it go: the jobs read it with no pause before a tick. */
  let current: Booted | null = null;
  let holding: Promise<void> | null = null;
  /** Aborted by close: the lock on the data goes (a worker that ends lets it go by ending). */
  const ending = new AbortController();
  let closing: Promise<void> | null = null;
  /** The start finished, well or not; until then a tab that comes in is shown the latest step. */
  let settled = false;
  /** The start failed: there are no jobs to run, and every request says so until a tab says hello again. */
  let failed = false;
  /** A start over left the engine with no data open (its reset failed with DataNotOpen): no jobs run, and the next
   * hello starts the demo again, unless another start over opened the data first. */
  let broken = false;
  let restarting: Promise<void> | null = null;
  let done = 0;
  let latest: Progress | null = null;
  let jobs: Promise<void> | null = null;
  let again = false;
  /** The engine's tick under way, if any. */
  let ticking: Promise<unknown> | null = null;
  /** Set while a command runs that the jobs must not run beside (withoutJobs). */
  let held: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const broadcast = (message: FromWorker) => {
    for (const tab of tabs) tab.postMessage(message);
  };
  const progress = (step: string) => {
    done += 1;
    latest = { kind: "progress", step, done, of: Math.max(done, BOOT_STEPS) };
    broadcast(latest);
  };

  function boot(): Promise<Booted> {
    if (booting !== null) return booting;
    settled = false;
    failed = false;
    done = 0;
    latest = null;
    const starting = (async () => {
      const started = monotonic();
      if (options.locks) {
        // Once for the worker's life: a start tried again after a failure holds it already, and a lock is not taken twice.
        holding ??= holdLock(options.locks, options.database, ending.signal, () => progress(WAITING_FOR_DATA));
        await holding;
      }
      const engine = await options.startEngine({ base: options.base, database: options.database, token, onProgress: progress });
      progress("Starting the gateway");
      const gateway = await startBrowserGateway({
        engine: createEngineClient(browserTransport(engine, token)),
        // The gateway's line for each request, on debug, so that a refusal the demo expects is no red line; what broke is an error.
        logger: { log: (level, message, fields) => log(level === "error" ? "error" : "debug", `gateway: ${message}`, fields ?? {}) },
        ...(options.clock ? { clock: options.clock } : {}),
      });
      timer = setInterval(() => void runJobs(), options.tickEveryMs ?? 1_000);
      const booted = { engine, gateway, info: { bootMs: Math.round(monotonic() - started), build: options.build } };
      current = booted;
      return booted;
    })();
    booting = starting;
    starting.then(() => {
      settled = true;
    }, (error: unknown) => {
      settled = true;
      failed = true;
      log("error", "the demo could not start", error);
    });
    return starting;
  }

  /**
   * Lets the engine a start over left with no data open go, so that the next boot starts another. It takes the guard
   * of the start over and the skip (withoutJobs) first: it waits for one under way, and never lets an engine go while
   * a command still works on it. Then, if a start over tried again meanwhile opened the data, it keeps the engine;
   * otherwise its timer stops, its gateway too, and the next boot starts a new engine, which opens the data from the
   * snapshot, as a first visit does. The lock on the data stays the worker's. One at a time, for every tab that says
   * hello meanwhile.
   */
  function restart(): Promise<void> {
    restarting ??= withoutJobs(async () => {
      if (!broken) return;
      const old = await booting?.catch(() => null);
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await old?.gateway.stop().catch((error: unknown) => log("error", "the gateway did not stop", error));
      booting = null;
      current = null;
      broken = false;
    }).finally(() => {
      restarting = null;
    });
    return restarting;
  }

  /** The engine's jobs, one run at a time; a run asked for meanwhile follows it. */
  function runJobs(): Promise<void> {
    if (booting === null || failed || broken) return Promise.resolve();
    if (jobs !== null) {
      again = true;
      return jobs;
    }
    jobs = (async () => {
      do {
        again = false;
        await booting?.catch(() => null);  // a start under way, or one a restart began
        while (held !== null) await held;
        // The engine of now, read with no pause before its tick: not one a restart let go while the jobs waited.
        if (current === null || failed || broken) break;
        const tick = current.engine.tick();
        ticking = tick;
        try {
          const { changed } = await tick;
          if (changed.length > 0) broadcast({ kind: "changed", what: changed });
        } finally {
          ticking = null;
        }
      } while (again);
    })().catch((error: unknown) => {
      log("error", "the engine's jobs failed", error);
    }).finally(() => {
      jobs = null;
    });
    return jobs;
  }

  /**
   * A command the jobs do not run beside: the skip to the next launch, which
   * runs them itself, at each moment of the launch, and tells what they
   * changed; the start over, which replaces what they run on. The tick under
   * way ends first, and the next one waits for the command.
   */
  async function withoutJobs<T>(work: () => Promise<T>): Promise<T> {
    while (held !== null) await held;
    let release = () => {};
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await ticking?.catch(() => undefined);
      return await work();
    } finally {
      held = null;
      release();
    }
  }

  async function hello(port: Port) {
    // A start that failed (a file that did not load, a browser that refused its storage) is tried again by the next
    // tab that says hello: a reload is how a visitor tries again, and it finds the same SharedWorker. An engine a start
    // over left with no data open is let go first, once no start over or skip works on it (restart).
    if (broken || restarting !== null) await restart();
    else if (failed) booting = null;
    const alreadyRunning = booting !== null;
    if (alreadyRunning && !settled && latest !== null) port.postMessage(latest);
    try {
      const { engine, info } = await boot();
      port.postMessage({ kind: "ready", info: { ...info, alreadyRunning, now: engine.clock.now().toISOString() } });
    } catch (error) {
      port.postMessage({ kind: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  async function graphql(port: Port, request: GraphqlRequest) {
    let reply: { status: number; headers: Readonly<Record<string, string>>; body: string };
    try {
      const { gateway } = await boot();
      reply = await gateway.request(request.api, { headers: request.headers, body: request.body });
    } catch (error) {
      reply = {
        status: 503, headers: JSON_TYPE,
        body: json({ errors: [{ message: `The demo could not start: ${error instanceof Error ? error.message : String(error)}`, extensions: { code: "ENGINE_UNAVAILABLE" } }] }),
      };
    }
    port.postMessage({ kind: "reply", id: request.id, ...reply });
    // A request may have written: the jobs that follow from it run now, not at the next tick.
    void runJobs();
  }

  type Answer = readonly [status: number, body: CommandResults[keyof CommandResults] | CommandError];

  async function perform(request: Command): Promise<Answer> {
    // The start over and the skip take the engine and the gateway of the moment they begin, under the guard: never
    // one a restart let go, nor one it lets go while they work.
    if (request.name === "reset") {
      return withoutJobs(async () => {
        const { engine, gateway } = await boot();
        try {
          await engine.reset();
        } catch (error) {
          // One that failed before it closed the data (the snapshot not downloaded) leaves the engine as it was.
          if (error instanceof Error && error.name === "DataNotOpen") broken = true;
          throw error;
        }
        broken = false;
        gateway.reset();
        broadcast({ kind: "reset" });
        return [200, { now: engine.clock.now().toISOString() }] as const;
      });
    }
    if (request.name === "skip-to-next-launch") {
      return withoutJobs(async (): Promise<Answer> => {
        const { engine } = await boot();
        const skipped = await engine.skipToNextLaunch();
        if (skipped === null) return [409, { error: "No launch is due." }];
        const changed: readonly Changed[] = skipped.changed;
        if (changed.length > 0) broadcast({ kind: "changed", what: changed });
        return [200, { from: skipped.from.toISOString(), to: skipped.to.toISOString(), changed }];
      });
    }
    const { engine } = await boot();
    switch (request.name) {
      case "status": {
        const next = await engine.clock.nextDue();
        const armed = engine.faults.armed();
        const status: Status = {
          build: options.build, now: engine.clock.now().toISOString(), nextDue: next === null ? null : next.toISOString(),
          armed: armed === null ? null : (parseArmFault({ step: armed })?.step ?? null), shared: options.shared,
        };
        return [200, status];
      }
      case "arm-fault": {
        const args = parseArmFault(request.args);
        if (args === null) return [400, { error: "arm-fault takes { step }, one of check, prepare, publish, notify and verify." }];
        engine.faults.arm(args.step);
        return [200, { armed: args.step }];
      }
      case "clear-fault":
        engine.faults.clear();
        return [200, { armed: null }];
    }
  }

  async function command(port: Port, request: Command) {
    let answer: Answer;
    try {
      answer = await perform(request);
    } catch (error) {
      answer = [503, { error: error instanceof Error ? error.message : String(error) }];
    }
    // A command may have moved the demo's clock or its data, which the engine saves without holding the call: the jobs
    // run before the tab hears the answer, and the next tick waits for that saving, so a tab closed then loses nothing.
    await runJobs();
    const [status, body] = answer;
    port.postMessage({ kind: "reply", id: request.id, status, headers: JSON_TYPE, body: json(body) });
  }

  return {
    connect(port) {
      port.addEventListener("close", () => {
        tabs.delete(port);
      });
      port.addEventListener("message", (event) => {
        const message = parseToWorker(event.data);
        if (message === null) return;
        if (message.kind === "hello") {
          tabs.add(port);
          void hello(port);
        } else if (message.kind === "graphql") {
          void graphql(port, message);
        } else {
          void command(port, message);
        }
      });
      port.start?.();
    },
    runJobs,
    close() {
      closing ??= (async () => {
        if (timer !== null) clearInterval(timer);
        // The lock first: a start still waiting for it fails now instead of waiting for ever.
        ending.abort(new Error("the sandbox's backend closed"));
        if (booting !== null) {
          const started = await booting.catch(() => null);
          await jobs;
          await started?.gateway.stop();
        }
      })();
      return closing;
    },
  };
}
