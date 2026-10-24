// npm run codegen -w console: the console's GraphQL operations are written
// by hand in src/graphql/operations/*.graphql against the gateway's internal
// schema (services/gateway/schema/internal.graphql); this checks them against
// the schema and generates src/graphql/generated.ts with GraphQL Code
// Generator:
//   - the TypeScript types of every operation's result and variables;
//   - one constant per operation with its whole text (the operation and the
//     fragments it uses), typed with those types.
// The generated file is committed. `--check` generates in memory and fails
// when the committed file differs, or when an operation does not validate
// against the schema: a schema that changed under the console stops here.
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { codegen } from "@graphql-codegen/core";
import * as operationsPlugin from "@graphql-codegen/typescript-operations";
import {
  buildSchema, type DefinitionNode, type DocumentNode, type FragmentDefinitionNode, Kind, type OperationDefinitionNode, parse, print,
  validate, visit,
} from "graphql";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(app, "..", "..");
const schemaFile = join(repoRoot, "services", "gateway", "schema", "internal.graphql");
const operationsDir = join(app, "src", "graphql", "operations");
const out = join(app, "src", "graphql", "generated.ts");
const say = (line: string) => console.log(`[codegen] ${line}`);

// How the console holds each scalar of the schema (the gateway's README and
// the schema's own descriptions say how each travels).
const SCALARS = {
  Money: "{ readonly amountMinor: string; readonly currency: string }",
  LocalDateTime: "string",
  DateTime: "string",
  MarketCode: "string",
  PlanCode: "string",
  Sha256: "string",
};

/** The fragments an operation uses, its own and theirs, in a stable order. */
function fragmentClosure(node: DefinitionNode, fragments: Map<string, FragmentDefinitionNode>): FragmentDefinitionNode[] {
  const found = new Map<string, FragmentDefinitionNode>();
  const walk = (current: DefinitionNode) => {
    visit(current, {
      FragmentSpread(spread) {
        const name = spread.name.value;
        if (found.has(name)) return;
        const fragment = fragments.get(name);
        if (fragment === undefined) throw new Error(`the fragment ${name} is used but not defined`);
        found.set(name, fragment);
        walk(fragment);
      },
    });
  };
  walk(node);
  return [...found.values()].sort((a, b) => a.name.value.localeCompare(b.name.value));
}

async function generate(): Promise<string> {
  const schema = buildSchema((await readFile(schemaFile, "utf8")).replaceAll("\r\n", "\n"));
  const files = (await readdir(operationsDir)).filter((name) => name.endsWith(".graphql")).sort();
  if (files.length === 0) throw new Error(`no operations in ${relative(repoRoot, operationsDir)}`);
  const definitions: DefinitionNode[] = [];
  for (const file of files) definitions.push(...parse(await readFile(join(operationsDir, file), "utf8")).definitions);
  const document: DocumentNode = { kind: Kind.DOCUMENT, definitions };
  const errors = validate(schema, document);
  if (errors.length) throw new Error(`the operations do not validate against internal.graphql:\n${errors.map((error) => `  ${error.message}`).join("\n")}`);

  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations: OperationDefinitionNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      if (fragments.has(definition.name.value)) throw new Error(`two fragments called ${definition.name.value}`);
      fragments.set(definition.name.value, definition);
    } else if (definition.kind === Kind.OPERATION_DEFINITION) {
      if (!definition.name) throw new Error("every operation needs a name: it travels as operationName and names the generated types");
      if (definition.operation === "subscription") throw new Error("the console's API has no subscriptions");
      operations.push(definition);
    }
  }

  const types = await codegen({
    filename: "generated.ts",
    schema: parse(await readFile(schemaFile, "utf8")),
    schemaAst: schema,
    documents: [{ document, location: relative(repoRoot, operationsDir).replaceAll("\\", "/") }],
    // typescript-operations writes the schema's enums, inputs and scalars that
    // the operations use, and the operations' types.
    plugins: [{ "typescript-operations": {} }],
    pluginMap: { "typescript-operations": operationsPlugin },
    config: {
      onlyOperationTypes: true,
      enumsAsTypes: true,
      useTypeImports: true,
      strictScalars: true,
      scalars: SCALARS,
      skipTypename: true,
      preResolveTypes: true,
      immutableTypes: true,
      arrayInputCoercion: false,
      avoidOptionals: { field: true, inputValue: false, object: false, defaultValue: false },
    },
  });

  const constants = operations.map((operation) => {
    const name = operation.name?.value ?? "";
    const kind = operation.operation === "mutation" ? "Mutation" : "Query";
    const text = [operation, ...fragmentClosure(operation, fragments)].map((node) => print(node)).join("\n\n");
    return `export const ${name}Document: Operation<${name}${kind}, ${name}${kind}Variables> = {\n`
      + `  name: ${JSON.stringify(name)},\n  kind: ${JSON.stringify(operation.operation)},\n  text: ${JSON.stringify(text)},\n};`;
  });

  return `// @generated by apps/console/scripts/codegen.ts from services/gateway/schema/internal.graphql
// and apps/console/src/graphql/operations/*.graphql: do not edit.
// npm run codegen -w console regenerates it; --check compares.
/* eslint-disable */
import type { Operation } from "./operation.ts";

${types.replaceAll("\r\n", "\n").trim()}

${constants.join("\n\n")}
`;
}

async function main(): Promise<number> {
  const content = await generate();
  if (process.argv.includes("--check")) {
    const kept = existsSync(out) ? (await readFile(out, "utf8")).replaceAll("\r\n", "\n") : null;
    if (kept !== content) {
      say(`${relative(repoRoot, out)} differs from the operations and the schema; run npm run codegen -w console`);
      return 1;
    }
    const count = (content.match(/^export const \w+Document:/gm) ?? []).length;
    say(`the operations match the schema and the generated file (${count} operations)`);
    return 0;
  }
  await writeFile(out, content);
  say(`wrote ${relative(repoRoot, out)}`);
  return 0;
}

process.exitCode = await main();
