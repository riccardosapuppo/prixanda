// A database's schema, read from PostgreSQL's catalog the same way on the
// server's PostgreSQL 18 (migrated by Flyway) and on PGlite (migrated by the
// browser's runner): every table and its columns, constraints, indexes,
// triggers, functions, views, sequences, types, grants, row security
// policies, partitions and extensions of the product's schema, and
// flyway_schema_history with its rows. The check compares the two
// (tools/check.ts, suite sandbox-schema): a difference is a failure.
//
// Left out, and said so: the schema demo, the browser demo's own state (its
// clock's offset), which no migration creates; the moments and authors of
// the history's rows (installed_on, installed_by, execution_time).
export type Query = (sql: string) => Promise<Array<Record<string, unknown>>>;

export const LEFT_OUT = ["the schema demo, the browser demo's own state (its clock's offset)",
  "installed_on, installed_by and execution_time of flyway_schema_history's rows"];

const SCHEMAS = "n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast', 'demo') and n.nspname not like 'pg_temp%' "
  + "and n.nspname not like 'pg_toast_temp%'";

/** Each part of the schema: a query whose rows, as text, say all there is of it. */
export const PARTS: Record<string, string> = {
  database: "select pg_encoding_to_char(encoding) as encoding, datcollate, datctype from pg_database where datname = current_database()",
  schemas: `select n.nspname, pg_get_userbyid(n.nspowner) as owner, n.nspacl::text as acl from pg_namespace n where ${SCHEMAS} order by 1`,
  extensions: "select extname, extversion, (select nspname from pg_namespace where oid = extnamespace) as schema from pg_extension order by 1",
  relations: `select n.nspname, c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity, c.relispartition,
      coalesce(c.reloptions::text, '') as options, pg_get_userbyid(c.relowner) as owner, coalesce(c.relacl::text, '') as acl,
      coalesce(pg_get_partkeydef(c.oid), '') as partition_key, coalesce(pg_get_expr(c.relpartbound, c.oid), '') as partition_bound,
      coalesce((select string_agg(p.relname, ',' order by p.relname) from pg_inherits i join pg_class p on p.oid = i.inhparent
                where i.inhrelid = c.oid), '') as parents,
      coalesce(obj_description(c.oid, 'pg_class'), '') as comment
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where ${SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f', 'c', 'i', 'I') order by 1, 2`,
  columns: `select n.nspname, c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull,
      coalesce(pg_get_expr(d.adbin, d.adrelid), '') as default, a.attidentity, a.attgenerated,
      coalesce((select collname from pg_collation where oid = a.attcollation and collname <> 'default'), '') as collation,
      coalesce(a.attacl::text, '') as acl, coalesce(col_description(c.oid, a.attnum), '') as comment
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where ${SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm', 'f', 'c') and a.attnum > 0 and not a.attisdropped order by 1, 2, 3`,
  constraints: `select n.nspname, c.relname, k.conname, k.contype, pg_get_constraintdef(k.oid, true) as definition,
      k.condeferrable, k.condeferred, k.convalidated, k.connoinherit
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
    where ${SCHEMAS} order by 1, 2, 3`,
  indexes: `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname not in ('pg_catalog', 'information_schema', 'demo')
    order by 1, 2, 3`,
  triggers: `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid, true) as definition, t.tgenabled
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where ${SCHEMAS} and not t.tgisinternal order by 1, 2, 3`,
  functions: `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as arguments, p.prokind,
      pg_get_function_result(p.oid) as result, p.provolatile, p.prosecdef, p.proleakproof, p.proisstrict,
      coalesce(p.proconfig::text, '') as config, coalesce(p.proacl::text, '') as acl, pg_get_userbyid(p.proowner) as owner,
      case when p.prokind in ('f', 'p', 'w') then pg_get_functiondef(p.oid) else '' end as definition
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ${SCHEMAS} and not exists (select from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1, 2, 3`,
  views: `select schemaname, viewname, definition from pg_views where schemaname not in ('pg_catalog', 'information_schema', 'demo')
    union all select schemaname, matviewname, definition from pg_matviews where schemaname not in ('demo') order by 1, 2`,
  sequences: `select schemaname, sequencename, data_type::text, start_value, min_value, max_value, increment_by, cycle, cache_size
    from pg_sequences where schemaname not in ('demo') order by 1, 2`,
  types: `select n.nspname, t.typname, t.typtype, coalesce(format_type(t.typbasetype, t.typtypmod), '') as base, t.typnotnull,
      coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '') as labels,
      coalesce((select string_agg(pg_get_constraintdef(k.oid, true), ' ' order by k.conname) from pg_constraint k where k.contypid = t.oid), '') as checks
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where ${SCHEMAS} and t.typtype in ('e', 'd', 'r', 'm') order by 1, 2`,
  policies: "select schemaname, tablename, policyname, permissive, roles::text, cmd, coalesce(qual, '') as qual, "
    + "coalesce(with_check, '') as with_check from pg_policies where schemaname not in ('demo') order by 1, 2, 3",
  roles: "select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls from pg_roles "
    + "where rolname in ('commerce', 'commerce_app') order by 1",
  memberships: "select r.rolname as role, m.rolname as member from pg_auth_members a join pg_roles r on r.oid = a.roleid "
    + "join pg_roles m on m.oid = a.member where r.rolname in ('commerce', 'commerce_app') or m.rolname in ('commerce', 'commerce_app') order by 1, 2",
  history: "select installed_rank, version, description, type, script, checksum, success from flyway_schema_history order by installed_rank",
};

export type Description = Record<string, string[]>;

const text = (value: unknown): string => (value === null || value === undefined ? "∅" : typeof value === "object" ? JSON.stringify(value) : String(value));

export async function describe(query: Query): Promise<Description> {
  const description: Description = {};
  for (const [part, sql] of Object.entries(PARTS)) {
    description[part] = (await query(sql)).map((row) => Object.entries(row).map(([key, value]) => `${key}=${text(value)}`).join(" | "));
  }
  return description;
}

export type Difference = { part: string; onlyLeft: string[]; onlyRight: string[] };

/** What one side has and the other has not, part by part. */
export function compare(left: Description, right: Description): Difference[] {
  const found: Difference[] = [];
  for (const part of Object.keys(PARTS)) {
    const a = new Set(left[part] ?? []);
    const b = new Set(right[part] ?? []);
    const onlyLeft = [...a].filter((row) => !b.has(row));
    const onlyRight = [...b].filter((row) => !a.has(row));
    if (onlyLeft.length || onlyRight.length) found.push({ part, onlyLeft, onlyRight });
  }
  return found;
}

export function counts(description: Description): Record<string, number> {
  return Object.fromEntries(Object.entries(description).map(([part, rows]) => [part, rows.length]));
}
