// The engine harness's static server, for the browser's tests and the
// measurements: the engine's files at /sandbox/ (what the build wrote) and the
// harness at /, compressed with gzip as a web host compresses them, with the
// cache headers a deploy would send (the files whose name carries their hash
// kept for a year, the others revalidated, the manifest never kept). It
// counts what it sends, whichever worker asks, and can pace every response
// through one shared pipe of so many megabits per second, after a latency, to
// stand for a slower network. And a later visit, as the tests and the
// measurements of both workers make one (laterVisit).
import { createServer, type Server } from "node:http";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import type { BrowserContext } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".wasm": "application/wasm", ".data": "application/octet-stream", ".zip": "application/zip",
  ".whl": "application/zip", ".gz": "application/gzip", ".map": "application/json",
};
/** What a host compresses: text, WebAssembly and PGlite's file system; not the archives, already compressed. */
const COMPRESSED = new Set([".html", ".js", ".mjs", ".json", ".wasm", ".data", ".map"]);
const HASHED = /-[0-9a-f]{12}\.(zip|json|tar\.gz)$/;

/** Bundles the harness's worker with esbuild, as the demo's build bundles its worker, beside the page. */
export async function buildHarness(outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [join(here, "harness-worker.ts")],
    outfile: join(outDir, "harness-worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "warning",
  });
  for (const name of ["harness.html", "harness-page.js"]) await copyFile(join(here, name), join(outDir, name));
  return outDir;
}

export type Served = {
  readonly origin: string;
  /** Bytes sent since the last reset, headers included, and the requests that sent them. */
  bytes(): { readonly total: number; readonly requests: number; readonly paths: Readonly<Record<string, number>> };
  resetBytes(): void;
  close(): Promise<void>;
};

export type ServeOptions = {
  readonly port: number;
  readonly assets: string;
  readonly harness: string;
  /** A pipe of so many megabits per second, shared by every response; none: as fast as the machine. */
  readonly mbps?: number;
  readonly latencyMs?: number;
};

export async function serve(options: ServeOptions): Promise<Served> {
  const mounts: Array<[string, string]> = [["/sandbox/", options.assets], ["/", options.harness]];
  const packed = new Map<string, Buffer>();
  const bytesPerMs = options.mbps ? (options.mbps * 1_000_000) / 8 / 1000 : 0;
  let pipeFreeAt = 0;
  let counted = { total: 0, requests: 0, paths: {} as Record<string, number> };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://harness");
      const mount = mounts.find(([prefix]) => url.pathname.startsWith(prefix));
      if (request.method !== "GET" || !mount) {
        response.writeHead(404).end();
        return;
      }
      const [prefix, root] = mount;
      const file = normalize(join(root, decodeURIComponent(url.pathname.slice(prefix.length))));
      if (!file.startsWith(normalize(root) + sep) || !(await stat(file).catch(() => null))?.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      const facts = await stat(file);
      const etag = `"${facts.size.toString(16)}-${Math.round(facts.mtimeMs).toString(16)}"`;
      const headers: Record<string, string> = { "content-type": type, etag };
      if (request.headers["if-none-match"] === etag) {
        counted.total += etag.length + 40;
        counted.requests += 1;
        response.writeHead(304, { etag }).end();
        return;
      }
      let body: Buffer = await readFile(file);
      const gzip = COMPRESSED.has(extname(file)) && /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""));
      if (gzip) {
        const cached = packed.get(file) ?? gzipSync(body, { level: 6 });
        packed.set(file, cached);
        body = cached;
        headers["content-encoding"] = "gzip";
        headers["vary"] = "accept-encoding";
      }
      headers["content-length"] = String(body.length);
      headers["cache-control"] = url.pathname.endsWith("/manifest.json") || extname(file) === ".html" ? "no-cache"
        : HASHED.test(file) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
      const headerBytes = Object.entries(headers).reduce((sum, [k, v]) => sum + k.length + v.length + 4, 17);
      counted.total += body.length + headerBytes;
      counted.requests += 1;
      counted.paths[url.pathname] = (counted.paths[url.pathname] ?? 0) + body.length;
      if (options.latencyMs) await sleep(options.latencyMs);
      response.writeHead(200, headers);
      if (!bytesPerMs) {
        response.end(body);
        return;
      }
      for (let offset = 0; offset < body.length; offset += 16_384) {
        const chunk = body.subarray(offset, offset + 16_384);
        const now = performance.now();
        pipeFreeAt = Math.max(pipeFreeAt, now) + chunk.length / bytesPerMs;
        if (pipeFreeAt > now) await sleep(pipeFreeAt - now);
        if (!response.write(chunk)) await new Promise((resolve) => response.once("drain", resolve));
      }
      response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    bytes: () => counted,
    resetBytes: () => {
      counted = { total: 0, requests: 0, paths: {} };
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/**
 * A later visit, as a visitor makes one: every tab of the origin closed, then
 * a tab that starts a worker of its own, which finds the data in IndexedDB.
 * Chromium ends a SharedWorker a moment after its last tab closes, longer
 * when two tabs had it and on a busy machine, and a tab opened meanwhile
 * finds the old worker still running, its data in memory: so after closing
 * every tab this opens one (`open`) until `isNew` says it found a new worker,
 * waiting a little longer before each try, for 30 s at most. The time is the
 * tab's that found it, from before it opened to its worker's answer.
 */
export async function laterVisit<R>(
  context: BrowserContext,
  open: () => Promise<R>,
  isNew: (opened: R) => boolean,
): Promise<{ readonly opened: R; readonly ms: number; readonly tries: number }> {
  const deadline = performance.now() + 30_000;
  for (let tries = 1; ; tries += 1) {
    for (const page of context.pages()) await page.close();
    await new Promise((resolve) => setTimeout(resolve, Math.min(250 * tries, 2_000)));
    const begun = performance.now();
    const opened = await open();
    if (isNew(opened)) return { opened, ms: performance.now() - begun, tries };
    if (performance.now() > deadline) throw new Error(`the worker outlived its tabs: ${tries} tabs opened in 30 s after the last one closed found it still running`);
  }
}
