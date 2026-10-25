// The engine's harness in the browser, for its own tests and measurements
// (browser.test.ts, tools/measure-sandbox.ts): the engine in one worker,
// shared by the tabs of the origin as the demo's will be, and the calls of a
// test page relayed to it. It is not the demo's worker (src/worker.ts, the
// gateway's side): no gateway, no sessions, nothing but the engine.
//
// It runs as a SharedWorker, or as a dedicated worker where the page asks for
// one (the fallback where SharedWorker is missing). The database's name comes
// from the script's address (?db=), so that two harnesses never share one.
import { type SandboxEngine, startEngine } from "../../../src/engine/index.ts";

type Request = { id: number; op: string; args: unknown[] };
type Port = { postMessage(message: unknown): void };

const params = new URL(self.location.href).searchParams;
const database = `idb://${params.get("db") ?? "engine-harness"}`;
const workerId = crypto.randomUUID();
const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
const begun = performance.now();
const progress: Array<[string, number]> = [];
let bootMs: number | null = null;
let ports = 0;
let engine: Promise<SandboxEngine> | null = null;

function start(): Promise<SandboxEngine> {
  engine ??= startEngine({ base: "/sandbox/", database, token, onProgress: (step) => progress.push([step, Math.round(performance.now() - begun)]) })
    .then((ready) => {
      bootMs = Math.round(performance.now() - begun);
      return ready;
    });
  return engine;
}

async function answer(e: SandboxEngine, op: string, args: unknown[]): Promise<unknown> {
  switch (op) {
    case "info":
      return { info: e.info, bootMs, progress, workerId, ports, database };
    case "call": {
      const [service, method, metadata, bytes] = args as [string, string, Record<string, string>, number[]];
      const headers = { ...metadata };
      if (headers["x-test-token"] === "none") delete headers["authorization"];
      else headers["authorization"] = `Bearer ${token}`;
      delete headers["x-test-token"];
      const reply = await e.call(service, method, headers, new Uint8Array(bytes));
      return reply.ok ? { ok: true, response: Array.from(reply.response) } : reply;
    }
    case "tick":
      return e.tick();
    case "now":
      return e.clock.now().toISOString();
    case "nextDue":
      return (await e.clock.nextDue())?.toISOString() ?? null;
    case "advanceTo":
      e.clock.advanceTo(new Date(args[0] as string));
      return e.clock.now().toISOString();
    case "arm":
      e.faults.arm(args[0] as "publish");
      return e.faults.armed();
    case "armed":
      return e.faults.armed();
    case "skip": {
      const skipped = await e.skipToNextLaunch();
      return skipped && { from: skipped.from.toISOString(), to: skipped.to.toISOString(), changed: skipped.changed };
    }
    case "reset":
      await e.reset();
      return { info: e.info };
    default:
      throw new Error(`no operation ${op}`);
  }
}

function serve(port: Port, request: Request): void {
  const reply = (body: object) => port.postMessage({ id: request.id, ...body });
  start()
    .then((e) => answer(e, request.op, request.args))
    .then((value) => reply({ value }), (error: unknown) => reply({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) }));
}

const scope = self as unknown as { onconnect?: unknown; onmessage?: unknown };
if ("onconnect" in scope) {
  scope.onconnect = (event: MessageEvent) => {
    const port = event.ports[0] as MessagePort;
    ports += 1;
    port.onmessage = ({ data }) => serve(port, data as Request);
    port.start();
  };
} else {
  ports = 1;
  scope.onmessage = ({ data }: MessageEvent) => serve(self as unknown as Port, data as Request);
}
start().catch(() => {});
