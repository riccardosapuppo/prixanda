// The test page's script for the worker's tests in Chromium: the client the
// apps use, opening the origin's worker as the site (?app=site, the default)
// or the console (?app=console) of the build ?build= would, with what it
// heard kept on window for the test to read. ?dedicated takes SharedWorker
// away first, as a browser without it.
import { openBackend } from "../../src/client.ts";
import type { CommandName } from "../../src/protocol.ts";

type Answer = { status: number; body: unknown };

declare global {
  interface Window {
    demo: ReturnType<typeof openBackend>;
    /** Every step the worker showed while it started, in order. */
    progress: Array<{ step: string; done: number; of: number }>;
    changed: string[][];
    resets: number;
    ask(query: string, variables?: Record<string, unknown>): Promise<Answer>;
    command(name: CommandName, args?: unknown): Promise<Answer>;
  }
}

const params = new URL(location.href).searchParams;
if (params.has("dedicated")) Reflect.deleteProperty(globalThis, "SharedWorker");
const app = params.get("app") === "console" ? "console" : "site";
window.demo = openBackend({ app, build: params.get("build") ?? "test-build" });
window.progress = [];
window.changed = [];
window.resets = 0;
window.demo.subscribe(() => {
  const status = window.demo.status();
  if (status.state === "starting" && status.step !== null) window.progress.push({ step: status.step, done: status.done, of: status.of });
});
window.demo.onChanged((what) => window.changed.push([...what]));
window.demo.onReset(() => {
  window.resets += 1;
});

// The CSRF token of the session this tab started, sent back with every mutation, as the apps do.
let csrf: string | null = null;
window.ask = async (query, variables) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrf !== null) headers["x-csrf-token"] = csrf;
  if (query.trimStart().startsWith("mutation")) headers["idempotency-key"] = `key-${crypto.randomUUID()}`;
  const reply = await window.demo.graphql(headers, JSON.stringify({ query, ...(variables ? { variables } : {}) }));
  const body = JSON.parse(reply.body) as { data?: Record<string, { csrfToken?: unknown } | null> };
  for (const field of ["signIn", "signInAsListener"]) {
    const token = body.data?.[field]?.csrfToken;
    if (typeof token === "string") csrf = token;
  }
  return { status: reply.status, body };
};
window.command = async (name, args) => {
  // Any command with any arguments: what the worker answers to one it refuses is part of the test.
  const send = window.demo.command as unknown as (name: CommandName, ...rest: unknown[]) => Promise<{ status: number; body: string }>;
  const reply = await send(name, ...(args === undefined ? [] : [args]));
  return { status: reply.status, body: JSON.parse(reply.body) as unknown };
};
