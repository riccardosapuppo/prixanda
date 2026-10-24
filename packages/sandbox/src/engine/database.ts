// The engine's database in the browser: PGlite 0.5.8, PostgreSQL 18.3 in
// WebAssembly, with btree_gist for the exclusion constraints of the price
// list. It lives in IndexedDB, under the name the worker gives it; a first
// visit, and a reset, load the snapshot the build prepared (the migrations
// and the small data, build/snapshot.ts), then the runner applies any
// migration of a newer build (migrations.ts).
//
// The session: the migrations and the demo's own state run as the owner
// (postgres); then the session takes the engine's role, commerce, a member of
// commerce_app, and the time zone of the server's pool, UTC. The demo's own
// state (the clock's offset) is in a schema of its own, demo, outside the
// product's migrations: the schema check leaves it out, and says so.
//
// The bridge the Python engine calls (browser/pglite.py): one transaction at
// a time, held open between its statements; each statement's result goes
// back as PostgreSQL's text with each column's type, an error with its
// SQLSTATE and constraint. PGlite writes to IndexedDB only when told to:
// a transaction that wrote is saved before its commit answers, so a tab that
// closes right after an answer loses nothing (PGlite's relaxedDurability
// lost the last writes in the prototype of stage 0).
import type { Extension, PGlite, PGliteOptions, Transaction } from "@electric-sql/pglite";
import { type Migrated, type Migration, migrate } from "./migrations.ts";

export type PGliteModules = { readonly PGlite: typeof PGlite; readonly btree_gist: Extension };

/** The engine's role on the server: commerce logs in, and holds commerce_app's grants (tools/lib/postgres.ts). */
const ROLES = `do $$ begin
  if not exists (select from pg_roles where rolname = 'commerce_app') then create role commerce_app nologin; end if;
  if not exists (select from pg_roles where rolname = 'commerce') then create role commerce login in role commerce_app; end if;
end $$`;

const DEMO_SCHEMA = `
create schema if not exists demo;
comment on schema demo is 'The browser demo''s own state, outside the product''s migrations: its clock''s offset.';
create table if not exists demo.clock (
  id boolean primary key default true check (id),
  offset_ms bigint not null default 0,
  moved_at timestamptz
);
insert into demo.clock (id) values (true) on conflict do nothing;`;

type ErrorReply = { error: { sqlstate: string | null; message: string; constraint: string | null } };

function errorReply(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown; constraint?: unknown };
  const reply: ErrorReply = {
    error: {
      sqlstate: typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null,
      message: typeof e?.message === "string" ? e.message : String(error),
      constraint: typeof e?.constraint === "string" ? e.constraint : null,
    },
  };
  return JSON.stringify(reply);
}

function bytesOf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function parameter(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "bytea" in value && typeof value.bytea === "string") return bytesOf(value.bytea);
  return value;
}

type Open = { readonly tx: Transaction; readonly readonly: boolean; finish(commit: boolean): void; readonly ended: Promise<void> };

/** The bridge for browser/pglite.py: every method answers JSON text and never throws. */
export class Session {
  readonly pg: PGlite;
  #raw: Record<number, (text: string) => string> = {};
  #known = 0;
  readonly #open = new Map<number, Open>();
  #next = 1;

  constructor(pg: PGlite) {
    this.pg = pg;
  }

  /** PostgreSQL's own text for every type PGlite would parse, the arrays of the migrations' types included: the engine
   * converts it as asyncpg would (browser/pglite.py), so that no JavaScript number or Date stands between the two. */
  get #parsers(): Record<number, (text: string) => string> {
    const known = (this.pg as unknown as { parsers: Record<string, unknown> }).parsers;
    const oids = Object.keys(known);
    if (oids.length !== this.#known) {
      this.#raw = Object.fromEntries(oids.map((oid) => [Number(oid), (text: string) => text]));
      this.#known = oids.length;
    }
    return this.#raw;
  }

  begin = async (readonly: boolean): Promise<string> => {
    try {
      let started!: (tx: Transaction) => void;
      let finish!: (commit: boolean) => void;
      const ready = new Promise<Transaction>((resolve) => { started = resolve; });
      const decided = new Promise<boolean>((resolve) => { finish = resolve; });
      const ended = this.pg.transaction(async (tx) => {
        started(tx);
        if (!(await decided)) await tx.rollback();
      });
      const early = ended.then(() => { throw new Error("the transaction ended before it began"); });
      early.catch(() => {});
      const tx = await Promise.race([ready, early]);
      const id = this.#next++;
      this.#open.set(id, { tx, readonly, finish, ended });
      return JSON.stringify({ tx: id });
    } catch (error) {
      return errorReply(error);
    }
  };

  query = async (tx: number, sql: string, params: string): Promise<string> => {
    const open = this.#open.get(tx);
    if (!open) return errorReply(new Error(`no transaction ${tx} is open`));
    try {
      const values = (JSON.parse(params) as unknown[]).map(parameter);
      const result = await open.tx.query<unknown[]>(sql, values, { rowMode: "array", parsers: this.#parsers, onNotice: () => {} });
      return JSON.stringify({ fields: result.fields.map((f) => [f.name, f.dataTypeID]), rows: result.rows, count: result.affectedRows ?? 0 });
    } catch (error) {
      return errorReply(error);
    }
  };

  copy = async (tx: number, sql: string, data: string): Promise<string> => {
    const open = this.#open.get(tx);
    if (!open) return errorReply(new Error(`no transaction ${tx} is open`));
    try {
      const result = await open.tx.query(sql, [], { blob: new Blob([data]), onNotice: () => {} });
      return JSON.stringify({ count: result.affectedRows ?? 0 });
    } catch (error) {
      return errorReply(error);
    }
  };

  end = async (tx: number, commit: boolean): Promise<string> => {
    const open = this.#open.get(tx);
    if (!open) return errorReply(new Error(`no transaction ${tx} is open`));
    this.#open.delete(tx);
    open.finish(commit);
    try {
      await open.ended;
      if (commit && !open.readonly) await this.pg.syncToFs();
      return "{}";
    } catch (error) {
      return errorReply(error);
    }
  };

  /** A statement of the demo's own, as the owner, in a transaction of its own, saved before it answers. */
  async asOwner<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const result = await this.pg.transaction(async (tx) => {
      await tx.exec("set local role postgres");
      return work(tx);
    });
    await this.pg.syncToFs();
    return result;
  }

  get openTransactions(): number {
    return this.#open.size;
  }
}

