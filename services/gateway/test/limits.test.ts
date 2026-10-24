// The limits on what one request may ask: depth, cost, size of the document,
// requests per address and per session, and the shape of the HTTP request.
// Each limit has a test that makes it fire, and one that shows a legitimate
// request passing it.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { buildSchema, parse, specifiedRules, validate } from "graphql";
import { deepestPath, depthAndCostRule, INTERNAL_LIMITS, measure, PUBLIC_LIMITS } from "../src/core/limits.ts";
import { buildInternalSchema, buildPublicSchema } from "../src/core/schemas.ts";
import { codes, type Harness, startHarness } from "./support/harness.ts";

const CONSOLE_LIST = `query ($n: Int!) { changes(first: $n) { nodes { id kind title state currentVersion markets updatedAt createdBy { id label }
  requiredSignatures { role signed why } details { sentence validation { valid eligible findings { check severity market message } }
  current { version fingerprint author { id label } content { __typename ... on OfferContent { title plan prices { market fixed percentOffBasisPoints }
  periods { market startsLocal endsLocal } pages { market title } } ... on ListPriceContent { plan market amount startsLocal } } }
  approvals { approver { id } role decidedAt } } } next } }`;

const ALIASED_PAGES = `query ($n: Int!) { ${Array.from({ length: 12 }, (_, index) =>
  `a${index}: changes(first: $n) { nodes { id details { title current { content { __typename ... on OfferContent { pages { title text terms } } } } } } }`).join(" ")} }`;

const SITE_ALIASES = (count: number) => `{ ${Array.from({ length: count }, (_, index) => `a${index}: offers(market: "IT") { id title price listPrice }`).join(" ")} }`;

function cost(schema: ReturnType<typeof buildInternalSchema>, query: string, limits = INTERNAL_LIMITS) {
  const document = parse(query);
  const operation = document.definitions.find((definition) => definition.kind === "OperationDefinition");
  assert.ok(operation && operation.kind === "OperationDefinition");
  const fragments = new Map(document.definitions.flatMap((definition) => definition.kind === "FragmentDefinition" ? [[definition.name.value, definition] as const] : []));
  return measure({ getFragment: (name) => fragments.get(name), getSchema: () => schema }, operation.selectionSet, schema.getRootType(operation.operation) ?? undefined, limits);
}

describe("depth", () => {
  test("each schema's deepest path fits its limit, so the limit never refuses a query the schema allows today", () => {
    assert.equal(deepestPath(buildInternalSchema()), INTERNAL_LIMITS.maxDepth);
    assert.equal(deepestPath(buildPublicSchema()), PUBLIC_LIMITS.maxDepth);
  });

  test("a schema whose types loop has no deepest path, and the rule stops the runaway query", () => {
    const looping = buildSchema("type Query { node: Node } type Node { id: ID child: Node }");
    assert.equal(deepestPath(looping), Number.POSITIVE_INFINITY);
    const deep = `{ node { ${"child { ".repeat(9)}id${" }".repeat(9)} } }`;
    const errors = validate(looping, parse(deep), [...specifiedRules, depthAndCostRule(INTERNAL_LIMITS)]);
    assert.deepEqual(errors.map((error) => error.message), ["This operation is 11 fields deep; the limit is 8."]);
    const shallow = `{ node { child { child { id } } } }`;
    assert.deepEqual(validate(looping, parse(shallow), [...specifiedRules, depthAndCostRule(INTERNAL_LIMITS)]), []);
  });
});

describe("cost", () => {
  test("counts a page as long as its first argument, and a variable as the largest page", () => {
    const schema = buildInternalSchema();
    const twenty = cost(schema, CONSOLE_LIST.replace("first: $n", "first: 20"));
    const variable = cost(schema, CONSOLE_LIST);
    assert.ok(variable.cost > 4 * twenty.cost, `${variable.cost} vs ${twenty.cost}`);
    assert.ok(variable.cost <= INTERNAL_LIMITS.maxCost, `the console's largest page costs ${variable.cost}`);
  });

  test("counts aliases one by one", () => {
    const schema = buildPublicSchema();
    assert.equal(cost(schema, SITE_ALIASES(20), PUBLIC_LIMITS).cost, 20 * cost(schema, SITE_ALIASES(1), PUBLIC_LIMITS).cost);
  });
});

