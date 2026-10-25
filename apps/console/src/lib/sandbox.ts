// The console in the demo's sandbox (stage 8; docs/business.md §13.3, §14.6).
// Built with SANDBOX=1, the console sends its requests to the sandbox's
// worker instead of the gateway over HTTP: the same internal schema, the
// engine's own Python code and the same migrations, running in this browser
// for every tab of the origin (the site at /, the console at /console/).
// Nothing above the transport changes: the gateway client of gateway.ts
// receives the same results.
//
// The tab speaks the protocol of packages/sandbox/src/protocol.ts: it says
// hello as the console, waits for ready (the worker reports its steps while
// it starts, once per origin), then sends each request as a graphql message
// for the internal API and gets the reply with the id it sent. After the
// engine's jobs ran the worker says what changed, and the console reads it
// again; after a reset, the tab reloads. The demo's commands (a fault, the
// skip to the next launch, starting over) go the same way.
//
// connectSandbox works on any port that carries the messages, so the tests
// drive it with a fake worker; openSandbox opens the real one.
import {
  type Changed, type CommandArgs, type CommandName, type CommandResults, type FromWorker, parseFromWorker, type ReadyInfo, WORKER_NAME, WORKER_URL,
} from "sandbox/protocol";
import { GatewayError, type GraphQLResult, type GraphQLTransport } from "./gateway.ts";

export type SandboxStatus =
  | { readonly state: "starting"; readonly step: string | null; readonly done: number; readonly of: number }
  | { readonly state: "ready"; readonly info: ReadyInfo }
  /** The worker that answered was built for another deploy than this tab's. */
  | { readonly state: "other-build"; readonly info: ReadyInfo }
  /** browser: this browser lacks what the demo needs (reason names it); otherwise the worker failed, and reason is its own. */
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
  /** What the engine's jobs changed: the console reads it again. */
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
          fail(new Error("the demo's worker belongs to another version of the demo"));
          return;
        }
        set({ state: "ready", info: message.info });
        settle.resolve();
        return;
      case "failed":
        set({ state: "failed", reason: message.reason, browser: false });
        fail(new Error(message.reason));
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
  port.postMessage({ kind: "hello", app: "console", build });

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
    graphql: (headers, body, signal) => ask((id) => ({ kind: "graphql", id, api: "internal", headers: { ...headers }, body }), signal),
    command: (name, ...args) => ask((id) => ({ kind: "command", id, name, ...(args.length > 0 ? { args: args[0] } : {}) })),
    broken(reason) {
      if (status.state === "ready") return;
      set({ state: "failed", reason, browser: false });
      fail(new Error(reason));
    },
  };
}

/**
 * The console's requests as messages to the worker, with the headers the
 * gateway reads over HTTP, and its replies read as httpTransport reads the
 * gateway's answers. A demo that could not start is a gateway that does not
 * answer, said in the demo's words.
 */
export function sandboxTransport(sandbox: Sandbox): GraphQLTransport {
  return {
    async execute(request) {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", "x-request-id": request.requestId };
      if (request.idempotencyKey !== undefined) headers["idempotency-key"] = request.idempotencyKey;
      if (request.csrfToken !== undefined) headers["x-csrf-token"] = request.csrfToken;
      const body = JSON.stringify({ query: request.query, variables: request.variables, operationName: request.operationName });
      let reply: Reply;
      try {
        reply = await sandbox.graphql(headers, body, request.signal);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        throw new GatewayError("UNREACHABLE", `The demo's engine in this browser did not answer: ${error instanceof Error ? error.message : String(error)}.`, request.requestId);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(reply.body);
      } catch {
        throw new GatewayError("BAD_RESPONSE", `The demo's engine answered ${reply.status} without a GraphQL result.`, request.requestId);
      }
      const retryAfter = Number(reply.headers["retry-after"]);
      const result = typeof parsed === "object" && parsed !== null ? (parsed as GraphQLResult) : {};
      return { ...result, status: reply.status, ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}) };
    },
  };
}

/** A command's answer: its result, or the worker's words when it cannot be done now (409) or was malformed (400). */
export async function runCommand<N extends CommandName>(sandbox: Sandbox, name: N, ...args: CommandArgs[N] extends undefined ? [] : [CommandArgs[N]]): Promise<
  { readonly ok: true; readonly result: CommandResults[N] } | { readonly ok: false; readonly status: number; readonly error: string }
> {
  const reply = await sandbox.command(name, ...args);
  let body: unknown = null;
  try {
    body = JSON.parse(reply.body);
  } catch {
    body = null;
  }
  if (reply.status === 200 && body !== null) return { ok: true, result: body as CommandResults[N] };
  const error = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : reply.body;
  return { ok: false, status: reply.status, error };
}

/**
 * What the console reads again after the engine's jobs changed something:
 * the operations whose answers it touches, by name (a query's key starts
 * with its operation's name). The site reads its own (apps/site).
 */
export const READ_AGAIN: Readonly<Record<Changed, readonly string[]>> = {
  catalog: ["PriceList", "Plans", "Markets", "Home", "Week"],
  changes: ["Change", "Changes", "Home", "Week", "Launches"],
  launches: ["LaunchRuns", "LaunchRun", "Launches", "Home", "Change", "Changes"],
  accounts: ["Home"],
  audit: ["AuditEvents"],
};

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
  const refuse = () => Promise.reject(new Error(status.state === "failed" ? status.reason : "the demo is not running"));
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

/** Built for the demo's sandbox (SANDBOX=1): the requests go to the worker in this browser, not to a gateway. */
export const SANDBOX_MODE: boolean = process.env["CONSOLE_SANDBOX"] === "1";

/** The demo build's fingerprint (SANDBOX_BUILD): a tab whose worker belongs to another build reloads once. */
export const SANDBOX_BUILD: string = process.env["CONSOLE_SANDBOX_BUILD"] || "dev";
