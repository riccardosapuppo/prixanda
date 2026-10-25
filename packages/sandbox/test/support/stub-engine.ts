// The engine's side of the package, stubbed for the build's own test: the
// worker's bundle is built and read without Pyodide or PGlite. It never
// starts, and says so.
import type { StartEngine } from "../../src/gateway/engine-port.ts";

export const startEngine: StartEngine = () => Promise.reject(new Error("the build's test bundles a stub engine, which never starts"));
