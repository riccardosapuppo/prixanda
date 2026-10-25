// What tsc reads for "sandbox-engine", the module backend.ts takes the
// engine's startEngine from, while the engine's side of the package
// (src/engine/) is not in the tree: tsconfig.json's paths try
// src/engine/index.ts first, so that, once it is there, backend.ts is checked
// against the engine's own startEngine, and this file is read no more. The
// build points "sandbox-engine" at a module (scripts/build.ts) and never
// bundles this one.
import type { StartEngine } from "./engine-port.ts";

export declare const startEngine: StartEngine;
