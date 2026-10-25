// The test page's script for the worker's test in Chromium: the client the
// apps use, opening the origin's worker, with its answers kept on window for
// the test to read.
import { openBackend } from "../../src/client.ts";

declare global {
  interface Window {
    demo: ReturnType<typeof openBackend>;
    changed: string[][];
    resets: number;
    ask(query: string, variables?: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  }
}

const build = new URL(location.href).searchParams.get("build") ?? "test-build";
window.demo = openBackend({ app: "site", build });
window.changed = [];
window.resets = 0;
window.demo.onChanged((what) => window.changed.push([...what]));
window.demo.onReset(() => {
  window.resets += 1;
});
let csrf: string | null = null;
window.ask = async (query, variables) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrf !== null) headers["x-csrf-token"] = csrf;
  if (query.trimStart().startsWith("mutation")) headers["idempotency-key"] = `key-${crypto.randomUUID()}`;
  const reply = await window.demo.graphql(headers, JSON.stringify({ query, ...(variables ? { variables } : {}) }));
  const body = JSON.parse(reply.body) as { data?: { signInAsListener?: { csrfToken?: string } } };
  const token = body.data?.signInAsListener?.csrfToken;
  if (typeof token === "string") csrf = token;
  return { status: reply.status, body };
};
