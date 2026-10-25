// npm run e2e -w site: the site's end-to-end tests, on their own.
//
// It builds the site for the API the tests start (the gateway's public API on
// CHECK_GATEWAY_PUBLIC_PORT), then runs each file of e2e/ in turn: each
// starts PostgreSQL, the engine, the gateway and the site on the check's
// ports, drives a headless Chromium through its journeys and stops
// everything. student-autumn.e2e.ts is stage 5's (§14.1), gift-and-price.e2e.ts
// and album-release.e2e.ts stage 7's (§14.3, §14.4; §14.2); name one to run
// it alone. Needs npm run setup (the engine's Python environment) and
// Playwright's Chromium for playwright 1.62.1.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_API } from "../e2e/support/stack.ts";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");

function node(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const child = spawn(process.execPath, args, { cwd: site, stdio: "inherit", windowsHide: true, env });
  return new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const FILES = ["student-autumn.e2e.ts", "gift-and-price.e2e.ts", "album-release.e2e.ts"];
const asked = process.argv.slice(2);
const files = asked.length > 0 ? FILES.filter((file) => asked.some((name) => file.startsWith(name))) : FILES;
if (files.length === 0) throw new Error(`no end-to-end file named ${asked.join(", ")}: ${FILES.join(", ")}`);

console.log(`[site e2e] building the site for ${PUBLIC_API}`);
let code = await node([join(site, "scripts", "next.ts"), "build"], { ...process.env, NEXT_PUBLIC_SITE_API: PUBLIC_API });
// One file at a time: each starts the whole system on the same ports.
for (const file of files) {
  if (code !== 0) break;
  code = await node(["--test", "--test-reporter=spec", join("e2e", file)]);
}
process.exitCode = code;
