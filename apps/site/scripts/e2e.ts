// npm run e2e -w site: the site's end-to-end test, on its own.
//
// It builds the site for the API the test starts (the gateway's public API on
// CHECK_GATEWAY_PUBLIC_PORT), then runs e2e/student-autumn.e2e.ts, which
// starts PostgreSQL, the engine, the gateway and the site on the check's
// ports, drives a headless Chromium through the student's journey and stops
// everything. Needs npm run setup (the engine's Python environment) and
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

console.log(`[site e2e] building the site for ${PUBLIC_API}`);
let code = await node([join(site, "scripts", "next.ts"), "build"], { ...process.env, NEXT_PUBLIC_SITE_API: PUBLIC_API });
if (code === 0) code = await node(["--test", "--test-reporter=spec", join("e2e", "student-autumn.e2e.ts")]);
process.exitCode = code;