export type OpenOptions = {
  readonly modules: PGliteModules;
  /** Where PGlite keeps the data: idb://<name> in the browser, nothing (memory) in Node. */
  readonly dataDir?: string;
  /** The build's snapshot, fetched only when the data is not there yet; none for the build itself, which starts
   * from a new cluster (build/snapshot.ts). */
  readonly snapshot?: () => Promise<Blob>;
  readonly migrations: readonly Migration[];
  readonly progress?: (step: string) => void;
  /** Whether the data is there already; the browser asks IndexedDB (exists below). */
  readonly exists?: () => Promise<boolean>;
  /** How a new cluster is made: the build's (build/snapshot.ts). */
  readonly cluster?: Pick<PGliteOptions, "initDbStartParams">;
};

export type Opened = {
  readonly session: Session;
  /** The data came from the build's snapshot now: a first visit, or a reset. */
  readonly loaded: boolean;
  readonly migrated: Migrated;
  /** The demo clock's offset, as last saved. */
  readonly offsetMs: number;
  /** The instant of the audit log's latest event, in milliseconds: the demo's clock never starts behind it. */
  readonly latestEventMs: number;
};

/** The name IndexedDB holds a PGlite database under: Emscripten's IDBFS names it after its mount point, /pglite/<name>. */
export function indexedDbName(dataDir: string): string {
  if (!dataDir.startsWith("idb://")) throw new Error(`not a database of IndexedDB: ${dataDir}`);
  return `/pglite/${dataDir.slice("idb://".length)}`;
}

export async function existsInIndexedDb(dataDir: string): Promise<boolean> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
    throw new Error("this browser cannot list its IndexedDB databases, which the demo needs to find its data");
  }
  const name = indexedDbName(dataDir);
  return (await indexedDB.databases()).some((database) => database.name === name);
}

export async function deleteFromIndexedDb(dataDir: string): Promise<void> {
  const name = indexedDbName(dataDir);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`IndexedDB did not delete ${name}`));
  });
}

/** Opens the database, from IndexedDB or from the build's snapshot, applies the migrations missing, and sets the session. */
export async function openDatabase(options: OpenOptions): Promise<Opened> {
  const say = options.progress ?? (() => {});
  const loaded = !(await (options.exists?.() ?? Promise.resolve(false)));
  say(loaded ? "Loading the demo's data" : "Opening the data kept in this browser");
  const create: PGliteOptions = {
    extensions: { btree_gist: options.modules.btree_gist },
    relaxedDurability: false,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(loaded && options.snapshot ? { loadDataDir: await options.snapshot() } : {}),
    ...options.cluster,
  };
  const pg = await options.modules.PGlite.create(create);
  try {
    say("Applying the migrations");
    await pg.exec(ROLES);
    const migrated = await migrate(pg, options.migrations);
    await pg.exec(DEMO_SCHEMA);
    const clock = await pg.query<[string, string]>(
      "select offset_ms::text, coalesce((select (extract(epoch from max(at)) * 1000)::bigint from audit_event), 0)::text "
      + "from demo.clock", [], { rowMode: "array" });
    await pg.syncToFs();
    await pg.exec("set time zone 'UTC'; set role commerce");
    const [offsetMs, latestEventMs] = (clock.rows[0] ?? ["0", "0"]).map(Number) as [number, number];
    return { session: new Session(pg), loaded, migrated, offsetMs, latestEventMs };
  } catch (error) {
    await pg.close().catch(() => {});
    throw error;
  }
}
