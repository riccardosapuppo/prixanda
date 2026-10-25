// The engine in the browser (stage 8): the same Python engine as the
// server's, in Pyodide, on PGlite, behind the same protobuf contract. The
// gateway's core calls it through a Connect transport over call(), as it
// calls the server over gRPC on Node; the worker that holds it
// (src/worker.ts) ticks its jobs and tells the tabs what changed.
//
// startEngine loads, at the same time, Pyodide with the engine's package and
// the database (from IndexedDB, or the build's snapshot on a first visit),
// applies the migrations a newer build brings, and answers once the engine
// is ready. Data kept from a build this one cannot account for (a migration
// changed, or one this build does not have) is not opened: the demo starts
// again from the build's data, and says so in the progress.
//
// What is simulated, and says so: the payment provider and the student
// verification (as on the server, §15), the demo's clock, which a visitor can
// move forward, and the fault that can be armed on a step of the next launch
// (browser/sandbox.py): the step does its work, then fails before it commits,
// and the launch's own code recovers. The faults of the full system are
// injected by its tests, which stop the engine's process (tests/faults).
import type { Extension, PGlite } from "@electric-sql/pglite";
import type { loadPyodide as LoadPyodide, PyodideAPI } from "pyodide";
import { DemoClock } from "./clock.ts";
import { type Opened, openDatabase, type PGliteModules, type Session } from "./database.ts";
import { deleteFromIndexedDb, existsInIndexedDb } from "./idb.ts";
import type { Manifest } from "./manifest.ts";
import { type Migration, MigrationRefused } from "./migrations.ts";
import { loadPython, type PythonSource } from "./python.ts";

export type EngineReply =
  | { readonly ok: true; readonly response: Uint8Array }
  | { readonly ok: false; readonly code: number /* gRPC's status code */; readonly message: string };

/** What the engine's jobs can change: the tabs read these again (protocol.ts, CHANGES). */
export type Changed = "catalog" | "changes" | "launches" | "accounts" | "audit";
/** The steps of a launch (protocol.ts, LAUNCH_STEPS). */
export type LaunchStep = "check" | "prepare" | "publish" | "notify" | "verify";
export const LAUNCH_STEPS: readonly LaunchStep[] = ["check", "prepare", "publish", "notify", "verify"];
export const CHANGES: readonly Changed[] = ["catalog", "changes", "launches", "accounts", "audit"];
/** The passes a skip makes at most: a launch stops after five failures of a step (launches.py). */
const SKIP_PASSES = 12;

export type BrowserEngine = {
  /** A call of the contract: service and method as in proto/ ("commerce.v1.ChangeService", "SubmitChange"), the
   * metadata as the gateway writes it (x-request-id, x-actor, x-actor-role, idempotency-key, authorization), the
   * protobuf message in binary; the response in binary, or gRPC's status code and message. */
  call(service: string, method: string, metadata: Readonly<Record<string, string>>, request: Uint8Array): Promise<EngineReply>;
  /** The jobs due at the demo's time: the launches' steps, the outbox, the provider's events, the alarms. */
  tick(): Promise<{ readonly ran: number; readonly changed: readonly Changed[] }>;
  readonly clock: {
    now(): Date;
    /** Moves the demo's clock forward to that instant; an instant not after its now leaves it where it is. */
    advanceTo(instant: Date): void;
    /** When a launch is next due: a scheduled change's start less the minute ahead, or the next attempt of a launch
     * under way; it can be already past when no tick ran since. null when no launch waits for a moment. */
    nextDue(): Promise<Date | null>;
  };
  /** The simulated fault: the next launch fails once at that step; the recovery is the engine's own code. */
  readonly faults: { arm(step: LaunchStep): void; clear(): void; armed(): LaunchStep | null };
  /** The demo's "skip to the next launch": the clock to the moment the next launch is due, the launch run step by
   * step there, its attempts after a simulated fault each at its own moment, then the clock to the change's start, so
   * that it is in force; the log and the launch's history read as in a run in real time, and no alarm goes off, since
   * the launch starts on time. null when no launch is due. */
  skipToNextLaunch(): Promise<{ readonly from: Date; readonly to: Date; readonly changed: readonly Changed[] } | null>;
  /** Back to the build's snapshot. */
  reset(): Promise<void>;
};

/** The engine as startEngine and createEngine give it: the contract's BrowserEngine, what the measurements read
 * beside it, and a way to stop it (the tests, the measurements; a worker that ends). */
export type SandboxEngine = BrowserEngine & { readonly info: EngineInfo; close(): Promise<void> };

/** What the measurements read beside the engine (build/measure.ts). */
export type EngineInfo = {
  readonly startMs: number;
  /** The data came from the build's snapshot at this start (a first visit), not from IndexedDB. */
  readonly loaded: boolean;
  /** Migrations this start applied to the data kept in the browser. */
  readonly applied: readonly string[];
  readonly versions: { readonly python: string; readonly protobuf: string; readonly postgres: string };
  readonly steps: Readonly<Record<string, number>>;
};

