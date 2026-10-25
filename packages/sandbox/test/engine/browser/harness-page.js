// The test page's side of the harness (harness-worker.ts): it opens the
// worker, a SharedWorker unless ?dedicated, and relays a test's operations to
// it as window.harness(op, ...args), which answers a Promise.
const params = new URLSearchParams(location.search);
const db = params.get("db") ?? "engine-harness";
const address = `/harness-worker.js?db=${encodeURIComponent(db)}`;
const shared = !params.has("dedicated") && typeof SharedWorker === "function";
const worker = shared ? new SharedWorker(address, { type: "module", name: "engine-harness" }) : new Worker(address, { type: "module" });
const port = shared ? worker.port : worker;
const pending = new Map();
let next = 1;
window.harnessShared = shared;
window.harnessErrors = [];
worker.onerror = (event) => window.harnessErrors.push(String(event.message ?? event));
port.onmessage = ({ data }) => {
  const waiting = pending.get(data.id);
  if (!waiting) return;
  pending.delete(data.id);
  if ("error" in data) waiting.reject(new Error(data.error));
  else waiting.resolve(data.value);
};
if (shared) port.start();
window.harness = (op, ...args) => new Promise((resolve, reject) => {
  const id = next;
  next += 1;
  pending.set(id, { resolve, reject });
  port.postMessage({ id, op, args });
});
