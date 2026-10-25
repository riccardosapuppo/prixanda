// The demo's snapshot, made by the build in Node: a new PGlite cluster, the
// migrations applied by the browser's own runner (migrations.ts), the small
// data written by the server's generator, run in Pyodide through the
// browser's adapter (commerce.browser.snapshot), the tables rewritten tight
// and their statistics gathered, and the data directory saved as a gzipped
// tar. A first visit loads it instead of creating a cluster, migrating it and
// generating its data.
//
// The cluster has WAL segments of 1 MB instead of 16, and keeps few of them
// (postgresql.auto.conf, which travels with the data): PGlite saves to
// IndexedDB the whole of every file a commit touched, the segment being
// written included. The build checks its own work: the snapshot loads in a
// new PGlite, and the rows there have the generator's fingerprint.
import { gzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { loadPyodide } from "pyodide";
import { openDatabase, Session } from "../database.ts";
import type { Migration } from "../migrations.ts";
import { loadPython } from "../python.ts";
import { withoutWal } from "./tar.ts";

export const WAL_SETTINGS = ["min_wal_size = '2MB'", "max_wal_size = '32MB'"];

export type Snapshot = {
  readonly data: Buffer;
  /** commerce.generate's fingerprint of the rows it wrote: the schema check compares it with the server's. */
  readonly fingerprint: string;
  /** The start of the story on the demo's clock (commerce.browser.snapshot), ISO 8601 with Z. */
  readonly story: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly applied: readonly string[];
  readonly walDropped: number;
  readonly ms: number;
};

type SnapshotModule = { build(bridge: unknown): Promise<string>; fingerprint_of(bridge: unknown): Promise<string> };

export async function buildSnapshot(input: {
  readonly engineZip: Buffer;
  /** Beside the package, for the build only: the generator and the writer on PGlite (assets.ts, BUILD_ONLY). */
  readonly buildOnly: Readonly<Record<string, string>>;
  readonly migrations: readonly Migration[];
  readonly pyodideDir: string;
  readonly wheelsDir: string;
}): Promise<Snapshot> {
  const begun = performance.now();
  const python = loadPython({
    loadPyodide,
    indexURL: input.pyodideDir,
    packageBaseUrl: `${input.wheelsDir.replaceAll("\\", "/")}/`,
    engine: async () => input.engineZip.buffer.slice(input.engineZip.byteOffset, input.engineZip.byteOffset + input.engineZip.byteLength) as ArrayBuffer,
    extra: input.buildOnly,
  });
  python.catch(() => {});
  const db = await openDatabase({
    modules: { PGlite, btree_gist },
    migrations: input.migrations,
    exists: async () => false,
    // C, as the server's cluster (tools/lib/postgres.ts): the same order of text, and the same case of letters.
    cluster: { initDbStartParams: ["--wal-segsize=1", "--locale=C"] },
  });
  let data: Buffer;
  let walDropped: number;
  let summary: { fingerprint: string; counts: Record<string, number>; story: string };
  const pyodide = await python;
  const module = pyodide.pyimport("commerce.browser.snapshot") as unknown as SnapshotModule;
  try {
    summary = JSON.parse(await module.build(db.session)) as typeof summary;
    const pg = db.session.pg;
    await pg.exec("reset role");
    for (const setting of WAL_SETTINGS) await pg.exec(`alter system set ${setting}`);
    // Only CREATE DATABASE reads the template databases, and the browser creates none: less to load and to save.
    for (const template of ["template0", "template1"]) {
      await pg.exec(`update pg_database set datistemplate = false where datname = '${template}'`);
      await pg.exec(`drop database ${template}`);
    }
    await pg.exec("vacuum full analyze");
    await pg.exec("checkpoint");
    const redo = (await pg.query<{ redo: string }>("select pg_walfile_name(redo_lsn) as redo from pg_control_checkpoint()")).rows[0]?.redo;
    if (!redo) throw new Error("the cluster says nothing of its last checkpoint");
    const tar = Buffer.from(await (await pg.dumpDataDir("none")).arrayBuffer());
    const trimmed = withoutWal(tar, redo);
    data = gzipSync(trimmed.tar, { level: 9 });
    walDropped = trimmed.dropped.length;
  } finally {
    await db.session.pg.close();
  }
  // The build's own check: the snapshot opens, and holds the same rows.
  const again = await PGlite.create({ loadDataDir: new Blob([new Uint8Array(data)]), extensions: { btree_gist } });
  try {
    await again.exec("set role commerce");
    const reread = await module.fingerprint_of(new Session(again));
    if (reread !== summary.fingerprint) throw new Error(`the snapshot reloaded holds other rows: fingerprint ${reread}, written ${summary.fingerprint}`);
  } finally {
    await again.close();
  }
  return {
    data,
    fingerprint: summary.fingerprint,
    story: summary.story,
    counts: summary.counts,
    applied: db.migrated.applied,
    walDropped,
    ms: Math.round(performance.now() - begun),
  };
}