export type StartOptions = {
  /** Where the sandbox's files are served: "/sandbox/". */
  readonly base: string;
  /** The database's name in IndexedDB: "idb://plancia-sandbox". */
  readonly database: string;
  /** The internal token: the worker makes it at random, and its transport sends it in every call. */
  readonly token: string;
  readonly onProgress?: (step: string) => void;
};

/** The steps onProgress names during a start, in an order that varies: Python and the data load at the same time. */
export const PROGRESS_STEPS = 5;

export type { Manifest } from "./manifest.ts";

async function fetched(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

export async function startEngine(options: StartOptions): Promise<SandboxEngine> {
  const base = new URL(options.base.endsWith("/") ? options.base : `${options.base}/`, self.location.href).href;
  const manifest = (await (await fetched(`${base}engine/manifest.json`)).json()) as Manifest;
  const [pglite, contrib, pyodide] = await Promise.all([
    import(`${base}pglite/index.js`) as Promise<{ PGlite: typeof PGlite }>,
    import(`${base}pglite/contrib/btree_gist.js`) as Promise<{ btree_gist: Extension }>,
    import(`${base}pyodide/pyodide.mjs`) as Promise<{ loadPyodide: typeof LoadPyodide }>,
  ]);
  return createEngine({
    modules: { PGlite: pglite.PGlite, btree_gist: contrib.btree_gist },
    python: {
      loadPyodide: pyodide.loadPyodide,
      indexURL: `${base}pyodide/`,
      packageBaseUrl: `${base}pyodide/`,
      engine: async () => (await fetched(`${base}engine/${manifest.engine}`)).arrayBuffer(),
    },
    dataDir: options.database,
    snapshot: async () => (await fetched(`${base}engine/${manifest.snapshot}`)).blob(),
    migrations: async () => (await (await fetched(`${base}engine/${manifest.migrations}`)).json()) as Migration[],
    exists: () => existsInIndexedDb(options.database),
    remove: () => deleteFromIndexedDb(options.database),
    token: options.token,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}

export type EngineDeps = {
  readonly modules: PGliteModules;
  readonly python: PythonSource;
  /** idb://<name> in the browser; none in Node, where the data stays in memory. */
  readonly dataDir?: string;
  readonly snapshot: () => Promise<Blob>;
  readonly migrations: () => Promise<readonly Migration[]>;
  readonly exists?: () => Promise<boolean>;
  readonly remove?: () => Promise<void>;
  readonly token: string;
  readonly onProgress?: (step: string) => void;
  /** Each line of the engine's log (JSON); console.debug by default, out of sight unless asked for. */
  readonly onLog?: (line: string) => void;
};

type PySandbox = {
  call(fullName: string, metadata: string, request: Uint8Array): Promise<PyProxyLike>;
  tick(): Promise<string>;
  next_due(): Promise<string | undefined>;
  launches_due(change?: number): Promise<string>;
  launch_state(change: number): Promise<string | undefined>;
  arm_fault(step: string): void;
  clear_fault(): void;
  armed_fault(): string | undefined;
  destroy(): void;
};
type PyProxyLike = { toJs(): unknown; destroy(): void };

/** Calls run side by side (the engine queues their transactions); a reset waits for them, and they for it. */
class Gate {
  #running = 0;
  #exclusive: Promise<void> | null = null;
  #idle: (() => void) | null = null;

  async shared<T>(work: () => Promise<T>): Promise<T> {
    while (this.#exclusive) await this.#exclusive;
    this.#running += 1;
    try {
      return await work();
    } finally {
      this.#running -= 1;
      if (this.#running === 0) this.#idle?.();
    }
  }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    while (this.#exclusive) await this.#exclusive;
    let release!: () => void;
    this.#exclusive = new Promise<void>((resolve) => { release = resolve; });
    try {
      if (this.#running > 0) await new Promise<void>((resolve) => { this.#idle = resolve; });
      return await work();
    } finally {
      this.#idle = null;
      this.#exclusive = null;
      release();
    }
  }
}

function settle(proxy: unknown): void {
  try {
    (proxy as { destroy?: () => void } | null)?.destroy?.();
  } catch {
    // already destroyed by Pyodide once awaited
  }
}

/** The engine on modules given: the browser's (startEngine) or Node's (the build and the tests). */
export async function createEngine(deps: EngineDeps): Promise<SandboxEngine> {
  const begun = performance.now();
  const steps: Record<string, number> = {};
  const mark = (moment: string) => {
    steps[moment] = Math.round(performance.now() - begun);
  };
  const say = (step: string) => {
    mark(step);
    deps.onProgress?.(step);
  };
  const log = deps.onLog ?? ((line: string) => console.debug(line));
  const pythonLoading = loadPython(deps.python, say);
  pythonLoading.catch(() => {});
  const migrations = deps.migrations();
  migrations.catch(() => {});

  const open = async (fresh: boolean): Promise<Opened> => {
    const options = {
      modules: deps.modules,
      snapshot: deps.snapshot,
      migrations,
      progress: say,
      mark,
      ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    };
    if (fresh) return openDatabase({ ...options, exists: async () => false });
    try {
      return await openDatabase({ ...options, ...(deps.exists ? { exists: deps.exists } : {}) });
    } catch (error) {
      if (!(error instanceof MigrationRefused) || !deps.remove) throw error;
      say(`The data kept in this browser came from another build (${error.message}): starting again from the demo's data`);
      await deps.remove();
      return openDatabase({ ...options, exists: async () => false });
    }
  };

  let db = await open(false);
  const pyodide: PyodideAPI = await pythonLoading;
  mark("Python ready");
  say("Starting the engine");
  const module = pyodide.pyimport("commerce.browser.sandbox") as unknown as { Sandbox: (...args: unknown[]) => PySandbox };
  const Sandbox = module.Sandbox;
  const save = (session: Session) => (offsetMs: number) => session.asOwner(async (tx) => {
    await tx.query("update demo.clock set offset_ms = $1, moved_at = now()", [offsetMs]);
  });
  const startClock = (opened: Opened) => new DemoClock(Math.max(opened.offsetMs, opened.latestEventMs - Date.now(), 0), save(opened.session));
  let clock = startClock(db);
  const sandboxOn = (opened: Opened) => Sandbox(opened.session, () => clock.nowMs(), deps.token, log);
  let sandbox = sandboxOn(db);
  mark("engine ready");
  const versions = JSON.parse(pyodide.runPython(
    "import json, sys, google.protobuf; json.dumps({'python': sys.version.split()[0], 'protobuf': google.protobuf.__version__})",
  ) as string) as { python: string; protobuf: string };
  const postgres = db.postgres;
  const gate = new Gate();
  // One pass of the jobs at a time: a tick asked during another runs after it, on what that one left.
  let ticking: Promise<unknown> = Promise.resolve();

  const engine: SandboxEngine = {
    info: {
      startMs: Math.round(performance.now() - begun),
      loaded: db.loaded,
      applied: db.migrated.applied,
      versions: { ...versions, postgres },
      steps,
    },
    call: (service, method, metadata, request) => gate.shared(async (): Promise<EngineReply> => {
      // An answer always: what the engine could not serve comes back with gRPC's INTERNAL, as from the server.
      let pending: PyProxyLike | Promise<PyProxyLike> | null = null;
      try {
        pending = sandbox.call(`${service}/${method}`, JSON.stringify(metadata), request);
        const answer = await pending;
        try {
          const [code, message, response] = answer.toJs() as [number, string, Uint8Array];
          return code === 0 ? { ok: true, response } : { ok: false, code, message };
        } finally {
          settle(answer);
        }
      } catch (error) {
        log(JSON.stringify({ level: "error", event: "rpc_failed", method: `${service}/${method}`, error: String(error) }));
        return { ok: false, code: 13, message: "the engine in this browser failed on this call; its log has the details" };
      } finally {
        settle(pending);
      }
    }),
    tick: () => {
      const pass = ticking.then(() => gate.shared(async () => JSON.parse(await sandbox.tick()) as { ran: number; changed: Changed[] }));
      ticking = pass.catch(() => {});
      return pass;
    },
    clock: {
      now: () => clock.now(),
      advanceTo: (instant) => clock.advanceTo(instant),
      nextDue: () => gate.shared(async () => {
        const due = await sandbox.next_due();
        return typeof due === "string" ? new Date(due) : null;
      }),
    },
    skipToNextLaunch: async () => {
      type Due = { at: string; change: number; starts: string };
      const due = async (change?: number) => gate.shared(async () => JSON.parse(await sandbox.launches_due(change)) as Due[]);
      const [first] = await due();
      if (!first) return null;
      const from = clock.now();
      const changed = new Set<Changed>();
      const pass = async () => {
        for (const word of (await engine.tick()).changed) changed.add(word);
      };
      clock.advanceTo(new Date(first.at));
      for (let passes = 0; passes < SKIP_PASSES; passes += 1) {
        await pass();
        const [again] = await due(first.change);
        if (!again) break;
        clock.advanceTo(new Date(again.at));
      }
      const state = await gate.shared(() => sandbox.launch_state(first.change));
      if (state === "done") {
        clock.advanceTo(new Date(first.starts));
        await pass();
      }
      return { from, to: clock.now(), changed: CHANGES.filter((word) => changed.has(word)) };
    },
    faults: {
      arm: (step) => {
        if (!LAUNCH_STEPS.includes(step)) throw new RangeError(`a launch has the steps ${LAUNCH_STEPS.join(", ")}`);
        sandbox.arm_fault(step);
      },
      clear: () => sandbox.clear_fault(),
      armed: () => (sandbox.armed_fault() ?? null) as LaunchStep | null,
    },
    reset: () => gate.exclusive(async () => {
      await clock.saved();
      await db.saved.catch(() => {});
      await db.session.pg.close();
      if (deps.remove) await deps.remove();
      db = await open(true);
      clock = startClock(db);
      settle(sandbox);
      sandbox = sandboxOn(db);
    }),
    close: () => gate.exclusive(async () => {
      await clock.saved();
      await db.saved.catch(() => {});
      settle(sandbox);
      await db.session.pg.close();
    }),
  };
  return engine;
}
