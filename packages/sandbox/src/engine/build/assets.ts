// The engine's files of the demo, under one folder that the assembled build
// serves at /sandbox/ (scripts/build.ts):
//
//   pyodide/  the files of Pyodide the engine needs (the module, its
//             WebAssembly, the standard library, the lock file) and the two
//             wheels, checked against the lock's hashes (wheels.ts)
//   pglite/   the modules of PGlite the browser imports, its WebAssembly and
//             its files, and btree_gist; not initdb's WebAssembly, since a
//             first visit loads the snapshot and no cluster is created in the
//             browser
//   engine/   the commerce package as a zip, the migrations as JSON, the
//             snapshot, and manifest.json, which names them (their names carry
//             their hash, so a browser keeps them as long as they do not change)
//
// The browser's package holds what runs in the page and nothing else: the
// domain, the engine's services, the contract's messages and
// commerce.browser; not the server's process (commerce.server, the asyncpg
// adapter), not the tools (generator, invariants, measurements, compatibility
// check), none of the generated gRPC stubs, and not the build's own writer of
// the data (browser/snapshot.py), which the build hands to Pyodide beside the
// generator (BUILD_ONLY).
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Manifest } from "../index.ts";
import { type Migration, parseScript } from "../migrations.ts";
import { flywayChecksum } from "./checksum.ts";
import { buildSnapshot, type Snapshot } from "./snapshot.ts";
import { checkedWheels, lockedWheels, pyodideDir, sha256, wheelsHome } from "./wheels.ts";
import { type Entry, zip } from "./zip.ts";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const commerceSrc = join(repoRoot, "services", "commerce", "src");
const migrationsDir = join(repoRoot, "db", "migrations");

/** Pyodide's files the engine loads: no console page, no source maps, no type declarations. */
export const PYODIDE_FILES = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
/** PGlite's files fetched by URL: the database, its file system, btree_gist. */
const PGLITE_ASSETS = ["pglite.wasm", "pglite.data", "btree_gist.tar.gz"];
const PGLITE_ENTRIES = ["index.js", "contrib/btree_gist.js"];
/** What the build adds beside the package, to write the snapshot's data. */
export const BUILD_ONLY = ["commerce/generate.py", "commerce/browser/snapshot.py"];

/** The modules of commerce in the browser's package, as paths under src/. */
export async function enginePaths(src = commerceSrc): Promise<string[]> {
  const found: string[] = ["commerce/__init__.py"];
  for (const folder of ["domain", "engine", "browser"]) {
    for (const name of (await readdir(join(src, "commerce", folder))).sort()) {
      if (name.endsWith(".py") && !BUILD_ONLY.includes(`commerce/${folder}/${name}`)) found.push(`commerce/${folder}/${name}`);
    }
  }
  for (const name of (await readdir(join(src, "commerce", "v1"))).sort()) {
    if (name === "__init__.py" || (name.endsWith("_pb2.py"))) found.push(`commerce/v1/${name}`);
  }
  return found;
}

export async function engineZip(src = commerceSrc): Promise<{ data: Buffer; files: string[] }> {
  const files = await enginePaths(src);
  const entries: Entry[] = [];
  for (const path of files) entries.push({ path, data: await readFile(join(src, path)) });
  return { data: zip(entries), files };
}

export async function readMigrations(dir = migrationsDir): Promise<Migration[]> {
  const scripts = (await readdir(dir)).filter((name) => /^V\d+__\w+\.sql$/.test(name));
  const migrations: Migration[] = [];
  for (const script of scripts) {
    const sql = await readFile(join(dir, script), "utf8");
    migrations.push({ ...parseScript(script), script, checksum: flywayChecksum(sql), sql });
  }
  return migrations.sort((a, b) => Number(a.version) - Number(b.version));
}

/** PGlite's modules the browser imports: the entries and every module they import, statically. */
async function pgliteModules(dist: string): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [...PGLITE_ENTRIES];
  while (queue.length) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = await readFile(join(dist, path), "utf8");
    for (const [, imported] of text.matchAll(/from\s*"(\.{1,2}\/[^"]+)"/g)) {
      queue.push(relative(dist, join(dist, dirname(path), imported as string)).replaceAll("\\", "/"));
    }
  }
  return [...seen].sort();
}

export type Built = {
  readonly outDir: string;
  readonly manifest: Manifest;
  readonly snapshot: Snapshot;
  readonly files: Readonly<Record<string, number>>;
  readonly engineFiles: readonly string[];
};

const short = (data: Buffer) => sha256(data).slice(0, 12);

/** Writes the engine's files into outDir: what the browser fetches from /sandbox/. */
export async function buildEngineAssets(outDir: string, options: { wheelsDir?: string } = {}): Promise<Built> {
  const pyodide = pyodideDir();
  const pglite = dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
  const wheels = await checkedWheels(options.wheelsDir ?? wheelsHome(repoRoot).dir, lockedWheels(pyodide));
  await rm(outDir, { recursive: true, force: true });
  const files: Record<string, number> = {};
  const put = async (path: string, data: Buffer | string) => {
    await mkdir(dirname(join(outDir, path)), { recursive: true });
    await writeFile(join(outDir, path), data);
    files[path] = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  };
  for (const name of PYODIDE_FILES) await put(`pyodide/${name}`, await readFile(join(pyodide, name)));
  for (const wheel of wheels) await put(`pyodide/${wheel.file}`, wheel.data);
  for (const path of [...(await pgliteModules(pglite)), ...PGLITE_ASSETS]) await put(`pglite/${path}`, await readFile(join(pglite, path)));

  const engine = await engineZip();
  const migrations = await readMigrations();
  const migrationsJson = Buffer.from(JSON.stringify(migrations));
  const snapshot = await buildSnapshot({
    engineZip: engine.data,
    buildOnly: Object.fromEntries(await Promise.all(BUILD_ONLY.map(async (path) => [path, await readFile(join(commerceSrc, path), "utf8")]))),
    migrations,
    pyodideDir: pyodide,
    wheelsDir: options.wheelsDir ?? wheelsHome(repoRoot).dir,
  });
  const names = {
    engine: `commerce-${short(engine.data)}.zip`,
    migrations: `migrations-${short(migrationsJson)}.json`,
    snapshot: `snapshot-${short(snapshot.data)}.tar.gz`,
  };
  await put(`engine/${names.engine}`, engine.data);
  await put(`engine/${names.migrations}`, migrationsJson);
  await put(`engine/${names.snapshot}`, snapshot.data);
  const build = sha256(Buffer.from(JSON.stringify([names, wheels.map((w) => w.sha256), Object.keys(files).sort()]))).slice(0, 12);
  const manifest: Manifest = { ...names, fingerprint: snapshot.fingerprint, build };
  await put("engine/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { outDir, manifest, snapshot, files, engineFiles: engine.files };
}

// node packages/sandbox/src/engine/build/assets.ts <folder>: the engine's files alone, for the engine's own checks.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: node packages/sandbox/src/engine/build/assets.ts <folder>");
  const built = await buildEngineAssets(out);
  console.error(`snapshot: ${built.snapshot.walDropped} WAL segments left out`);
  const total = Object.values(built.files).reduce((sum, bytes) => sum + bytes, 0);
  console.log(JSON.stringify({ manifest: built.manifest, snapshotMs: built.snapshot.ms, counts: built.snapshot.counts,
    files: Object.keys(built.files).length, bytes: total }, null, 2));
}
