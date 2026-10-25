// The engine of the demo in Node, for its tests: the same modules as the
// browser's (createEngine), PGlite and Pyodide from node_modules, the data
// in memory, and the files the build wrote (SANDBOX_ENGINE_ASSETS, made by
// `node packages/sandbox/src/engine/build/assets.ts <folder>`). And a call of
// the contract the way the gateway makes it: protobuf in binary, metadata.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { create, fromBinary, type DescMessage, type MessageInitShape, type MessageShape, toBinary } from "@bufbuild/protobuf";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { loadPyodide } from "pyodide";
import { pyodideDir } from "../../src/engine/build/wheels.ts";
import { createEngine, type Manifest, type SandboxEngine } from "../../src/engine/index.ts";
import type { Migration } from "../../src/engine/migrations.ts";

export function assetsDir(): string {
  const dir = process.env["SANDBOX_ENGINE_ASSETS"];
  if (!dir) throw new Error("SANDBOX_ENGINE_ASSETS names the folder the build wrote (node packages/sandbox/src/engine/build/assets.ts <folder>)");
  return dir;
}

export type NodeEngine = { engine: SandboxEngine; token: string; logs: string[]; manifest: Manifest };

export async function nodeEngine(assets = assetsDir()): Promise<NodeEngine> {
  const manifest = JSON.parse(await readFile(join(assets, "engine", "manifest.json"), "utf8")) as Manifest;
  const token = randomBytes(32).toString("base64url");
  const logs: string[] = [];
  const zip = await readFile(join(assets, "engine", manifest.engine));
  const engine = await createEngine({
    modules: { PGlite, btree_gist },
    python: {
      loadPyodide,
      indexURL: pyodideDir(),
      packageBaseUrl: `${join(assets, "pyodide").replaceAll("\\", "/")}/`,
      engine: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer,
    },
    snapshot: async () => new Blob([await readFile(join(assets, "engine", manifest.snapshot))]),
    migrations: async () => JSON.parse(await readFile(join(assets, "engine", manifest.migrations), "utf8")) as Migration[],
    token,
    onLog: (line) => logs.push(line),
  });
  return { engine, token, logs, manifest };
}

export type Who = readonly [actor: string, role: string] | null;
export const MARKETING: Who = ["marketing-1", "marketing"];
export const FINANCE: Who = ["finance-1", "finance"];
export const ON_CALL: Who = ["on-call-1", "on_call"];
export const PUBLIC: Who = null;

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

type Method<I extends DescMessage, O extends DescMessage> = {
  readonly name: string;
  readonly input: I;
  readonly output: O;
  readonly parent: { readonly typeName: string };
};

/** A call as the gateway makes it: a request id, the token, who acts, and a key of its own for every call. */
export async function rpc<I extends DescMessage, O extends DescMessage>(
  on: NodeEngine, method: Method<I, O>, input: MessageInitShape<I>, who: Who = PUBLIC,
  options: { key?: string; token?: string | null } = {},
): Promise<MessageShape<O>> {
  const metadata: Record<string, string> = { "x-request-id": `test-${randomUUID()}`, "idempotency-key": options.key ?? `key-${randomUUID()}` };
  if (options.token !== null) metadata["authorization"] = `Bearer ${options.token ?? on.token}`;
  if (who) {
    metadata["x-actor"] = who[0];
    metadata["x-actor-role"] = who[1];
  }
  const request = toBinary(method.input, create(method.input, input));
  const reply = await on.engine.call(method.parent.typeName, method.name, metadata, request);
  if (!reply.ok) throw new RpcError(reply.code, reply.message);
  return fromBinary(method.output, reply.response);
}

/** The local date and time in Rome, days from now, at that hour: "2026-10-26T09:00". */
export function romeLocal(from: Date, days: number, hour: number): string {
  const day = new Date(from.getTime() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(day);
  return `${parts}T${String(hour).padStart(2, "0")}:00`;
}
