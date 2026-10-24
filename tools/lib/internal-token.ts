// The internal token the gateway sends the engine (authorization: Bearer).
//
// COMMERCE_INTERNAL_TOKEN when it is set. On a development machine, when it is
// not, the file .data/internal-token (ignored by git): 32 random bytes in hex,
// created by whichever of the engine or the gateway starts first. The creation
// is exclusive and whole: the token is written to a file of this process and
// then linked into place, which fails if the file already exists, so the
// second to start reads the first one's token and never a half-written file.
import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths.ts";

const SHAPE = /^[0-9a-f]{64}$/;
export const tokenFile = join(dataDir, "internal-token");

export async function internalToken(): Promise<{ token: string; from: string }> {
  const fromEnvironment = process.env["COMMERCE_INTERNAL_TOKEN"];
  if (fromEnvironment) return { token: fromEnvironment, from: "COMMERCE_INTERNAL_TOKEN" };
  await mkdir(dataDir, { recursive: true });
  const mine = `${tokenFile}.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(mine, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  let created = true;
  try {
    await link(mine, tokenFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    created = false;
  } finally {
    await rm(mine, { force: true });
  }
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!SHAPE.test(token)) throw new Error(`${tokenFile} does not hold 64 hex characters: delete it and start again`);
  return { token, from: created ? ".data/internal-token, created now" : ".data/internal-token" };
}
