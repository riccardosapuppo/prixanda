// The demo's sandbox from a test (stage 8): a connection of the test's own to
// the worker of the origin, opened inside a page of the demo, that speaks the
// protocol of packages/sandbox as a console tab would. Through it the test
// drives the console's API (to launch a campaign the site should then find)
// and the demo's commands, without the console's pages, which have tests of
// their own.
//
// The worker keeps one session per API for every tab of the origin, as a
// browser keeps one cookie: a session here signs its person in again before
// each call, so two people take turns on the one session. Signing in over a
// session that exists takes that session's CSRF token, as any mutation does,
// so it is read first.
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { type CommandName, WORKER_NAME, WORKER_URL } from "sandbox/protocol";
import type { Answer, Session } from "./console.ts";

type Reply = { readonly status: number; readonly headers: Record<string, string>; readonly body: string };

/** Opens the test's connection to the origin's worker in this page, once, and waits for ready. */
export async function connectWorker(page: Page, build: string): Promise<void> {
  await page.evaluate(async ({ url, name, build }) => {
    const scope = window as unknown as Record<string, unknown>;
    if (scope["__demoWorker"]) return;
    const worker = new SharedWorker(url, { type: "module", name });
    const port = worker.port;
    const pending = new Map<number, (message: unknown) => void>();
    let next = 1;
    let arrived: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    port.onmessage = (event: MessageEvent) => {
      const message = event.data as { kind?: string; id?: number };
      if (message?.kind === "ready") arrived();
      if (message?.kind === "reply" && typeof message.id === "number") {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    };
    port.start();
    port.postMessage({ kind: "hello", app: "console", build });
    await ready;
    scope["__demoWorker"] = {
      ask: (message: Record<string, unknown>) => new Promise((resolve) => {
        const id = next;
        next += 1;
        pending.set(id, resolve);
        port.postMessage({ ...message, id });
      }),
    };
  }, { url: WORKER_URL, name: WORKER_NAME, build });
}

async function ask(page: Page, message: Record<string, unknown>): Promise<Reply> {
  return page.evaluate((sent) => (window as unknown as { __demoWorker: { ask(m: unknown): Promise<Reply> } }).__demoWorker.ask(sent), message);
}

async function graphql(page: Page, query: string, variables: Record<string, unknown>, headers: Record<string, string>): Promise<Answer> {
  const reply = await ask(page, {
    kind: "graphql",
    api: "internal",
    headers: { "content-type": "application/json", ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])) },
    body: JSON.stringify({ query, variables }),
  });
  let body: any = null;
  try {
    body = reply.body ? JSON.parse(reply.body) : null;
  } catch {
    body = null;
  }
  return { status: reply.status, body, text: reply.body };
}

/** One of the demo's people on the console's API, through the worker of the page. */
export async function workerSession(page: Page, person: string): Promise<Session> {
  const signIn = async () => {
    const current = await graphql(page, "query { session { csrfToken } }", {}, {});
    const held: unknown = current.body?.data?.session?.csrfToken;
    const answer = await graphql(page, "mutation SignIn($id: ID!) { signIn(personId: $id) { csrfToken } }", { id: person },
      typeof held === "string" ? { "x-csrf-token": held } : {});
    const token = answer.body?.data?.signIn?.csrfToken;
    if (typeof token !== "string") throw new Error(`could not sign in as ${person} through the worker: ${answer.text}`);
    return token;
  };
  await signIn();
  return {
    async graphql(query, variables = {}, headers = {}) {
      const csrf = await signIn();
      const sent: Record<string, string> = { "x-csrf-token": csrf, ...headers };
      if (/^\s*mutation\b/.test(query) && sent["idempotency-key"] === undefined) sent["idempotency-key"] = `demo-e2e-${randomUUID()}`;
      return graphql(page, query, variables, sent);
    },
  };
}

/** One of the demo's commands, as the console's controls send it. */
export async function demoCommand(page: Page, name: CommandName, args?: unknown): Promise<{ status: number; body: any }> {
  const reply = await ask(page, { kind: "command", name, ...(args === undefined ? {} : { args }) });
  let body: any = null;
  try {
    body = JSON.parse(reply.body);
  } catch {
    body = reply.body;
  }
  return { status: reply.status, body };
}

/** A wall-clock time in Rome, as the console writes it: 2026-11-02T09:00. */
export function romeLocal(instant: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}
