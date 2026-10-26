// A tab's side of the sandbox (stage 8): openBackend opens the origin's one
// worker, the SharedWorker every tab of the site and of the console shares,
// or, where the browser has none (Chrome on Android), a dedicated worker for
// this tab; connectBackend speaks the protocol (protocol.ts) over any port,
// the worker's or a test's. A tab says hello, sees the worker's steps while it
// starts, then sends its requests to its app's API: the site's to the public
// one, the console's to the internal one, as over HTTP. What the engine's jobs
// changed, and a start over of the demo, come to every tab.
//
// The site's sandbox (apps/site/src/data/sandbox.ts) came first with the
// same methods; this is the same client for both apps, so that switching to
// it changes nothing above it.
import {
  type Api, type App, type Changed, type CommandArgs, type CommandName, type FromWorker, parseFromWorker, type ReadyInfo, WORKER_NAME, WORKER_URL,
} from "./protocol.ts";

export type BackendStatus =
  | { readonly state: "starting"; readonly step: string | null; readonly done: number; readonly of: number }
  | { readonly state: "ready"; readonly info: ReadyInfo }
  /** The worker that answered was built for another deploy than this tab's: the tab reloads once, then says so. */
  | { readonly state: "other-build"; readonly info: ReadyInfo }
  /** browser: this browser lacks what the demo needs, rather than the demo failing in it. */
  | { readonly state: "failed"; readonly reason: string; readonly browser: boolean };

/** What carries the messages: a SharedWorker's port, a dedicated worker, or a test's channel. */
export type Port = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  start?(): void;
};

export type Reply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string };

/** The demo could not start, or stopped answering: its reason in words. */
export class BackendFailure extends Error {
  override readonly name = "BackendFailure";
}

export type Backend = {
  status(): BackendStatus;
  /** Called on every change of status (for useSyncExternalStore). */
  subscribe(listener: () => void): () => void;
  /** What the engine's jobs changed: the tab reads it again. */
  onChanged(listener: (what: readonly Changed[]) => void): () => void;
  /** The demo started over: the tab reads everything again, signed out. */
  onReset(listener: () => void): () => void;
  /** A request to the app's API, as POST /graphql: header names in lower case, the body as JSON text. */
  graphql(headers: Readonly<Record<string, string>>, body: string, signal?: AbortSignal): Promise<Reply>;
  command<N extends CommandName>(name: N, ...args: CommandArgs[N] extends undefined ? [] : [CommandArgs[N]]): Promise<Reply>;
  /** The worker could not be reached at all (its script did not load): the demo cannot start. */
  broken(reason: string): void;
};

/** Each app speaks to its own API only. */
const API_OF: Readonly<Record<App, Api>> = { site: "public", console: "internal" };

type Pending = { resolve(reply: Reply): void; reject(error: Error): void };

/** The backend over a port: hello first, then the requests, once the worker is ready and of this tab's build. */
export function connectBackend(port: Port, options: { readonly app: App; readonly build: string }): Backend {
  let status: BackendStatus = { state: "starting", step: null, done: 0, of: 0 };
  const listeners = new Set<() => void>();
  const changed = new Set<(what: readonly Changed[]) => void>();
  const resets = new Set<() => void>();
  const pending = new Map<number, Pending>();
  let next = 1;
  let settle: { resolve(): void; reject(error: Error): void } = { resolve: () => undefined, reject: () => undefined };
  const ready = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A failure nobody asked about yet is not an unhandled rejection.
  ready.catch(() => undefined);

  const set = (value: BackendStatus) => {
    status = value;
    for (const listener of listeners) listener();
  };
  const fail = (error: Error) => {
    settle.reject(error);
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.reject(error);
    }
  };

  port.addEventListener("message", (event) => {
    const message: FromWorker | null = parseFromWorker(event.data);
    if (message === null) return;
    switch (message.kind) {
      case "progress":
        if (status.state === "starting") set({ state: "starting", step: message.step, done: message.done, of: message.of });
        return;
      case "ready":
        if (message.info.build !== options.build) {
          set({ state: "other-build", info: message.info });
          fail(new BackendFailure("the demo's worker belongs to another version of the demo"));
          return;
        }
        set({ state: "ready", info: message.info });
        settle.resolve();
        return;
      case "failed":
        set({ state: "failed", reason: message.reason, browser: false });
        fail(new BackendFailure(message.reason));
        return;
      case "reply": {
        const waiting = pending.get(message.id);
        if (waiting === undefined) return;
        pending.delete(message.id);
        waiting.resolve({ status: message.status, headers: message.headers, body: message.body });
        return;
      }
      case "changed":
        for (const listener of changed) listener(message.what);
        return;
      case "reset":
        for (const listener of resets) listener();
        return;
    }
  });
  port.start?.();
  port.postMessage({ kind: "hello", app: options.app, build: options.build });

  const ask = async (message: (id: number) => Record<string, unknown>, signal?: AbortSignal): Promise<Reply> => {
    await ready;
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const id = next;
    next += 1;
    return new Promise<Reply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      signal?.addEventListener("abort", () => {
        // The worker answers anyway; its late reply finds nobody waiting.
        if (pending.delete(id)) reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
      port.postMessage(message(id));
    });
  };

  return {
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onChanged(listener) {
      changed.add(listener);
      return () => changed.delete(listener);
    },
    onReset(listener) {
      resets.add(listener);
      return () => resets.delete(listener);
    },
    graphql: (headers, body, signal) => ask((id) => ({ kind: "graphql", id, api: API_OF[options.app], headers: { ...headers }, body }), signal),
    command: (name, ...args) => ask((id) => ({ kind: "command", id, name, ...(args.length > 0 ? { args: args[0] } : {}) })),
    broken(reason) {
      if (status.state === "ready") return;
      set({ state: "failed", reason, browser: false });
      fail(new BackendFailure(reason));
    },
  };
}

