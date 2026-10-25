// The worker's tests' static server: the test page at /, its script at
// /page.js, and the sandbox's folders at /sandbox/, as a static host serves
// the demo; the first mount that holds a file serves it. It listens on
// 127.0.0.1, on a port of the system's choosing.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".map": "application/json", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".zip": "application/zip", ".whl": "application/zip", ".gz": "application/gzip", ".data": "application/octet-stream",
};

export const PAGE = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sandbox</title><script type="module" src="/page.js"></script></html>';

export type Served = { readonly origin: string; close(): Promise<void> };

/** Serves `mounts` (a URL prefix and its folder, in order) and the page at /. */
export async function serveSandbox(mounts: ReadonlyArray<readonly [prefix: string, dir: string]>): Promise<Served> {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://sandbox.invalid").pathname);
    if (path === "/") {
      response.writeHead(200, { "content-type": TYPES[".html"] ?? "text/html" }).end(PAGE);
      return;
    }
    for (const [prefix, dir] of mounts) {
      if (!path.startsWith(prefix)) continue;
      const file = normalize(join(dir, path.slice(prefix.length)));
      if (!file.startsWith(normalize(dir) + sep) || !(await stat(file).catch(() => null))?.isFile()) continue;
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      response.end(await readFile(file));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** Chromium with every host but the test server's unreachable: what is not the origin's cannot load. */
export const ISOLATED = ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"];
