// The sandbox's worker script, served at /sandbox/backend.js (stage 8): the
// one backend of the origin (worker.ts) bound to the worker's global scope
// and to the engine in the page. As a SharedWorker every tab connects to it;
// as a dedicated worker (where the browser has no SharedWorker) its own tab
// talks to it directly. scripts/build.ts bundles it: "sandbox-engine" is the
// engine's side of the package (src/engine/), and __SANDBOX_BUILD__ the
// build's fingerprint, which ready tells every tab.
import { startEngine } from "sandbox-engine";
import { WORKER_NAME } from "./protocol.ts";
import { createBackend, type Port } from "./worker.ts";

declare const __SANDBOX_BUILD__: string;

type SharedScope = { addEventListener(type: "connect", listener: (event: { readonly ports: readonly Port[] }) => void): void };
const sharedScope = (globalThis as { SharedWorkerGlobalScope?: abstract new () => unknown }).SharedWorkerGlobalScope;
const shared = sharedScope !== undefined && globalThis instanceof sharedScope;

const backend = createBackend({
  startEngine,
  build: __SANDBOX_BUILD__,
  // The engine's files are served beside this script: /sandbox/.
  base: new URL("./", import.meta.url).pathname,
  // The data in IndexedDB, under the worker's name: one database for the origin, as there is one worker.
  database: `idb://${WORKER_NAME}`,
  shared,
  // Where the browser has Web Locks (every one that runs the demo), the database is one worker's at a time.
  ...(navigator.locks ? { locks: navigator.locks } : {}),
});

if (shared) {
  (globalThis as unknown as SharedScope).addEventListener("connect", (event) => {
    for (const port of event.ports) backend.connect(port);
  });
} else {
  backend.connect(globalThis as unknown as Port);
}
