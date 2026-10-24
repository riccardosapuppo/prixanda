// npm run engine: the engine against the development database.
//
// It starts the development PostgreSQL if it is not running (.data/postgres,
// DEV_POSTGRES_PORT), applies new migrations, loads the small generated data
// the first time (seed 7), finds or creates the internal token, checks that
// nobody listens on the engine's port, and runs `python -m commerce.server`
// on 127.0.0.1 at the port of ENGINE_URL (4611 unless set). Ctrl+C stops the
// engine in order; the database keeps running (npm run db -- stop).
import { spawn } from "node:child_process";
import { join } from "node:path";
import { flyway } from "./lib/flyway.ts";
import { internalToken } from "./lib/internal-token.ts";
import { commerceDir, dataDir, PORTS, venvPython } from "./lib/paths.ts";
import { assertFree } from "./lib/ports.ts";
import { createDatabase, startCluster } from "./lib/postgres.ts";
import { run } from "./lib/run.ts";

const DATABASE = "commerce";
const say = (line: string) => console.log(`[engine] ${line}`);

async function main(): Promise<number> {
  const cluster = await startCluster({ dataDir: join(dataDir, "postgres"), port: PORTS.postgresDev, ephemeral: false });
  const found = await cluster.sql<{ n: number }>("postgres", "select count(*)::int as n from pg_database where datname = $1", [DATABASE]);
  if (found[0]?.n !== 1) await createDatabase(cluster, DATABASE);
  const migrated = await flyway("migrate", { port: cluster.port, database: DATABASE, user: cluster.owner.user, password: cluster.owner.password });
  if (migrated.code !== 0) {
    console.log(migrated.output);
    say("the migrations failed: the engine does not start");
    return 1;
  }
  const people = await cluster.sql<{ n: number }>(DATABASE, "select count(*)::int as n from person");
  if (people[0]?.n === 0) {
    say("loading the small generated data, seed 7 (first start only)");
    const generated = await run(venvPython, ["-m", "commerce.generate", "--url", cluster.url(DATABASE, "owner"), "--size", "small", "--seed", "7"], {
      cwd: commerceDir, env: { ...process.env, PYTHONPATH: join(commerceDir, "src") },
    });
    if (generated.code !== 0) {
      console.log(generated.output);
      return 1;
    }
  }
  const demo = await cluster.sql<{ n: number }>(DATABASE, "select count(*)::int as n from demo_listener");
  if (demo[0]?.n === 0) {
    say("this database was generated before the demo's listeners existed: the site's entrance will be empty;"
      + " npm run db -- delete, then npm run engine, generates it again");
  }
  const { token, from } = await internalToken();
  await assertFree(PORTS.engine, "the engine");
  say(`database on 127.0.0.1:${cluster.port}; internal token from ${from}; engine on 127.0.0.1:${PORTS.engine}`);
  const engine = spawn(venvPython, ["-m", "commerce.server"], {
    cwd: commerceDir,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONPATH: join(commerceDir, "src"),
      COMMERCE_DATABASE_URL: cluster.url(DATABASE, "app"),
      COMMERCE_INTERNAL_TOKEN: token,
      COMMERCE_ENGINE_HOST: "127.0.0.1",
      COMMERCE_ENGINE_PORT: String(PORTS.engine),
    },
  });
  // Ctrl+C reaches the engine too, which stops in order; this process waits for it.
  process.on("SIGINT", () => say("stopping the engine"));
  return new Promise((resolve) => {
    engine.once("error", (error) => {
      say(`the engine did not start: ${error.message}`);
      resolve(1);
    });
    engine.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

process.exitCode = await main();
