// The engine's Python in the browser: Pyodide 0.29.5 (Python 3.13.2) with
// the two wheels the engine imports, protobuf 6.31.1 and tzdata, checked by
// Pyodide against the hashes of its lock file, and the commerce package
// itself, pure Python, as the zip the build prepares (build/assets.ts): the
// domain, the engine's services, the contract's messages and
// commerce.browser, nothing of the server's process, nothing of grpc or
// asyncpg. The same code loads it in Node for the build and the tests.
import type { loadPyodide as LoadPyodide, PyodideAPI } from "pyodide";

export type PythonSource = {
  readonly loadPyodide: typeof LoadPyodide;
  /** Pyodide's files: pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json; a URL in the browser, a folder in Node. */
  readonly indexURL: string;
  /** Where the wheels named in the lock file are; Pyodide's own folder in the browser's build. */
  readonly packageBaseUrl: string;
  /** The commerce package, the zip of build/assets.ts. */
  readonly engine: () => Promise<ArrayBuffer>;
  /** Files written next to the package, for the build: the generator (build/snapshot.ts). */
  readonly extra?: Readonly<Record<string, string>>;
};

export const PACKAGES = ["protobuf", "tzdata"] as const;
const ENGINE_DIR = "/home/pyodide/engine";

export async function loadPython(source: PythonSource, say: (step: string) => void = () => {}): Promise<PyodideAPI> {
  say("Loading Python");
  const pyodide = await source.loadPyodide({ indexURL: source.indexURL, packageBaseUrl: source.packageBaseUrl });
  const problems: string[] = [];
  const archive = source.engine();
  await pyodide.loadPackage([...PACKAGES], { messageCallback: () => {}, errorCallback: (message: string) => problems.push(message) });
  if (problems.length) throw new Error(`Python's packages did not load: ${problems.join(" ")}`);
  say("Loading the engine");
  pyodide.unpackArchive(await archive, "zip", { extractDir: ENGINE_DIR });
  for (const [path, text] of Object.entries(source.extra ?? {})) pyodide.FS.writeFile(`${ENGINE_DIR}/${path}`, text);
  pyodide.runPython(`import sys\nif ${JSON.stringify(ENGINE_DIR)} not in sys.path: sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})`);
  return pyodide;
}
