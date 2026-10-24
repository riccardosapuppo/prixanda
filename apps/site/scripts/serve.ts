// npm run serve -w site: the static build in apps/site/out, served on
// 127.0.0.1:4632 (SITE_PORT) the way any static host would serve it: a file
// for each address, /campaign/ as campaign/index.html, 404.html for the rest.
// Nothing else: no proxy, no rewrite, no header the build does not set. The
// end-to-end tests use it, so they test the files that would be published.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFree } from "../../../tools/lib/ports.ts";

export const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

async function fileFor(root: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = normalize(join(root, decoded));
  // Nothing outside the build, whatever the address says.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  for (const path of [candidate, join(candidate, "index.html"), `${candidate}.html`]) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      // try the next form
    }
  }
  return null;
}

/** Serves `root` on 127.0.0.1:`port`; resolves once it listens. */
export async function serveStatic(root: string, port: number): Promise<Server> {
  const base = normalize(root);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const found = await fileFor(base, url.pathname);
    const path = found ?? join(base, "404.html");
    const status = found ? 200 : 404;
    response.writeHead(status, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(path).on("error", () => response.destroy()).pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env["SITE_PORT"] ?? 4632);
  await assertFree(port, "the site");
  await serveStatic(join(siteDir, "out"), port);
  console.log(`[site] apps/site/out on http://127.0.0.1:${port}/ (Ctrl+C stops it)`);
}
