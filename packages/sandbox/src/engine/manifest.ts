// What the build writes in engine/manifest.json (build/assets.ts), and the
// browser reads first: the names of the engine's files, which carry their
// hash, the folder of Pyodide and PGlite, named by the hash of its files, the
// fingerprint of the snapshot's data, the moment the story starts on the
// demo's clock (clock.ts), and the build's own hash.
export type Manifest = {
  /** The folder of Pyodide's and PGlite's files beside engine/: runtime-<hash>/, with pyodide/ and pglite/ in it. */
  readonly runtime: string;
  readonly engine: string;
  readonly snapshot: string;
  readonly migrations: string;
  readonly fingerprint: string;
  /** The start of the story, ISO 8601 with Z: where every visit's clock starts, and a reset takes it back. */
  readonly story: string;
  readonly build: string;
};
