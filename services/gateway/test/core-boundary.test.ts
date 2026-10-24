// The core (schemas, resolvers, loaders) runs in a browser in stage 8: it may
// import the graphql package, DataLoader, the protobuf runtime, Connect's
// transport-free client and the generated contract, and nothing that needs
// Node. The imports are read by TypeScript's own scanner, which skips
// comments and strings, so a sentence that names node:http is not an import
// and an import cannot hide from a pattern (PROMPT.md, rules 115 and 125).
// tsconfig.core.json checks the same from the other side: no Node types.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";

const CORE = join(import.meta.dirname, "..", "src", "core");
const ALLOWED_PACKAGES = ["graphql", "dataloader", "@bufbuild/protobuf", "@connectrpc/connect"];

/** What a core module may not import, and why, given its specifiers. */
function forbidden(file: string, specifiers: readonly string[]): string[] {
  const problems: string[] = [];
  for (const specifier of specifiers) {
    if (specifier.startsWith(".")) {
      const inside = relative(CORE, resolve(join(file, ".."), specifier));
      if (inside.startsWith("..") || isAbsolute(inside)) problems.push(`${specifier}: outside the core`);
    } else if (!ALLOWED_PACKAGES.includes(specifier) && !specifier.startsWith("contracts/commerce/")) {
      problems.push(`${specifier}: not a package the core may use`);
    }
  }
  return problems;
}

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

function imports(text: string): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName);
}

describe("the core's imports", () => {
  test("name only the graphql package, DataLoader, the protobuf runtime, Connect's client and the contract", async () => {
    const files = await sources(CORE);
    assert.ok(files.length >= 15, `only ${files.length} files were read`);
    let read = 0;
    const problems: string[] = [];
    for (const file of files) {
      const specifiers = imports(await readFile(file, "utf8"));
      read += specifiers.length;
      problems.push(...forbidden(file, specifiers).map((problem) => `${relative(CORE, file)}: ${problem}`));
    }
    assert.ok(read >= 40, `only ${read} imports were read`);
    assert.deepEqual(problems, []);
  });

  test("the check finds a Node import planted in a module, and ignores one written in a comment or a string", () => {
    const planted = [
      'import { createServer } from "node:http";',
      'import { createGrpcTransport } from "@connectrpc/connect-node";',
      'import { ApolloServer } from "@apollo/server";',
      'const fs = await import("fs");',
      'export * from "../../node/config.ts";',
      '// import { readFile } from "node:fs/promises";',
      'const text = "import os from \\"node:os\\"";',
    ].join("\n");
    const problems = forbidden(join(CORE, "planted.ts"), imports(planted));
    assert.deepEqual(problems, [
      "node:http: not a package the core may use",
      "@connectrpc/connect-node: not a package the core may use",
      "@apollo/server: not a package the core may use",
      "fs: not a package the core may use",
      "../../node/config.ts: outside the core",
    ]);
  });
});
