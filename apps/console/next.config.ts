// The console builds to static files (output: "export"): every page is HTML,
// CSS and JavaScript that any static host can serve, and every number is
// asked for by the browser through the GraphQL transport (src/lib/gateway.ts):
// today over HTTP to the gateway, in stage 8 to the same schema running in
// the page. So nothing here runs on a server at request time.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  // The shared design package is TypeScript source, compiled with the app.
  transpilePackages: ["design"],
  images: { unoptimized: true },
  turbopack: { root: repoRoot },
  // next dev would otherwise add instruction files of its own to the app's
  // folder; the repository keeps its documentation where it is.
  agentRules: false,
  devIndicators: false,
  outputFileTracingRoot: repoRoot,
};

export default config;
