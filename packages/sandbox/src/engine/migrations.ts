// The migrations in the browser: the same files of db/migrations that Flyway
// applies on the server, applied by this runner to PGlite, which writes
// flyway_schema_history as Flyway does (the table, its primary key and its
// index, and each row with Flyway's description, type, script and checksum),
// so that the history of a database in the browser reads like the server's.
// The build runs it to make the snapshot (build/snapshot.ts); the browser
// runs it at every start, which applies a migration of a newer build to the
// data a visitor kept, and refuses data this build cannot account for.
//
// Like Flyway's validate, it refuses a failed migration, a migration applied
// that this build does not have, one whose checksum changed, and one of this
// build older than the newest applied (out of order). Each migration runs in
// one transaction with its row of the history, as Flyway runs it on
// PostgreSQL.
import type { PGlite } from "@electric-sql/pglite";

/** A migration as the build ships it: build/assets.ts reads db/migrations and computes the checksum. */
export type Migration = {
  readonly version: string;
  readonly description: string;
  readonly script: string;
  readonly checksum: number;
  readonly sql: string;
};

/** Flyway's table for PostgreSQL (its createMetaDataTable.sql), in the public schema. */
export const HISTORY_TABLE = `
create table "public"."flyway_schema_history" (
  "installed_rank" int not null,
  "version" varchar(50),
  "description" varchar(200) not null,
  "type" varchar(20) not null,
  "script" varchar(1000) not null,
  "checksum" integer,
  "installed_by" varchar(100) not null,
  "installed_on" timestamp not null default now(),
  "execution_time" integer not null,
  "success" boolean not null
);
alter table "public"."flyway_schema_history" add constraint "flyway_schema_history_pk" primary key ("installed_rank");
create index "flyway_schema_history_s_idx" on "public"."flyway_schema_history" ("success");`;

export class MigrationRefused extends Error {
  override readonly name = "MigrationRefused";
}

type Applied = { installed_rank: number; version: string | null; description: string; type: string; script: string; checksum: number | null; success: boolean };

/** Flyway's file name: V<version>__<description>.sql, the description's underscores read as spaces. */
export function parseScript(script: string): { version: string; description: string } {
  const match = /^V(\d+(?:[._]\d+)*)__(.+)\.sql$/.exec(script);
  if (!match?.[1] || !match[2]) throw new MigrationRefused(`${script} is not a versioned migration (V<version>__<description>.sql)`);
  return { version: match[1].replaceAll("_", "."), description: match[2].replaceAll("_", " ") };
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** What validate would say of the history against this build's migrations; null when it holds. */
export function refusal(applied: readonly Applied[], migrations: readonly Migration[]): string | null {
  const ours = new Map(migrations.map((m) => [m.version, m]));
  for (const row of applied) {
    if (!row.success) return `migration ${row.script} failed in this database: it must be repaired, as Flyway says`;
    if (row.version === null) continue; // a row of Flyway's own, like the creation of a schema
    const migration = ours.get(row.version);
    if (!migration) return `migration V${row.version} was applied to this database, and this build does not have it`;
    if (migration.checksum !== row.checksum || migration.script !== row.script || migration.description !== row.description) {
      return `migration V${row.version} changed since it was applied (checksum ${row.checksum}, this build's ${migration.checksum})`;
    }
  }
  const newest = applied.filter((row) => row.version !== null).map((row) => row.version as string).sort(compareVersions).at(-1);
  if (newest !== undefined) {
    const done = new Set(applied.map((row) => row.version));
    const late = migrations.find((m) => !done.has(m.version) && compareVersions(m.version, newest) < 0);
    if (late) return `migration ${late.script} is older than V${newest}, the newest applied: it would run out of order`;
  }
  return null;
}

export type Migrated = { readonly applied: readonly string[]; readonly ms: number };

/** Applies the migrations not applied yet, each in a transaction with its row of the history, as the owner. */
export async function migrate(pg: PGlite, migrations: readonly Migration[], installedBy = "postgres"): Promise<Migrated> {
  const started = performance.now();
  const sorted = [...migrations].sort((a, b) => compareVersions(a.version, b.version));
  const applied = await pg.transaction(async (tx) => {
    const exists = await tx.query<{ found: boolean }>("select to_regclass('public.flyway_schema_history') is not null as found");
    if (!exists.rows[0]?.found) await tx.exec(HISTORY_TABLE);
    return (await tx.query<Applied>("select installed_rank, version, description, type, script, checksum, success "
      + "from flyway_schema_history order by installed_rank")).rows;
  });
  const refused = refusal(applied, sorted);
  if (refused) throw new MigrationRefused(refused);
  const done = new Set(applied.map((row) => row.version));
  const now: string[] = [];
  for (const migration of sorted) {
    if (done.has(migration.version)) continue;
    await pg.transaction(async (tx) => {
      const begun = performance.now();
      await tx.exec(migration.sql);
      await tx.query(
        "insert into flyway_schema_history (installed_rank, version, description, type, script, checksum, installed_by, "
        + "execution_time, success) values ((select coalesce(max(installed_rank), 0) + 1 from flyway_schema_history), "
        + "$1, $2, 'SQL', $3, $4, $5, $6, true)",
        [migration.version, migration.description, migration.script, migration.checksum, installedBy,
          Math.round(performance.now() - begun)],
      );
    });
    now.push(migration.script);
  }
  return { applied: now, ms: Math.round(performance.now() - started) };
}
