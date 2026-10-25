// The site in the browser demo's sandbox (stage 8; docs/business.md keeps it apart from the full system).
// Built with SANDBOX=1, the site sends its requests to the sandbox's worker
// instead of the gateway over HTTP: the same schema, the engine's own Python
// code and the same migrations, running in this browser for every tab of the
// origin. Nothing above the transport changes.
//
// The tab's side of the worker is the sandbox package's client
// (packages/sandbox/src/client.ts), the same for the site and the console: it
// says hello, waits for ready while the worker reports its steps (once per
// origin), sends each request to the public API and gets the reply with the
// id it sent, and passes on what the engine's jobs changed and a start over.
// Here are the site's own parts: what it reads again after a change, and its
// transport over the worker, which says a worker that failed the way the HTTP
// transport says a gateway it cannot reach.
import {
  type Backend, BackendFailure, type BackendStatus, connectBackend, missingInBrowser, openBackend, type Port, stoppedBackend,
} from "sandbox/client";
import type { Changed } from "sandbox/protocol";
import { keys } from "./keys.ts";
import { readAnswer, type Transport, TransportFailure } from "./transport.ts";

export type Sandbox = Backend;
export type SandboxStatus = BackendStatus;
export type { Port };
export { missingInBrowser };

/** The sandbox over any port that carries the messages, as the site's tab: the tests drive it with a fake worker. */
export function connectSandbox(port: Port, { build }: { readonly build: string }): Sandbox {
  return connectBackend(port, { app: "site", build });
}

/** The origin's one worker, the one the console's tabs share; a dedicated worker where the browser has no SharedWorker. */
export function openSandbox(build: string): Sandbox {
  return openBackend({ app: "site", build });
}

/** A sandbox that never starts, for the page as it is rendered at build time and for a browser that cannot run the demo. */
export function stoppedSandbox(status: SandboxStatus): Sandbox {
  return stoppedBackend(status);
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
      let reply;
      try {
        reply = await sandbox.graphql(headers, body, signal);
      } catch (error) {
        // A worker that failed, never loaded or belongs to another build: no answer, as from an API out of reach.
        if (error instanceof BackendFailure) throw new TransportFailure(error.message);
        throw error;
      }
      return readAnswer(reply.status, (name) => reply.headers[name] ?? null, reply.body);
    },
  };
}
