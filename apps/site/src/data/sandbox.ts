// The site in the demo's sandbox (stage 8, BRIEF-TAPPA-8-DEMO.md, part 3).
// Built with SANDBOX=1, the site sends its requests to the sandbox's worker
// instead of the gateway over HTTP: the same schema, the engine's own Python
// code and the same migrations, running in this browser for every tab of the
// origin. Nothing above the transport changes.
//
// The tab speaks the protocol of packages/sandbox/src/protocol.ts: it says
// hello, waits for ready (the worker reports its steps while it starts, once
// per origin), then sends each request as a graphql message and gets the
// reply with the id it sent. After the engine's jobs ran the worker says what
// changed, and the data layer reads it again; after a reset, the tab reloads.
//
// connectSandbox works on any port that carries the messages, so the tests
// drive it with a fake worker; openSandbox opens the real one. When the
// gateway's client (packages/sandbox/src/client.ts) is ready, openSandbox
// opens the worker through it, and nothing else here changes.
import {
  type Changed, type CommandArgs, type CommandName, type FromWorker, parseFromWorker, type ReadyInfo, WORKER_NAME, WORKER_URL,
} from "sandbox/protocol";
import { keys } from "./keys.ts";
import { readAnswer, type Transport, TransportFailure } from "./transport.ts";

export type SandboxStatus =
  | { readonly state: "starting"; readonly step: string | null; readonly done: number; readonly of: number }
  | { readonly state: "ready"; readonly info: ReadyInfo }
  /** The worker that answered was built for another deploy than this tab's. */
  | { readonly state: "other-build"; readonly info: ReadyInfo }
  | { readonly state: "failed"; readonly reason: string; readonly browser: boolean };

/** What carries the messages: a SharedWorker's port, a dedicated worker, or a test's fake. */
export type Port = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  start?(): void;
};

export type Reply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string };

export type Sandbox = {
  status(): SandboxStatus;
  /** Called on every change of status (useSyncExternalStore). */
  subscribe(listener: () => void): () => void;
  /** What the engine's jobs changed: the tab reads it again. */
  onChanged(listener: (what: readonly Changed[]) => void): () => void;
  /** The demo started over: every tab reloads. */
  onReset(listener: () => void): () => void;
  graphql(headers: Readonly<Record<string, string>>, body: string, signal?: AbortSignal): Promise<Reply>;
  command<N extends CommandName>(name: N, ...args: CommandArgs[N] extends undefined ? [] : [CommandArgs[N]]): Promise<Reply>;
  /** The worker could not be reached at all (its script did not load): the demo cannot start. */
  broken(reason: string): void;
};

type Pending = { resolve(reply: Reply): void; reject(error: Error): void };

/** The sandbox over a port: hello first, then requests once the worker is ready. */
export function connectSandbox(port: Port, { build }: { readonly build: string }): Sandbox {
  let status: SandboxStatus = { state: "starting", step: null, done: 0, of: 0 };
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

  const set = (value: SandboxStatus) => {
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
        if (message.info.build !== build) {
          set({ state: "other-build", info: message.info });
          fail(new TransportFailure("the demo's worker belongs to another version of the demo"));
          return;
        }
        set({ state: "ready", info: message.info });
        settle.resolve();
        return;
      case "failed":
        set({ state: "failed", reason: message.reason, browser: false });
        fail(new TransportFailure(message.reason));
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
  port.postMessage({ kind: "hello", app: "site", build });

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
    graphql: (headers, body, signal) => ask((id) => ({ kind: "graphql", id, api: "public", headers: { ...headers }, body }), signal),
    command: (name, ...args) => ask((id) => ({ kind: "command", id, name, ...(args.length > 0 ? { args: args[0] } : {}) })),
    broken(reason) {
      if (status.state === "ready") return;
      set({ state: "failed", reason, browser: false });
      fail(new TransportFailure(reason));
    },
  };
}

/** What the site reads again after the engine's jobs changed something; the rest belongs to the console. */
export const READ_AGAIN: Readonly<Record<Changed, readonly (readonly string[])[]>> = {
  catalog: [keys.markets, ["plans"], ["offers"], ["prepaid-passes"]],
  launches: [["offers"], ["prepaid-passes"]],
  accounts: [keys.me],
  changes: [],
  audit: [],
};

/** The site's requests as messages to the sandbox's worker, read the way httpTransport reads the gateway's answers. */
export function sandboxTransport(sandbox: Sandbox): Transport {
  return {
    async send(request, signal) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
      const body = JSON.stringify({ operationName: request.operationName, query: request.query, variables: request.variables });
      const reply = await sandbox.graphql(headers, body, signal);
      return readAnswer(reply.status, (name) => reply.headers[name] ?? null, reply.body);
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

/** A sandbox that never starts, for the page as it is rendered at build time and for a browser that cannot run the demo. */
export function stoppedSandbox(status: SandboxStatus): Sandbox {
  const never = () => new Promise<Reply>(() => undefined);
  return {
    status: () => status,
    subscribe: () => () => undefined,
    onChanged: () => () => undefined,
    onReset: () => () => undefined,
    graphql: status.state === "failed" ? () => Promise.reject(new TransportFailure(status.reason)) : never,
    command: status.state === "failed" ? () => Promise.reject(new TransportFailure(status.reason)) : never,
    broken: () => undefined,
  };
}

const UNREACHABLE = "the demo's engine could not be loaded from this address";

/**
 * The real worker: the one SharedWorker of the origin, or, where the browser
 * has none (Chrome on Android), a dedicated worker for this tab.
 */
export function openSandbox(build: string): Sandbox {
  if (typeof window === "undefined") return stoppedSandbox({ state: "starting", step: null, done: 0, of: 0 });
  const missing = missingInBrowser(globalThis as unknown as Parameters<typeof missingInBrowser>[0]);
  if (missing !== null) return stoppedSandbox({ state: "failed", reason: missing, browser: true });
  try {
    if (typeof SharedWorker !== "undefined") {
      const worker = new SharedWorker(WORKER_URL, { type: "module", name: WORKER_NAME });
      const sandbox = connectSandbox(worker.port as unknown as Port, { build });
      worker.addEventListener("error", () => sandbox.broken(UNREACHABLE));
      return sandbox;
    }
    const worker = new Worker(WORKER_URL, { type: "module", name: WORKER_NAME });
    const sandbox = connectSandbox(worker as unknown as Port, { build });
    worker.addEventListener("error", () => sandbox.broken(UNREACHABLE));
    return sandbox;
  } catch (error) {
    return stoppedSandbox({ state: "failed", reason: error instanceof Error ? error.message : String(error), browser: true });
  }
}
