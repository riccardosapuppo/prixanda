// npm run setup: what the repository needs besides `npm install`, all of it
// inside the repository.
//
// 1. Flyway's command line for PostgreSQL and the Java runtime it runs on,
//    pinned by checksum in tools/flyway-lock.json and downloaded into .tools/
//    (nothing is installed). When FLYWAY_JAVA and FLYWAY_LIB point to a copy
//    already on the machine, that copy is checked against the lock instead.
// 2. The engine's Python environment in .venv/, with the pinned packages of
//    services/commerce/requirements-dev.txt.
//
// It can run again at any time: whatever is there and matches is kept.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { flywayHome, flywayLock, pinnedRuntime } from "./lib/flyway.ts";
import { commerceDir, repoRoot, toolsDir, venvPython } from "./lib/paths.ts";
import { run, runOrThrow } from "./lib/run.ts";

const say = (line: string) => console.log(`[setup] ${line}`);
type Algorithm = "sha1" | "sha256";
const digest = (algorithm: Algorithm, data: Buffer) => createHash(algorithm).update(data).digest("hex");

async function download(url: string, bytes: number, algorithm: Algorithm, hash: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = digest(algorithm, data);
  if (data.length !== bytes || actual !== hash) {
    throw new Error(`${url}: got ${data.length} bytes, ${algorithm} ${actual}; the lock says ${bytes} bytes, ${hash}`);
  }
  return data;
}

async function sameFile(file: string, algorithm: Algorithm, hash: string): Promise<boolean> {
  return existsSync(file) && digest(algorithm, await readFile(file)) === hash;
}

// On Windows the tar of System32, which also opens zip files; Git's tar, often
// first in PATH, does not.
const tar = process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";

async function javaRuntime(java: string): Promise<void> {
  if (existsSync(java)) return;
  const runtime = pinnedRuntime();
  say(`downloading the Java runtime ${runtime.version} (${(runtime.bytes / 1e6).toFixed(1)} MB) from ${new URL(runtime.url).host}`);
  const data = await download(runtime.url, runtime.bytes, "sha256", runtime.sha256);
  const archive = join(toolsDir, "download", decodeURIComponent(runtime.url.split("/").pop() ?? "runtime"));
  await mkdir(join(toolsDir, "download"), { recursive: true });
  await writeFile(archive, data);
  await rm(join(toolsDir, runtime.folder), { recursive: true, force: true });
  await runOrThrow(tar, ["-xf", archive, "-C", toolsDir]);
  await rm(archive);
  if (!existsSync(java)) throw new Error(`the archive did not contain ${java}`);
}

async function flywayJars(lib: string, mayDownload: boolean): Promise<number> {
  if (mayDownload) await mkdir(lib, { recursive: true });
  const locked = new Set(flywayLock.jars.map((jar) => jar.name));
  const strangers = existsSync(lib) ? (await readdir(lib)).filter((name) => name.endsWith(".jar") && !locked.has(name)) : [];
  if (strangers.length) throw new Error(`${lib} holds jars that tools/flyway-lock.json does not list: ${strangers.join(", ")}`);
  let fetched = 0;
  for (const jar of flywayLock.jars) {
    const file = join(lib, jar.name);
    if (await sameFile(file, "sha1", jar.sha1)) continue;
    if (!mayDownload) throw new Error(`${file} is missing or differs from tools/flyway-lock.json`);
    await writeFile(file, await download(jar.url, jar.bytes, "sha1", jar.sha1));
    fetched += 1;
  }
  return fetched;
}

async function pythonEnvironment(): Promise<void> {
  if (!existsSync(venvPython)) {
    const python = process.env["PYTHON"] ?? (process.platform === "win32" ? "python" : "python3");
    const version = (await runOrThrow(python, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"])).output.trim();
    const [major = 0, minor = 0] = version.split(".").map(Number);
    if (major !== 3 || minor < 13) throw new Error(`the engine needs Python 3.13 or later, and ${python} is ${version}: set PYTHON to another one`);
    if (minor !== 13) say(`note: Python ${version}; the browser demo runs the engine on Python 3.13, and CI tests 3.13`);
    say(`creating .venv with ${python} ${version}`);
    await runOrThrow(python, ["-m", "venv", join(repoRoot, ".venv")]);
  }
  say("installing the engine's packages into .venv (services/commerce/requirements-dev.txt)");
  await runOrThrow(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", "-r", join(commerceDir, "requirements-dev.txt")], { echo: true });
}

const home = flywayHome();
// Only a copy of its own is downloaded and completed; one pointed to by
// FLYWAY_JAVA and FLYWAY_LIB or by .tools/flyway-home.json is only checked.
const own = home.from === ".tools";
if (own) await javaRuntime(home.java);
const fetched = await flywayJars(home.lib, own);
const java = await run(home.java, ["-version"]);
if (java.code !== 0) throw new Error(`${home.java} does not run:\n${java.output}`);
say(`Flyway ${flywayLock.flyway}: ${flywayLock.jars.length} jars match the lock (${fetched} downloaded now), from ${home.from}`);
say(`Java: ${java.output.split(/\r?\n/)[0]?.trim()}`);
await pythonEnvironment();
say("done");
