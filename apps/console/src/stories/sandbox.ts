// A demo's worker for the stories (stage 8): the sandbox's own client
// (sandbox/client) over a port of the story's, which answers the demo's
// commands from a small state (the clock, the next launch due, the fault
// armed) and records what the tab asked. The console's requests themselves go
// through the story's fake gateway, as in every other story.
import { type Backend, connectBackend, type Port, stoppedBackend } from "sandbox/client";
import type { LaunchStep, Status } from "sandbox/protocol";

export type FakeDemo = {
  readonly sandbox: Backend;
  /** The commands the tab sent, by name. */
  readonly commands: string[];
};

type Options = {
  /** Where the worker stands: still starting at a step, ready, or of another build. */
  readonly state: { readonly kind: "starting"; readonly step: string; readonly done: number; readonly of: number } | { readonly kind: "ready" };
  readonly now?: string;
  readonly nextDue?: string | null;
  readonly armed?: LaunchStep | null;
};

/** A worker that answers on its own: ready (or starting) at once, then each command from its state. */
export function fakeDemo(options: Options): FakeDemo {
  const status: { now: string; nextDue: string | null; armed: LaunchStep | null } = {
    now: options.now ?? "2026-10-25T08:42:00Z", nextDue: options.nextDue ?? null, armed: options.armed ?? null,
  };
  const commands: string[] = [];
  let listener: (event: { readonly data: unknown }) => void = () => undefined;
  const speak = (data: unknown) => queueMicrotask(() => listener({ data }));
  const reply = (id: unknown, code: number, body: unknown) => speak({ kind: "reply", id, status: code, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const port: Port = {
    addEventListener: (_type, given) => {
      listener = given;
    },
    postMessage(message) {
      const sent = message as { kind: string; id?: number; name?: string; args?: { step?: LaunchStep } };
      if (sent.kind === "hello") {
        if (options.state.kind === "starting") speak({ kind: "progress", step: options.state.step, done: options.state.done, of: options.state.of });
        else speak({ kind: "ready", info: { bootMs: 4200, alreadyRunning: false, build: "story", now: status.now } });
        return;
      }
      if (sent.kind !== "command") return;
      commands.push(sent.name ?? "");
      switch (sent.name) {
        case "status":
          reply(sent.id, 200, { build: "story", now: status.now, nextDue: status.nextDue, armed: status.armed, shared: true } satisfies Status);
          return;
        case "arm-fault":
          status.armed = sent.args?.step ?? "publish";
          reply(sent.id, 200, { armed: status.armed });
          return;
        case "clear-fault":
          status.armed = null;
          reply(sent.id, 200, { armed: null });
          return;
        case "skip-to-next-launch": {
          if (status.nextDue === null) {
            reply(sent.id, 409, { error: "No launch is due on the demo's clock." });
            return;
          }
          const from = status.now;
          const to = new Date(Date.parse(status.nextDue) + 60_000).toISOString().replace(".000Z", "Z");
          Object.assign(status, { now: to, nextDue: null, armed: null });
          reply(sent.id, 200, { from, to, changed: ["catalog", "changes", "launches", "audit"] });
          return;
        }
        case "reset":
          reply(sent.id, 200, { now: status.now });
          return;
        default:
          reply(sent.id, 400, { error: `no command ${String(sent.name)}` });
      }
    },
  };
  return { sandbox: connectBackend(port, { app: "console", build: "story" }), commands };
}

/** A browser that cannot run the demo: it lacks what the demo needs. */
export function demoThatCannotRun(missing: string): FakeDemo {
  return { sandbox: stoppedBackend({ state: "failed", reason: missing, browser: true }), commands: [] };
}
