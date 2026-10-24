// Flyway's command line on its own Java runtime, both pinned by checksum in
// tools/flyway-lock.json. FLYWAY_JAVA and FLYWAY_LIB point to a copy already
// on the machine (or .tools/flyway-home.json does, with "java" and "lib");
// otherwise `npm run setup` downloads one into .tools/.
//
// Nothing leaves the machine: Redgate's telemetry is switched off with the
// variable its documentation gives (REDGATE_DISABLE_TELEMETRY), and Java's
// HTTP and HTTPS go to a proxy on a closed local port. The password travels
// in the environment, not on the command line, where any process could read it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import lock from "../flyway-lock.json" with { type: "json" };
import { exe, migrationsDir, platformKey, toolsDir } from "./paths.ts";
import { run, type Ran } from "./run.ts";

export const flywayLock = lock;

type PinnedRuntime = { version: string; folder: string; bytes: number; sha256: string; url: string };

export function pinnedRuntime(): PinnedRuntime {
  const runtime = (lock.jre as Record<string, PinnedRuntime>)[platformKey];
  if (!runtime) throw new Error(`no Java runtime pinned for ${platformKey} in tools/flyway-lock.json`);
  return runtime;
}

export function flywayHome(): { java: string; lib: string; from: string } {
  const java = process.env["FLYWAY_JAVA"];
  const lib = process.env["FLYWAY_LIB"];
  if (java || lib) {
    if (!java || !lib) throw new Error("set both FLYWAY_JAVA (the java executable) and FLYWAY_LIB (the folder of Flyway's jars), or neither");
    return { java, lib, from: "FLYWAY_JAVA and FLYWAY_LIB" };
  }
  const pointer = join(toolsDir, "flyway-home.json");
  if (existsSync(pointer)) {
    const home = JSON.parse(readFileSync(pointer, "utf8")) as { java?: string; lib?: string };
    if (!home.java || !home.lib) throw new Error(`${pointer} needs both "java" and "lib"`);
    return { java: home.java, lib: home.lib, from: ".tools/flyway-home.json" };
  }
  return {
    java: join(toolsDir, pinnedRuntime().folder, "bin", exe("java")),
    lib: join(toolsDir, `flyway-${lock.flyway}`, "lib"),
    from: ".tools",
  };
}

export type FlywayTarget = { port: number; database: string; user: string; password: string };

export async function flyway(verb: "info" | "migrate" | "validate", target: FlywayTarget, locations = migrationsDir): Promise<Ran> {
  const home = flywayHome();
  if (!existsSync(home.java)) throw new Error(`no Java runtime at ${home.java}: run npm run setup`);
  // Java expands a classpath entry ending in * to the jars of that folder itself,
  // on every system, so no shell is involved.
  return run(home.java, [
    "-Dhttp.proxyHost=127.0.0.1", "-Dhttp.proxyPort=9", "-Dhttps.proxyHost=127.0.0.1", "-Dhttps.proxyPort=9",
    "-cp", join(home.lib, "*"), lock.mainClass, verb,
  ], {
    env: {
      ...process.env,
      REDGATE_DISABLE_TELEMETRY: "true",
      FLYWAY_URL: `jdbc:postgresql://127.0.0.1:${target.port}/${target.database}`,
      FLYWAY_USER: target.user,
      FLYWAY_PASSWORD: target.password,
      FLYWAY_LOCATIONS: `filesystem:${locations}`,
      FLYWAY_PLACEHOLDER_REPLACEMENT: "false",
      FLYWAY_VALIDATE_MIGRATION_NAMING: "true",
      FLYWAY_CONNECT_RETRIES: "0",
    },
  });
}
