// npm run dev -w site, npm run build -w site: Next.js with its telemetry off.
//
//   dev     the development server on 127.0.0.1:4632 (SITE_PORT), after the
//           system says nobody listens there
//   build   the static export in apps/site/out
//   typegen next-env.d.ts and the route types, for tsc
//
// The API the pages call is decided at build time by NEXT_PUBLIC_SITE_API
// (src/data/config.ts).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFree } from "../../../tools/lib/ports.ts";
import { flattenSegmentFiles } from "./segments.ts";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const port = Number(process.env["SITE_PORT"] ?? 4632);

const [command = "dev", ...rest] = process.argv.slice(2);
if (!["dev", "build", "typegen"].includes(command)) {
  console.log("usage: node scripts/next.ts dev | build | typegen");
  process.exitCode = 2;
} else {
  const args = command === "dev" ? ["dev", "--port", String(port), "--hostname", "127.0.0.1", ...rest] : [command, ...rest];
  if (command === "dev") await assertFree(port, "the site's development server");
  const child = spawn(process.execPath, [nextBin, ...args], {
    cwd: site,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  const code = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (exit, signal) => resolve(exit ?? (signal ? 1 : 0)));
  });
  if (code === 0 && command === "build") {
    const moved = await flattenSegmentFiles(join(site, "out"));
    if (moved > 0) console.log(`[site] ${moved} prefetch files of nested routes renamed to the names the router asks for`);
  }
  process.exitCode = code;
}
