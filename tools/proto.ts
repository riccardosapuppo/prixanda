// npm run proto: lints the contract in proto/ with buf, then generates the
// code each side uses, from the same files:
//   - JavaScript with type declarations for the gateway, in packages/contracts/gen;
//   - Python for the engine, in services/commerce/src/commerce/v1.
// The generated files are committed. `npm run proto -- --check` generates into
// a temporary folder instead and fails when anything differs from what is
// committed: a contract changed without regenerating does not pass the check.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { commerceDir, repoRoot, venvPython } from "./lib/paths.ts";
import { run, runOrThrow } from "./lib/run.ts";

const protoDir = join(repoRoot, "proto");
const buf = join(repoRoot, "node_modules", "@bufbuild", "buf", "bin", "buf");
const committed = { ts: join(repoRoot, "packages", "contracts"), py: join(commerceDir, "src") };
const say = (line: string) => console.log(`[proto] ${line}`);

async function commerceProtos(): Promise<string[]> {
  return (await readdir(join(protoDir, "commerce", "v1"))).filter((name) => name.endsWith(".proto")).map((name) => `commerce/v1/${name}`);
}

// TypeScript for commerce and the health protocol; Python only for commerce,
// because the engine's health service comes from grpcio-health-checking and a
// generated grpc/ folder would hide the real grpc package.
async function generate(tsBase: string, pyBase: string): Promise<void> {
  await runOrThrow(process.execPath, [buf, "generate", "--output", tsBase], { cwd: protoDir });
  // protoc, unlike buf, writes only into a folder that exists.
  await mkdir(pyBase, { recursive: true });
  await runOrThrow(venvPython, ["-m", "grpc_tools.protoc", "-I", ".", `--python_out=${pyBase}`, `--pyi_out=${pyBase}`,
    `--grpc_python_out=${pyBase}`, ...(await commerceProtos())], { cwd: protoDir });
}

async function files(base: string, sub: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/(_pb\.js|_pb\.d\.ts|_pb2\.py|_pb2\.pyi|_pb2_grpc\.py)$/.test(entry.name)) {
        found.set(relative(base, path).replaceAll("\\", "/"), (await readFile(path, "utf8")).replaceAll("\r\n", "\n"));
      }
    }
  };
  await walk(join(base, sub));
  return found;
}

const lint = await run(process.execPath, [buf, "lint"], { cwd: protoDir });
if (lint.code !== 0) {
  console.log(lint.output);
  say("buf lint found problems");
  process.exit(1);
}
say(`buf lint: clean (${(await commerceProtos()).length} commerce files)`);

if (process.argv.includes("--check")) {
  const temp = await mkdtemp(join(tmpdir(), "contracts-"));
  try {
    await generate(join(temp, "ts"), join(temp, "py"));
    const pairs: Array<[Map<string, string>, Map<string, string>]> = [
      [await files(join(temp, "ts"), "gen"), await files(committed.ts, "gen")],
      [await files(join(temp, "py"), "commerce/v1"), await files(committed.py, "commerce/v1")],
    ];
    const differing: string[] = [];
    let compared = 0;
    for (const [fresh, kept] of pairs) {
      for (const name of new Set([...fresh.keys(), ...kept.keys()])) {
        compared += 1;
        if (fresh.get(name) !== kept.get(name)) differing.push(name);
      }
    }
    if (compared === 0) throw new Error("no generated file was compared");
    if (differing.length) {
      say(`generated code differs from the contract: ${differing.join(", ")}; run npm run proto`);
      process.exitCode = 1;
    } else {
      say(`generated code matches the contract (${compared} files)`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
} else {
  await rm(join(committed.ts, "gen"), { recursive: true, force: true });
  for (const name of existsSync(join(committed.py, "commerce", "v1")) ? await readdir(join(committed.py, "commerce", "v1")) : []) {
    if (/_pb2(_grpc)?\.pyi?$/.test(name)) await rm(join(committed.py, "commerce", "v1", name));
  }
  await generate(committed.ts, committed.py);
  say("generated packages/contracts/gen and services/commerce/src/commerce/v1");
}
