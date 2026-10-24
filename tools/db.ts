// npm run db -- <command>: the local development database, a PostgreSQL 18
// cluster in .data/postgres on 127.0.0.1:4601, database "commerce".
//
//   start    create the cluster the first time, start it, create the
//            database and apply the migrations with Flyway
//   migrate  apply new migrations
//   info     Flyway's view of the migrations
//   url      print the URL the engine connects with (role commerce)
//   stop     stop the cluster; the data stays
//   delete   stop it and remove .data/postgres
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { flyway } from "./lib/flyway.ts";
import { dataDir, PORTS } from "./lib/paths.ts";
import { type Cluster, createDatabase, isRunning, startCluster, stopIfRunning } from "./lib/postgres.ts";

const DATABASE = "commerce";
const clusterDir = join(dataDir, "postgres");
const say = (line: string) => console.log(`[db] ${line}`);

async function running(): Promise<Cluster> {
  if (!(await isRunning(clusterDir))) throw new Error("the development database is not running: npm run db -- start");
  return startCluster({ dataDir: clusterDir, port: PORTS.postgresDev, ephemeral: false });
}

async function migrate(cluster: Cluster, verb: "migrate" | "info"): Promise<boolean> {
  const ran = await flyway(verb, { port: cluster.port, database: DATABASE, user: cluster.owner.user, password: cluster.owner.password });
  process.stdout.write(ran.output);
  return ran.code === 0;
}

const command = process.argv[2] ?? "help";
switch (command) {
  case "start": {
    const cluster = await startCluster({ dataDir: clusterDir, port: PORTS.postgresDev, ephemeral: false });
    const found = await cluster.sql<{ n: number }>("postgres", "select count(*)::int as n from pg_database where datname = $1", [DATABASE]);
    if (found[0]?.n !== 1) await createDatabase(cluster, DATABASE);
    if (!(await migrate(cluster, "migrate"))) {
      process.exitCode = 1;
      break;
    }
    say(`running on 127.0.0.1:${cluster.port}, database ${DATABASE}; npm run db -- url prints the engine's URL`);
    break;
  }
  case "migrate":
  case "info":
    if (!(await migrate(await running(), command))) process.exitCode = 1;
    break;
  case "url":
    console.log((await running()).url(DATABASE, "app"));
    break;
  case "stop":
    say((await stopIfRunning(clusterDir)) ? "stopped" : "was not running");
    break;
  case "delete":
    await stopIfRunning(clusterDir);
    await rm(clusterDir, { recursive: true, force: true });
    await rm(`${clusterDir}.credentials.json`, { force: true });
    say("removed .data/postgres");
    break;
  default:
    console.log("usage: npm run db -- start | migrate | info | url | stop | delete");
    process.exitCode = command === "help" ? 0 : 2;
}
