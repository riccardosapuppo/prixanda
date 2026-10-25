// The two wheels the engine imports in Pyodide, protobuf and tzdata, pinned
// by the hashes of Pyodide's own lock file (node_modules/pyodide/
// pyodide-lock.json, the lock of the version package.json names). As for
// Flyway, `npm run setup` checks a copy already on the machine when
// PYODIDE_PACKAGES or .tools/pyodide-packages.json ({"dir": ...}) points to
// one; otherwise it downloads them into .tools/pyodide-packages from Pyodide's
// CDN and checks them there (the CI). The build only checks.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export const WHEELS = ["protobuf", "tzdata"] as const;

export type LockedWheel = { readonly name: string; readonly file: string; readonly sha256: string; readonly url: string };

/** Pyodide's folder in node_modules, as the sandbox's package resolves it. */
export function pyodideDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("pyodide/package.json"));
}

export function lockedWheels(pyodide = pyodideDir()): LockedWheel[] {
  const version = (JSON.parse(readFileSync(join(pyodide, "package.json"), "utf8")) as { version: string }).version;
  const lock = JSON.parse(readFileSync(join(pyodide, "pyodide-lock.json"), "utf8")) as {
    packages: Record<string, { file_name: string; sha256: string; depends: string[] }>;
  };
  return WHEELS.map((name) => {
    const entry = lock.packages[name];
    if (!entry) throw new Error(`Pyodide ${version}'s lock file has no ${name}`);
    if (entry.depends.length) throw new Error(`${name} now depends on ${entry.depends.join(", ")}: the sandbox loads only ${WHEELS.join(" and ")}`);
    return { name, file: entry.file_name, sha256: entry.sha256, url: `https://cdn.jsdelivr.net/pyodide/v${version}/full/${entry.file_name}` };
  });
}

/** Where the wheels are, and who said so. */
export function wheelsHome(repoRoot: string): { dir: string; from: string } {
  const fromEnv = process.env["PYODIDE_PACKAGES"];
  if (fromEnv) return { dir: fromEnv, from: "PYODIDE_PACKAGES" };
  const pointer = join(repoRoot, ".tools", "pyodide-packages.json");
  if (existsSync(pointer)) {
    const home = JSON.parse(readFileSync(pointer, "utf8")) as { dir?: string };
    if (!home.dir) throw new Error(`${pointer} needs "dir"`);
    return { dir: home.dir, from: ".tools/pyodide-packages.json" };
  }
  return { dir: join(repoRoot, ".tools", "pyodide-packages"), from: ".tools" };
}

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** The wheels, read and checked against the lock: missing or different ones are an error that names them. */
export async function checkedWheels(dir: string, wheels = lockedWheels()): Promise<Array<LockedWheel & { readonly data: Buffer }>> {
  const found = [];
  for (const wheel of wheels) {
    const file = join(dir, wheel.file);
    if (!existsSync(file)) throw new Error(`${file} is missing: npm run setup`);
    const data = await readFile(file);
    if (sha256(data) !== wheel.sha256) throw new Error(`${file} differs from Pyodide's lock file (sha256 ${wheel.sha256})`);
    found.push({ ...wheel, data });
  }
  return found;
}
