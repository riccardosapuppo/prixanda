// The sandbox's part of the demo's build (stage 8): packages/sandbox/dist/,
// which tools/demo.ts copies to dist/demo/sandbox/, so that every app of the
// demo opens /sandbox/backend.js and the engine finds its files beside it.
//
//   node packages/sandbox/scripts/build.ts [--engine <module>] [--out <dir>]
//
// It writes the engine's files first (src/engine/build/assets.ts: Pyodide and
// its wheels, PGlite, the commerce package, the migrations, the snapshot,
// under pyodide/, pglite/ and engine/), then the worker, bundled into one
// module, backend.js, with its source map and the licences of what it holds.
// SANDBOX_BUILD is the build's fingerprint, the one the apps are built with:
// the worker says it in ready, and a tab of another build reloads.
//
// --engine points "sandbox-engine" at another module than src/engine/index.ts,
// for the worker's own tests: the worker alone, without the engine's files.
// Nothing is downloaded, and nothing in the bundle asks for anything outside
// the origin: the Node modules that Apollo Server names only for its
// reporting, which the gateway turns off, are modules that throw if they run.
import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
/** The engine's side of the package: the module the worker starts, and the writer of its files. */
export const ENGINE = { module: join(root, "src", "engine", "index.ts"), files: join(root, "src", "engine", "build", "assets.ts") };

const NODE = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** Node's modules: in the browser, a module that throws if it runs, where the code that names them never does. */
const nodeModulesEmpty: Plugin = {
  name: "node-modules-empty",
  setup(context) {
    context.onResolve({ filter: /.*/ }, (args) => (NODE.has(args.path) ? { path: args.path, namespace: "node-empty" } : undefined));
    context.onLoad({ filter: /.*/, namespace: "node-empty" }, (args) => ({
      contents: `throw new Error(${JSON.stringify(`${args.path} is Node's, and the sandbox runs in a browser`)});`,
      loader: "js",
    }));
  },
};

/** What the engine's side writes beside the worker, as its build tells it. */
export type EngineFiles = { readonly files: Readonly<Record<string, number>> };

export type Built = {
  readonly outfile: string;
  readonly bytes: number;
  readonly inputs: readonly string[];
  /** Node's modules the bundle names, each a module that throws if it runs. */
  readonly nodeModules: readonly string[];
  /** The engine's files, by path under the output folder; none for a worker built for a test. */
  readonly engineFiles: Readonly<Record<string, number>>;
};

export async function buildSandbox(options: {
  /** The module "sandbox-engine" is: src/engine/index.ts, or a test's. */
  readonly engine: string;
  readonly out: string;
  readonly build: string;
  /** Writes the engine's files into the folder; the worker is written after them. */
  readonly engineFiles?: (out: string) => Promise<EngineFiles>;
}): Promise<Built> {
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const engineFiles = options.engineFiles ? (await options.engineFiles(options.out)).files : {};
  await mkdir(options.out, { recursive: true });
  const outfile = join(options.out, "backend.js");
  const result = await build({
    entryPoints: [join(root, "src", "backend.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: "linked",
    legalComments: "linked",
    metafile: true,
    logLevel: "warning",
    // Apollo Server hashes every query with sha.js outside Node, and sha.js needs Node's Buffer: a SHA-256 of the sandbox's own instead.
    alias: { "sandbox-engine": options.engine, "sha.js": join(root, "src", "gateway", "sha256.cjs") },
    define: { __SANDBOX_BUILD__: JSON.stringify(options.build), "process.env.NODE_ENV": '"production"' },
    // Where the code names Node's process or Buffer: an empty environment, and nothing a Buffer.
    inject: [join(root, "src", "gateway", "node-globals.ts")],
    plugins: [nodeModulesEmpty],
  });
  const inputs = Object.keys(result.metafile.inputs);
  return {
    outfile,
    bytes: (await stat(outfile)).size,
    inputs,
    nodeModules: inputs.filter((input) => input.startsWith("node-empty:")).map((input) => input.slice("node-empty:".length)),
    engineFiles,
  };
}

/** The engine's own writer of its files, where the engine's side is in the tree. */
export async function engineFilesWriter(): Promise<(out: string) => Promise<EngineFiles>> {
  if (!existsSync(ENGINE.module) || !existsSync(ENGINE.files)) {
    throw new Error(`the engine's side of the sandbox is not in this tree (${ENGINE.module}): the demo's build needs it; --engine builds the worker alone, for a test`);
  }
  const { buildEngineAssets } = (await import(pathToFileURL(ENGINE.files).href)) as { buildEngineAssets: (out: string) => Promise<EngineFiles> };
  return (out) => buildEngineAssets(out);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--engine");
  const engine = at === -1 ? null : resolve(process.argv[at + 1] ?? "");
  const outAt = process.argv.indexOf("--out");
  const out = outAt === -1 ? join(root, "dist") : resolve(process.argv[outAt + 1] ?? "dist");
  const fingerprint = process.env["SANDBOX_BUILD"] || "development";
  const built = await buildSandbox(engine === null
    ? { engine: ENGINE.module, out, build: fingerprint, engineFiles: await engineFilesWriter() }
    : { engine, out, build: fingerprint });
  const engineFiles = Object.values(built.engineFiles);
  if (engineFiles.length > 0) {
    console.log(`[sandbox] the engine's files: ${engineFiles.length}, ${(engineFiles.reduce((sum, bytes) => sum + bytes, 0) / 1e6).toFixed(1)} MB`);
  }
  console.log(`[sandbox] ${built.outfile}: ${(built.bytes / 1024).toFixed(0)} KiB from ${built.inputs.length} modules, build ${fingerprint}`);
  if (built.nodeModules.length > 0) console.log(`[sandbox] Node's modules named but never run in the browser: ${built.nodeModules.join(", ")}`);
}
