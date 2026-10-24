// npm run graphql -w site: the types of the site's GraphQL operations,
// generated from the gateway's public schema (services/gateway/schema/
// public.graphql) and the operations written in src/graphql/*.graphql, with
// GraphQL Code Generator.
//
// Every operation is validated against the schema first, so an operation the
// gateway would refuse never reaches a build. The output, src/graphql/
// generated.ts, holds each operation's result and variables types and its
// text, typed together: the data layer sends exactly that text, and a page
// can only read what the operation asked for. It is committed; with --check
// it is generated in memory and compared, and a schema or an operation
// changed without regenerating fails the check.
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { codegen } from "@graphql-codegen/core";
import * as operationsPlugin from "@graphql-codegen/typescript-operations";
import {
  buildSchema, type DocumentNode, type FragmentDefinitionNode, Kind, type OperationDefinitionNode, parse, print, printSchema, validate, visit,
} from "graphql";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(site, "..", "..");
const schemaFile = join(repoRoot, "services", "gateway", "schema", "public.graphql");
const operationsDir = join(site, "src", "graphql");
const out = join(operationsDir, "generated.ts");
const say = (line: string) => console.log(`[site graphql] ${line}`);
const posix = (path: string) => relative(repoRoot, path).replaceAll("\\", "/");

// The schema's own scalars, as the site holds them: money is never a float
// (§3.4), times stay the strings the gateway wrote.
const SCALARS: Record<string, string> = {
  Money: "{ readonly amountMinor: string; readonly currency: string }",
  LocalDateTime: "string",
  DateTime: "string",
  Date: "string",
  MarketCode: "string",
  PlanCode: "string",
  ID: "string",
};

type Operation = { node: OperationDefinitionNode; file: string };

async function generate(): Promise<string> {
  const sdl = (await readFile(schemaFile, "utf8")).replaceAll("\r\n", "\n");
  const schema = buildSchema(sdl);
  const files = (await readdir(operationsDir)).filter((name) => name.endsWith(".graphql")).sort();
  if (files.length === 0) throw new Error("src/graphql holds no .graphql file");

  const operations: Operation[] = [];
  const fragments = new Map<string, FragmentDefinitionNode>();
  const documents: { location: string; document: DocumentNode }[] = [];
  for (const name of files) {
    const path = join(operationsDir, name);
    const document = parse((await readFile(path, "utf8")).replaceAll("\r\n", "\n"));
    documents.push({ location: posix(path), document });
    for (const definition of document.definitions) {
      if (definition.kind === Kind.OPERATION_DEFINITION) {
        const operationName = definition.name?.value;
        if (!operationName) throw new Error(`${name}: every operation has a name, which the gateway's log and the request carry`);
        if (operations.some((known) => known.node.name?.value === operationName)) throw new Error(`${name}: a second operation called ${operationName}`);
        if (definition.operation === "subscription") throw new Error(`${name}: ${operationName} is a subscription; the public schema has none`);
        operations.push({ node: definition, file: name });
      } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        if (fragments.has(definition.name.value)) throw new Error(`${name}: a second fragment called ${definition.name.value}`);
        fragments.set(definition.name.value, definition);
      }
    }
  }
  if (operations.length === 0) throw new Error("src/graphql holds no operation");

  // The gateway would refuse an operation that does not validate: so does the build.
  const all: DocumentNode = { kind: Kind.DOCUMENT, definitions: documents.flatMap(({ document }) => document.definitions) };
  const errors = validate(schema, all);
  if (errors.length) {
    throw new Error(`the operations do not validate against public.graphql:\n${errors.map((error) => `  ${error.message}`).join("\n")}`);
  }

  const types = await codegen({
    filename: "generated.ts",
    schema: parse(printSchema(schema)),
    schemaAst: schema,
    documents,
    plugins: [{ "typescript-operations": {} }],
    pluginMap: { "typescript-operations": operationsPlugin },
    config: {
      enumType: "string-literal",
      scalars: SCALARS,
      strictScalars: true,
      useTypeImports: true,
      immutableTypes: true,
      // A field the operation asked for is always there, null when the schema says it may be.
      avoidOptionals: true,
      skipTypename: false,
    },
  });

  const texts = operations.map(({ node }) => {
    const name = node.name?.value ?? "";
    const kind = node.operation === "mutation" ? "Mutation" : "Query";
    const text = [node, ...usedFragments(node, fragments)].map((definition) => print(definition)).join("\n\n");
    return `export const ${name}: SiteOperation<${name}${kind}, ${name}${kind}Variables, "${node.operation}"> = {\n`
      + `  kind: "${node.operation}",\n  name: "${name}",\n  text: ${JSON.stringify(text)},\n};`;
  });

  return [
    "// @generated by apps/site/scripts/graphql.ts from services/gateway/schema/public.graphql",
    "// and apps/site/src/graphql/*.graphql: do not edit. npm run graphql -w site regenerates it.",
    "",
    types.replaceAll("\r\n", "\n").trim(),
    "",
    "/** An operation of the site: the text the transport sends, typed with its result and variables. */",
    "export type SiteOperation<Result, Variables, Kind extends \"query\" | \"mutation\"> = {",
    "  readonly kind: Kind;",
    "  readonly name: string;",
    "  readonly text: string;",
    "  /** Never set: it carries the types. */",
    "  readonly result?: Result;",
    "  readonly variables?: Variables;",
    "};",
    "",
    texts.join("\n\n"),
    "",
  ].join("\n");
}

/** The fragments an operation spreads, directly or through other fragments. */
function usedFragments(node: OperationDefinitionNode, fragments: Map<string, FragmentDefinitionNode>): FragmentDefinitionNode[] {
  const seen = new Map<string, FragmentDefinitionNode>();
  const walk = (root: OperationDefinitionNode | FragmentDefinitionNode) => {
    visit(root, {
      FragmentSpread(spread) {
        const name = spread.name.value;
        const fragment = fragments.get(name);
        if (!fragment) throw new Error(`the fragment ${name} is not defined`);
        if (!seen.has(name)) {
          seen.set(name, fragment);
          walk(fragment);
        }
      },
    });
  };
  walk(node);
  return [...seen.values()];
}

const content = await generate();
if (process.argv.includes("--check")) {
  const kept = existsSync(out) ? (await readFile(out, "utf8")).replaceAll("\r\n", "\n") : null;
  if (kept !== content) {
    say(`${posix(out)} differs from the schema and the operations: npm run graphql -w site`);
    process.exitCode = 1;
  } else {
    const count = [...content.matchAll(/^export const \w+: SiteOperation</gm)].length;
    say(`generated types match the schema (${count} operations)`);
  }
} else {
  await writeFile(out, content);
  say(`generated ${posix(out)}`);
}