describe("limits through HTTP", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness({ engine: { offers: 5 } });
  });
  after(async () => {
    await harness.close();
  });

  test("the console's largest page with its details passes", async () => {
    const client = harness.console();
    await client.signIn("auditor-1");
    const answer = await client.graphql(CONSOLE_LIST, { variables: { n: 100 } });
    assert.equal(answer.body.errors, undefined, answer.text);
    assert.equal(answer.body.data.changes.nodes.length, 5);
  });

  test("the same pages asked twelve times through aliases are refused before the engine", async () => {
    const client = harness.console();
    await client.signIn("auditor-1");
    harness.engine.clearCalls();
    const answer = await client.graphql(ALIASED_PAGES, { variables: { n: 100 } });
    assert.equal(answer.status, 400);
    assert.deepEqual(codes(answer), ["GRAPHQL_VALIDATION_FAILED"]);
    assert.match(answer.body.errors[0].message, /would cost about \d+ .* the limit is 25000/);
    assert.equal(harness.engine.count(), 0);
  });

  test("the site's whole catalog passes, and its offers asked twenty times do not", async () => {
    const site = harness.site();
    const catalog = await site.graphql(`{ markets { code name currency timeZone } plans(market: "IT") { code name paid listPrice entitlements { skipsPerHour audio offline seats needsStudentCheck } }
      prices(market: "IT") { plan market amount validFrom validUntil } offers(market: "IT") { id market plan title text terms price listPrice monthsAtOfferPrice takeableUntil { local utc } audience needsStudentCheck } }`);
    assert.equal(catalog.body.errors, undefined, catalog.text);
    harness.engine.clearCalls();
    const greedy = await site.graphql(SITE_ALIASES(20));
    assert.deepEqual(codes(greedy), ["GRAPHQL_VALIDATION_FAILED"]);
    assert.equal(harness.engine.count(), 0);
  });

  test("a document of too many tokens is refused while it is parsed", async () => {
    const site = harness.site();
    const document = (fields: number) => `{ ${Array.from({ length: fields }, () => "__typename").join(" ")} }`;
    const under = await site.graphql(document(1_400));
    assert.equal(under.body.errors, undefined, "1,402 tokens are under the site's limit");
    const over = await site.graphql(document(1_600));
    assert.deepEqual(codes(over), ["GRAPHQL_PARSE_FAILED"]);
    // graphql's own sentence: "Document contains more that 1500 tokens".
    assert.match(over.body.errors[0].message, /contains more th\w+ 1500 tokens/);
  });

  test("a body over 64 KiB is 413, a body that is not JSON 415, a batch of operations 400", async () => {
    const client = harness.console();
    const large = await client.raw({ headers: { "content-type": "application/json" }, body: JSON.stringify({ query: `{ people { id } } # ${"x".repeat(70_000)}` }) });
    assert.equal(large.status, 413);
    const text = await client.raw({ headers: { "content-type": "text/plain" }, body: "{ people { id } }" });
    assert.equal(text.status, 415);
    const form = await client.raw({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: "query=%7B%7D" });
    assert.equal(form.status, 415, "a form, which a page of another site could post, is refused");
    const batch = await client.raw({ headers: { "content-type": "application/json" }, body: JSON.stringify([{ query: "{ people { id } }" }, { query: "{ people { id } }" }]) });
    assert.equal(batch.status, 400);
  });

  test("persisted queries are off, and a browser opening the API gets no landing page", async () => {
    const client = harness.site();
    const persisted = await client.raw({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extensions: { persistedQuery: { version: 1, sha256Hash: "a".repeat(64) } } }),
    });
    assert.deepEqual(codes(persisted), ["PERSISTED_QUERY_NOT_SUPPORTED"]);
    const page = await client.raw({ method: "GET", headers: { accept: "text/html" } });
    assert.equal(page.status, 400);
    assert.match(String(page.headers["content-type"]), /application\/json/);
    assert.doesNotMatch(page.text, /<script|<html/i);
  });

  test("GET runs queries only, and only with a header a simple cross-site request cannot carry", async () => {
    const client = harness.console();
    const query = encodeURIComponent("{ people { id } }");
    const bare = await client.raw({ method: "GET", path: `?query=${query}` });
    assert.equal(bare.status, 400, "Apollo's CSRF prevention wants a preflight header on a GET");
    const preflighted = await client.raw({ method: "GET", path: `?query=${query}`, headers: { "apollo-require-preflight": "true" } });
    assert.equal(preflighted.status, 200, preflighted.text);
    const mutation = await client.raw({ method: "GET", path: `?query=${encodeURIComponent("mutation { signOut }")}`, headers: { "apollo-require-preflight": "true" } });
    assert.equal(mutation.status, 405);
  });
});

describe("rate limits", () => {
  test("per address: the sixth request in a minute is 429 with Retry-After, and a token comes back after 12 s", async () => {
    const harness = await startHarness({ env: { GATEWAY_RATE_PER_ADDRESS: "5/60" } });
    try {
      const client = harness.site();
      const answers = [];
      for (let index = 0; index < 6; index += 1) answers.push(await client.graphql("{ markets { code } }"));
      assert.deepEqual(answers.map((answer) => answer.status), [200, 200, 200, 200, 200, 429]);
      const refused = answers[5];
      assert.equal(refused?.headers["retry-after"], "12");
      assert.deepEqual(refused && codes(refused), ["RATE_LIMITED"]);
      harness.clock.advance(11_000);
      assert.equal((await client.graphql("{ markets { code } }")).status, 429);
      harness.clock.advance(1_000);
      assert.equal((await client.graphql("{ markets { code } }")).status, 200);
    } finally {
      await harness.close();
    }
  });

  test("per session: a busy session is held back while other visitors are not", async () => {
    const harness = await startHarness({ env: { GATEWAY_RATE_PER_SESSION: "3/60" } });
    try {
      const busy = harness.console();
      await busy.signIn("auditor-1");
      const statuses = [];
      for (let index = 0; index < 4; index += 1) statuses.push((await busy.graphql("{ people { id } }")).status);
      assert.deepEqual(statuses, [200, 200, 200, 429]);
      const other = harness.console();
      assert.equal((await other.graphql("{ people { id } }")).status, 200);
      await other.signIn("finance-1");
      assert.equal((await other.graphql("{ people { id } }")).status, 200);
    } finally {
      await harness.close();
    }
  });
});
