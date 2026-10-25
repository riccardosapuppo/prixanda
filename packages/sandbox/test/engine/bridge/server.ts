// The browser's database for the engine's own tests in CPython: PGlite in
// Node, behind the same Session the browser's engine calls (database.ts),
// spoken to as JSON lines on standard input and output. The engine's service
// tests run on it unchanged, through the same adapter as in the browser
// (services/commerce/tests/pglite_world.py, the check's sandbox-services).
//
// One request per line, {"id", "op", ...}, one answer per line, {"id", "reply"}
// or {"id", "error"}; the answers come in the order the work ends, each with
// its request's id:
//   cluster             a new cluster, migrated by the browser's runner: its instance
//   template instance   that cluster saved as the template every test starts from, and closed
//   open                a new instance from the template
//   close instance
//   begin, query, copy, end   the Session's own (database.ts), on one instance
import { createInterface } from "node:readline";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { openDatabase, Session } from "../../../src/engine/database.ts";
import type { Migration } from "../../../src/engine/migrations.ts";
import { readMigrations } from "../../../src/engine/build/assets.ts";

type Request = { id: number; op: string; instance?: number; readonly?: boolean; tx?: number; sql?: string; params?: string; data?: string; commit?: boolean };

const sessions = new Map<number, Session>();
let next = 1;
let template: Blob | null = null;
let migrations: Migration[] | null = null;

const say = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

function session(request: Request): Session {
  const found = sessions.get(request.instance ?? -1);
  if (!found) throw new Error(`no instance ${request.instance}`);
  return found;
}

async function answer(request: Request): Promise<unknown> {
  switch (request.op) {
    case "cluster": {
      migrations ??= await readMigrations();
      const opened = await openDatabase({
        modules: { PGlite, btree_gist }, migrations, exists: async () => false,
        cluster: { initDbStartParams: ["--wal-segsize=1", "--locale=C"] },
      });
      await opened.saved;
      const id = next++;
      sessions.set(id, opened.session);
      return { instance: id };
    }
    case "template": {
      const pg = session(request).pg;
      template = await pg.dumpDataDir("none");
      await pg.close();
      sessions.delete(request.instance as number);
      return {};
    }
    case "open": {
      if (!template) throw new Error("no template yet");
      const pg = await PGlite.create({ loadDataDir: template, extensions: { btree_gist } });
      await pg.exec("set time zone 'UTC'; set role commerce");
      const id = next++;
      sessions.set(id, new Session(pg));
      return { instance: id };
    }
    case "close": {
      await session(request).pg.close();
      sessions.delete(request.instance as number);
      return {};
    }
    case "begin":
      return { reply: await session(request).begin(Boolean(request.readonly)) };
    case "query":
      return { reply: await session(request).query(request.tx as number, request.sql as string, request.params as string) };
    case "copy":
      return { reply: await session(request).copy(request.tx as number, request.sql as string, request.data as string) };
    case "end":
      return { reply: await session(request).end(request.tx as number, Boolean(request.commit)) };
    default:
      throw new Error(`no operation ${request.op}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    return;
  }
  answer(request).then((value) => say({ id: request.id, ...(value as object) }),
    (error: unknown) => say({ id: request.id, error: error instanceof Error ? error.message : String(error) }));
});
lines.on("close", () => {
  void Promise.all([...sessions.values()].map((s) => s.pg.close().catch(() => {}))).then(() => process.exit(0));
});
