// The console builds to static files (output: "export"): every page is HTML,
// CSS and JavaScript that any static host can serve, and every number is
// asked for by the browser through the GraphQL transport (src/lib/gateway.ts):
// over HTTP to the gateway, or, built with SANDBOX=1 for the demo (stage 8),
// to the same schema running in this browser's sandbox (src/lib/sandbox.ts),
// under /console/ beside the site. SANDBOX_BUILD names the demo's build, so a
// tab and a worker of two different deploys know each other. So nothing here
// runs on a server at request time.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sandbox = process.env["SANDBOX"] === "1";

const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  // In the demo the console lives under /console/, the site at the origin's root.
  ...(sandbox ? { basePath: "/console" } : {}),
  env: {
    CONSOLE_SANDBOX: sandbox ? "1" : "0",
    CONSOLE_SANDBOX_BUILD: process.env["SANDBOX_BUILD"] ?? "dev",
  },
  reactStrictMode: true,
  // The shared design package and the sandbox's protocol are TypeScript source, compiled with the app.
  transpilePackages: ["design", "sandbox"],
  images: { unoptimized: true },
  turbopack: { root: repoRoot },
  // next dev would otherwise add instruction files of its own to the app's
  // folder; the repository keeps its documentation where it is.
  agentRules: false,
  devIndicators: false,
  experimental: {
    // next build would otherwise ask the npm registry about upgrades on its
    // own, and stop the first time with a SecurityFatalError (README).
    agentUpgrade: false,
    agentFeedback: false,
  },
  outputFileTracingRoot: repoRoot,
};

export default config;
