// PostgreSQL 18 without installing it: the binaries npm brings in
// @embedded-postgres/<platform>, driven by initdb and pg_ctl.
//
// Not the embedded-postgres class itself: on Windows it stops the server with
// `taskkill /f /t`, which once left an orphaned child holding the shared
// memory so that the next cluster could not start, and its exit hook turned a
// failed run's exit code into 0. pg_ctl stops the server the way PostgreSQL
// expects, children included.
//
// Each cluster gets random passwords when it is created, kept beside its data
// directory in .data/ (ignored by git) and printed only when asked for
// (npm run db -- url).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { platformKey } from "./paths.ts";
import { assertFree } from "./ports.ts";
import { run, runOrThrow } from "./run.ts";

export type Credentials = { user: string; password: string };

export type Cluster = {
  port: number;
  dataDir: string;
  owner: Credentials;
  app: Credentials;
  url(database: string, who?: "owner" | "app"): string;
  sql<T extends object = Record<string, unknown>>(database: string, text: string, values?: unknown[]): Promise<T[]>;
  stop(): Promise<void>;
};

// commerce_app holds the engine's permissions (the migrations grant them to
// it); commerce is the login the engine connects with, a member of it.
export const APP_ROLE = "commerce_app";
export const APP_LOGIN = "commerce";

const PACKAGES: Record<string, string> = {
  "win32-x64": "@embedded-postgres/windows-x64",
  "linux-x64": "@embedded-postgres/linux-x64",
};

type Binaries = { initdb: string; pg_ctl: string };

async function binaries(): Promise<Binaries> {
  const name = PACKAGES[platformKey];
  if (!name) throw new Error(`no PostgreSQL binaries for ${platformKey}: package.json lists Windows x64 and Linux x64`);
  try {
    return (await import(name)) as Binaries;
  } catch {
    throw new Error(`${name} is missing: run npm install (npm installs only the package for this system)`);
  }
}

const secret = () => randomBytes(18).toString("base64url");
const NAME = /^[a-z][a-z0-9_]{0,62}$/;

// pg_ctl status: 0 when the server of that data directory runs, 3 when not.
export async function isRunning(dataDir: string): Promise<boolean> {
  if (!existsSync(join(dataDir, "PG_VERSION"))) return false;
  const bin = await binaries();
  return (await run(bin.pg_ctl, ["status", "-D", dataDir])).code === 0;
}

export async function stopIfRunning(dataDir: string): Promise<boolean> {
  if (!(await isRunning(dataDir))) return false;
  const bin = await binaries();
  await runOrThrow(bin.pg_ctl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "60"]);
  return true;
}

// An ephemeral cluster is created from nothing and deleted when it stops; a
// persistent one is created the first time and kept, and when it already
// runs it is used as it is.
export async function startCluster(options: { dataDir: string; port: number; ephemeral: boolean; fast?: boolean }): Promise<Cluster> {
  const { dataDir, port } = options;
  const bin = await binaries();
  const credentialsFile = `${dataDir}.credentials.json`;
  // An ephemeral cluster left running by a run that died before stopping it.
  if (options.ephemeral) await stopIfRunning(dataDir);
  const alreadyRunning = !options.ephemeral && (await isRunning(dataDir));
  if (!alreadyRunning) await assertFree(port, `PostgreSQL in ${dataDir}`);

  let owner: Credentials;
  let app: Credentials;
  if (options.ephemeral || !existsSync(join(dataDir, "PG_VERSION"))) {
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dataDir, { recursive: true });
    owner = { user: "postgres", password: secret() };
    app = { user: APP_LOGIN, password: secret() };
    const passwordFile = `${dataDir}.password`;
    await writeFile(passwordFile, `${owner.password}\n`, { mode: 0o600 });
    try {
      await runOrThrow(bin.initdb, [
        `--pgdata=${dataDir}`, "--auth=scram-sha-256", `--username=${owner.user}`, `--pwfile=${passwordFile}`,
        "--encoding=UTF8", "--locale=C", "--no-instructions",
      ]);
    } finally {
      await rm(passwordFile, { force: true });
    }
    // Only 127.0.0.1, no Unix socket (its default folder is not writable for a
    // normal user on Linux), and no durability for the throwaway check clusters.
    const settings = [
      `port = ${port}`,
      "listen_addresses = '127.0.0.1'",
      "unix_socket_directories = ''",
      ...(options.fast ? ["fsync = off", "synchronous_commit = off", "full_page_writes = off"] : []),
    ];
    await appendFile(join(dataDir, "postgresql.conf"), `\n# Set by tools/lib/postgres.ts\n${settings.join("\n")}\n`);
    await writeFile(credentialsFile, `${JSON.stringify({ owner, app }, null, 2)}\n`, { mode: 0o600 });
  } else {
    ({ owner, app } = JSON.parse(await readFile(credentialsFile, "utf8")) as { owner: Credentials; app: Credentials });
  }
  if (!alreadyRunning) {
    await runOrThrow(bin.pg_ctl, ["start", "-D", dataDir, "-w", "-t", "60", "-l", join(dataDir, "server.log")]);
  }

  const connect = async (database: string, who: Credentials) => {
    const client = new pg.Client({ host: "127.0.0.1", port, user: who.user, password: who.password, database });
    await client.connect();
    return client;
  };
  const cluster: Cluster = {
    port,
    dataDir,
    owner,
    app,
    url(database, who = "app") {
      const as = who === "owner" ? owner : app;
      // The URL API encodes the user and the password itself.
      const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
      url.username = as.user;
      url.password = as.password;
      return url.href;
    },
    async sql<T extends object>(database: string, text: string, values: unknown[] = []) {
      const client = await connect(database, owner);
      try {
        return (await client.query(text, values)).rows as T[];
      } finally {
        await client.end();
      }
    },
    async stop() {
      await runOrThrow(bin.pg_ctl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "60"]);
      if (options.ephemeral) {
        await rm(dataDir, { recursive: true, force: true });
        await rm(credentialsFile, { force: true });
      }
    },
  };

  const client = await connect("postgres", owner);
  try {
    await client.query(`do $$ begin
      if not exists (select from pg_roles where rolname = '${APP_ROLE}') then create role ${APP_ROLE} nologin; end if;
      if not exists (select from pg_roles where rolname = '${APP_LOGIN}') then create role ${APP_LOGIN} login in role ${APP_ROLE}; end if;
    end $$`);
    await client.query(`alter role ${APP_LOGIN} password ${client.escapeLiteral(app.password)}`);
  } finally {
    await client.end();
  }
  return cluster;
}

export async function createDatabase(cluster: Cluster, name: string, template?: string): Promise<void> {
  if (!NAME.test(name) || (template && !NAME.test(template))) throw new Error(`not a database name: ${name}`);
  await cluster.sql("postgres", `create database ${name}${template ? ` template ${template}` : ""}`);
}

export async function dropDatabase(cluster: Cluster, name: string): Promise<void> {
  if (!NAME.test(name)) throw new Error(`not a database name: ${name}`);
  await cluster.sql("postgres", `drop database if exists ${name} with (force)`);
}
