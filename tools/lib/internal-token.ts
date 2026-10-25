// The secrets of a development machine, kept in .data/ (ignored by git): the
// internal token the gateway sends the engine (authorization: Bearer), and
// the key that signs the gateway's session cookies. One implementation for
// every process that needs them: `npm run engine` (tools/engine.ts) and the
// gateway's Node shell (services/gateway/src/node/config.ts).
//
// The internal token is COMMERCE_INTERNAL_TOKEN when it is set. When it is
// not, it is the file .data/internal-token: 32 random bytes in hex, created by
// whichever of the engine or the gateway starts first (convention 4 of
// proto/README.md).
//
// The creation is exclusive and whole: the secret is written to a file of
// this process and then linked into place, which fails if the file already
// exists, so the second to start reads the first one's secret and never a
// half-written file. A reader still waits a moment for a file that is not
// whole yet, in case another writer creates it in place.
import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dataDir, repoRoot } from "./paths.ts";

const SHAPE = /^[0-9a-f]{64}$/;
export const tokenFile = join(dataDir, "internal-token");

/** The secret in `file`, created there first when there is none. */
export async function localSecret(file: string): Promise<{ secret: string; created: boolean }> {
  await mkdir(dirname(file), { recursive: true });
  const mine = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(mine, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  let created = true;
  try {
    await link(mine, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    created = false;
  } finally {
    await rm(mine, { force: true });
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const secret = (await readFile(file, "utf8")).trim();
    if (SHAPE.test(secret)) return { secret, created };
    await sleep(50);
  }
  throw new Error(`${file} does not hold 64 hex characters: delete it and start again`);
}

/** The internal token: from the environment, or the development file of `dir`. */
export async function internalToken(env: NodeJS.ProcessEnv = process.env, dir: string = dataDir): Promise<{ token: string; from: string }> {
  const fromEnvironment = env["COMMERCE_INTERNAL_TOKEN"];
  if (fromEnvironment) return { token: fromEnvironment, from: "COMMERCE_INTERNAL_TOKEN" };
  const file = join(dir, "internal-token");
  const { secret, created } = await localSecret(file);
  const where = relative(repoRoot, file).replaceAll("\\", "/");
  return { token: secret, from: created ? `${where}, created now` : where };
}
