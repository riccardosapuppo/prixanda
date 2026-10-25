// The demo in the browser, assembled (stage 8; the browser sandbox of docs/business.md): one
// static folder that any host can serve, with the site at /, the console at
// /console/ and the sandbox at /sandbox/, the worker that runs the engine's
// Python code over PGlite and the gateway's core for every tab of the origin.
//
//   npm run demo:build    builds the three parts and assembles them in dist/demo/
//   npm run demo:serve    serves dist/demo/ on 127.0.0.1:4651 (DEMO_PORT)
//
// Each part builds itself, with SANDBOX=1 and the same SANDBOX_BUILD, the
// demo's fingerprint: a tab and a worker of two different deploys know each
// other by it, and the tab reloads. The sandbox's own build (packages/sandbox,
// npm run build -w sandbox) writes packages/sandbox/dist/; the site's and the
// console's write their out/ folders, copied here. Nothing is downloaded: the
// parts bring Pyodide, its wheels, PGlite and the fonts from the repository's
// own files, and the server serves only what the folder holds.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "../apps/site/scripts/serve.ts";
import { repoRoot } from "./lib/paths.ts";
import { assertFree } from "./lib/ports.ts";
import { run } from "./lib/run.ts";

export const demoDir = join(repoRoot, "dist", "demo");
export const DEMO_PORT = Number(process.env["DEMO_PORT"] ?? 4651);
export const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`;

const say = (line: string) => console.log(`[demo] ${line}`);

/** The three parts: how each builds itself, where it writes, and where it goes in the demo. */
export const PARTS = [
  {
    name: "sandbox",
    script: join(repoRoot, "packages", "sandbox", "scripts", "build.ts"),
    args: [] as string[],
    out: join(repoRoot, "packages", "sandbox", "dist"),
    at: "sandbox",
    owner: "the sandbox package (packages/sandbox/scripts/build.ts)",
  },
  {
    name: "site",
    script: join(repoRoot, "apps", "site", "scripts", "next.ts"),
    args: ["build"],
    out: join(repoRoot, "apps", "site", "out"),
    at: "",
    owner: "the site (apps/site)",
  },
  {
    name: "console",
    script: join(repoRoot, "apps", "console", "scripts", "build.ts"),
    args: [] as string[],
    out: join(repoRoot, "apps", "console", "out"),
    at: "console",
    owner: "the console (apps/console), with basePath /console when SANDBOX=1",
  },
] as const;

export type PartName = (typeof PARTS)[number]["name"];

/** The demo's fingerprint: the commit it was built from, and when. */
function fingerprint(): string {
  let commit = "local";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    // a build outside a repository keeps "local"
  }
  return `${commit}-${Date.now().toString(36)}`;
}

/** The parts that cannot be built yet, and who writes them. */
export function missingParts(): { name: PartName; owner: string }[] {
  return PARTS.filter((part) => !existsSync(part.script)).map((part) => ({ name: part.name, owner: part.owner }));
}

/** Builds every part with SANDBOX=1 and one fingerprint, and assembles them in dist/demo/. */
export async function buildDemo({ echo = true }: { readonly echo?: boolean } = {}): Promise<{ build: string; ms: Record<PartName, number> }> {
  const missing = missingParts();
  if (missing.length > 0) {
    throw new Error(`the demo cannot be built yet: ${missing.map((part) => `${part.name} needs ${part.owner}`).join("; ")}`);
  }
  const build = fingerprint();
  const env = { ...process.env, SANDBOX: "1", SANDBOX_BUILD: build, NEXT_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" };
  const ms = {} as Record<PartName, number>;
  await rm(demoDir, { recursive: true, force: true });
  await mkdir(demoDir, { recursive: true });
  for (const part of PARTS) {
    say(`building ${part.name} for the sandbox (${build})`);
    const ran = await run(process.execPath, [part.script, ...part.args], { cwd: repoRoot, env, echo });
    if (ran.code !== 0) throw new Error(`${part.name}'s build failed (exit ${ran.code}):\n${ran.output.slice(-3000)}`);
    if (!existsSync(part.out)) throw new Error(`${part.name}'s build wrote no ${part.out}`);
    ms[part.name] = ran.ms;
  }
  // The site first: it is the root, and the others go into folders of their own.
  for (const name of ["site", "console", "sandbox"] as const) {
    const part = PARTS.find((each) => each.name === name);
    if (part === undefined) continue;
    await cp(part.out, join(demoDir, part.at), { recursive: true });
  }
  await writeFile(join(demoDir, "demo-build.json"), `${JSON.stringify({ build, builtAt: new Date().toISOString(), ms }, null, 2)}\n`);
  say(`assembled in ${demoDir}`);
  return { build, ms };
}

/** Serves dist/demo/ on DEMO_PORT, as a static host would; resolves once it listens. */
export async function serveDemo(): Promise<Server> {
  if (!existsSync(join(demoDir, "index.html"))) throw new Error("dist/demo/ is empty: npm run demo:build first");
  await assertFree(DEMO_PORT, "the demo");
  return serveStatic(demoDir, DEMO_PORT);
}

/** The fingerprint of the demo in dist/demo/. */
export async function builtDemo(): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(join(demoDir, "demo-build.json"), "utf8")) as { build: string }).build;
  } catch {
    return null;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const command = process.argv[2];
  if (command === "build") {
    await buildDemo();
  } else if (command === "serve") {
    await serveDemo();
    say(`dist/demo/ on ${DEMO_URL}/ (Ctrl+C stops it)`);
  } else {
    console.error("usage: node tools/demo.ts build | serve");
    process.exitCode = 2;
  }
}
