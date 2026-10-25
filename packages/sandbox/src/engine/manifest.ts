// What the build writes in engine/manifest.json (build/assets.ts), and the
// browser reads first: the names of the engine's files, which carry their
// hash, the fingerprint of the snapshot's data, and the build's own.
export type Manifest = {
  readonly engine: string;
  readonly snapshot: string;
  readonly migrations: string;
  readonly fingerprint: string;
  readonly build: string;
};
