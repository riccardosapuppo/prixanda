// The site is a static build: HTML, CSS and JavaScript that any web server can
// serve (output: "export"). Nothing runs on a server of the site's own. Every
// figure a page shows is asked for by the browser, from the gateway's public
// schema, through the transport in src/data/transport.ts; in stage 8 the same
// build runs with the schema executed in the browser instead.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  output: "export",
  // /campaign/ is written as campaign/index.html, which every static server finds.
  trailingSlash: true,
  reactStrictMode: true,
  typedRoutes: true,
  poweredByHeader: false,
  // The shared identity is TypeScript and CSS, not a built package.
  transpilePackages: ["design"],
  images: { unoptimized: true },
  devIndicators: false,
  // next dev would otherwise write instructions for coding tools into the
  // repository; nothing of the kind belongs in it.
  agentRules: false,
  experimental: {
    // No call to the npm registry during a build: builds stay reproducible
    // offline. The advisories against the pinned version are checked by hand
    // and weighed in the README (none applies to a static export).
    agentUpgrade: false,
  },
  // The workspace's root, so the shared packages and the hoisted node_modules resolve.
  turbopack: { root: join(here, "..", "..") },
};

export default config;