/** What the browser lacks to run the demo, in words; null when it has it all. */
export function missingInBrowser(scope: {
  readonly WebAssembly?: unknown;
  readonly indexedDB?: unknown;
  readonly SharedWorker?: unknown;
  readonly Worker?: unknown;
}): string | null {
  if (typeof scope.WebAssembly !== "object" || scope.WebAssembly === null) return "WebAssembly";
  if (scope.indexedDB === undefined || scope.indexedDB === null) return "IndexedDB";
  if (scope.SharedWorker === undefined && scope.Worker === undefined) return "Web Workers";
  return null;
}

/**
 * A start that failed because the network dropped a download, rather than because of the browser: fetch's words for
 * it in Chromium ("Failed to fetch"), Firefox ("NetworkError") and Safari ("Load failed"), and a host that answered
 * with a server error. A reload tries again, and the files that did arrive stay in the browser's cache.
 */
export function droppedConnection(reason: string): boolean {
  return /failed to fetch|networkerror|network error|load failed|answered 5\d\d/i.test(reason);
}

/** A backend that never answers: for a page rendered at build time, and for a browser that cannot run the demo. */
export function stoppedBackend(status: BackendStatus): Backend {
  const never = () => new Promise<Reply>(() => undefined);
  const refuse = () => Promise.reject(new BackendFailure(status.state === "failed" ? status.reason : "the demo is not running"));
  return {
    status: () => status,
    subscribe: () => () => undefined,
    onChanged: () => () => undefined,
    onReset: () => () => undefined,
    graphql: status.state === "failed" ? refuse : never,
    command: status.state === "failed" ? refuse : never,
    broken: () => undefined,
  };
}

const UNREACHABLE = "the demo's engine could not be loaded from this address";

/**
 * The origin's one worker: the SharedWorker at WORKER_URL under WORKER_NAME,
 * the same for both apps, or a dedicated worker for this tab where the
 * browser has none.
 */
export function openBackend(options: { readonly app: App; readonly build: string }): Backend {
  if (typeof window === "undefined") return stoppedBackend({ state: "starting", step: null, done: 0, of: 0 });
  const missing = missingInBrowser(globalThis as unknown as Parameters<typeof missingInBrowser>[0]);
  if (missing !== null) return stoppedBackend({ state: "failed", reason: missing, browser: true });
  try {
    if (typeof SharedWorker !== "undefined") {
      const worker = new SharedWorker(WORKER_URL, { type: "module", name: WORKER_NAME });
      const backend = connectBackend(worker.port as unknown as Port, options);
      worker.addEventListener("error", () => backend.broken(UNREACHABLE));
      return backend;
    }
    const worker = new Worker(WORKER_URL, { type: "module", name: WORKER_NAME });
    const backend = connectBackend(worker as unknown as Port, options);
    worker.addEventListener("error", () => backend.broken(UNREACHABLE));
    return backend;
  } catch (error) {
    return stoppedBackend({ state: "failed", reason: error instanceof Error ? error.message : String(error), browser: true });
  }
}
