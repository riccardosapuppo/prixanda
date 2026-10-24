// The contract of the site's schema: it exposes nothing internal. Three
// checks that do not share their assumption, so that one blind spot is not
// confirmed by its echo:
//   1. the schema's whole surface equals the list written here, both ways;
//   2. no name in it belongs to the internal vocabulary;
//   3. an engine that plants marked values in every internal field of its
//      messages answers every public field, and none of the marks comes out.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  getNamedType, type GraphQLNamedType, type GraphQLSchema, isEnumType, isInputObjectType, isLeafType, isObjectType, isScalarType,
  isUnionType, specifiedScalarTypes,
} from "graphql";
import { buildPublicSchema } from "../src/core/schemas.ts";
import { SENTINEL } from "./support/fake-engine.ts";
import { codes, type Harness, SITE_ORIGIN, startHarness } from "./support/harness.ts";

/** Everything the site's API may show, and nothing else. */
const ALLOWED = [
  "scalar DateTime",
  "scalar LocalDateTime",
  "scalar MarketCode",
  "scalar Money",
  "scalar PlanCode",
  "enum AudioQuality: STANDARD, LOSSLESS",
  "enum QuoteRefusalCode: OFFER_ENDED, NOT_ELIGIBLE, NOT_AVAILABLE",
  "union QuoteResult = Quote | QuoteRefusal",
  "Query.markets: [Market!]!",
  "Query.plans(market: MarketCode!): [Plan!]!",
  "Query.prices(market: MarketCode!, plan: PlanCode): [ListPrice!]!",
  "Query.offers(market: MarketCode!): [Offer!]!",
  "Mutation.requestQuote(plan: PlanCode!, market: MarketCode!, offerId: ID): QuoteResult!",
  "Market.code: MarketCode!",
  "Market.name: String!",
  "Market.currency: String!",
  "Market.timeZone: String!",
  "Entitlements.skipsPerHour: Int",
  "Entitlements.audio: AudioQuality!",
  "Entitlements.offline: Boolean!",
  "Entitlements.seats: Int!",
  "Entitlements.needsStudentCheck: Boolean!",
  "Plan.code: PlanCode!",
  "Plan.name: String!",
  "Plan.paid: Boolean!",
  "Plan.entitlements: Entitlements!",
  "Plan.listPrice: Money",
  "ListPrice.plan: PlanCode!",
  "ListPrice.market: MarketCode!",
  "ListPrice.amount: Money!",
  "ListPrice.validFrom: LocalDateTime!",
  "ListPrice.validUntil: LocalDateTime",
  "MarketTime.local: LocalDateTime!",
  "MarketTime.utc: DateTime!",
  "Offer.id: ID!",
  "Offer.market: MarketCode!",
  "Offer.plan: PlanCode!",
  "Offer.title: String!",
  "Offer.text: String!",
  "Offer.terms: String!",
  "Offer.price: Money!",
  "Offer.listPrice: Money!",
  "Offer.monthsAtOfferPrice: Int!",
  "Offer.takeableUntil: MarketTime",
  "Offer.audience: String!",
  "Offer.needsStudentCheck: Boolean!",
  "Quote.id: ID!",
  "Quote.plan: PlanCode!",
  "Quote.market: MarketCode!",
  "Quote.price: Money!",
  "Quote.listPrice: Money!",
  "Quote.monthsAtPrice: Int!",
  "Quote.thenPrice: Money!",
  "Quote.expiresAt: DateTime!",
  "Quote.offerId: ID",
  "QuoteRefusal.code: QuoteRefusalCode!",
  "QuoteRefusal.reason: String!",
];

/** The internal vocabulary: economics, workflow, people and the log. None of it may name anything public. */
const INTERNAL_WORDS = /floor|artist|minimum|top.?up|breakdown|keeps|margin|payment|vat|net\b|approv|author|version|fingerprint|hash|sign|audit|eligib|simulat|person|people|role|session|csrf|change|draft|state|below|internal|cost|contribution|revenue|actor|request.?id|engine/i;

function surface(schema: GraphQLSchema): string[] {
  const lines: string[] = [];
  const types = Object.values(schema.getTypeMap()).filter((type) => !type.name.startsWith("__") && !specifiedScalarTypes.includes(type as never));
  for (const type of types) {
    if (isScalarType(type)) lines.push(`scalar ${type.name}`);
    else if (isEnumType(type)) lines.push(`enum ${type.name}: ${type.getValues().map((value) => value.name).join(", ")}`);
    else if (isUnionType(type)) lines.push(`union ${type.name} = ${type.getTypes().map((member) => member.name).join(" | ")}`);
    else if (isObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        const args = field.args.length ? `(${field.args.map((arg) => `${arg.name}: ${String(arg.type)}`).join(", ")})` : "";
        lines.push(`${type.name}.${field.name}${args}: ${String(field.type)}`);
      }
    } else if (isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) lines.push(`input ${type.name}.${field.name}: ${String(field.type)}`);
    } else lines.push(`unexpected ${type.name}`);
  }
  return lines;
}

/** Every name the schema shows: types, fields, arguments, enum values. */
function names(schema: GraphQLSchema): string[] {
  const found: string[] = [];
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith("__") || specifiedScalarTypes.includes(type as never)) continue;
    found.push(type.name);
    if (isEnumType(type)) found.push(...type.getValues().map((value) => value.name));
    if (isObjectType(type)) {
      for (const field of Object.values(type.getFields())) found.push(field.name, ...field.args.map((arg) => arg.name));
    }
    if (isInputObjectType(type)) found.push(...Object.keys(type.getFields()));
  }
  return found;
}

/** A selection of every field under a type, through every member of every union. */
function everything(type: GraphQLNamedType): string {
  if (isUnionType(type)) return `{ __typename ${type.getTypes().map((member) => `... on ${member.name} ${everything(member)}`).join(" ")} }`;
  if (!isObjectType(type)) return "";
  return `{ ${Object.values(type.getFields()).map((field) => {
    const inner = getNamedType(field.type);
    return isLeafType(inner) ? field.name : `${field.name} ${everything(inner)}`;
  }).join(" ")} }`;
}

describe("the site's schema, as written", () => {
  const schema = buildPublicSchema();

  test("exposes exactly the listed surface, no more and no less", () => {
    const actual = surface(schema);
    const extra = actual.filter((line) => !ALLOWED.includes(line));
    const missing = ALLOWED.filter((line) => !actual.includes(line));
    assert.deepEqual({ extra, missing }, { extra: [], missing: [] });
    assert.equal(actual.length, ALLOWED.length);
  });

  test("names nothing with a word of the internal vocabulary", () => {
    const all = names(schema);
    assert.ok(all.length > 60, `only ${all.length} names were read: the check would pass on nothing`);
    // The one exception, named: a visitor may be told they are not eligible for
    // an offer; how many people are eligible is the console's.
    const exceptions = ["NOT_ELIGIBLE"];
    assert.deepEqual(all.filter((name) => INTERNAL_WORDS.test(name) && !exceptions.includes(name)), []);
    assert.deepEqual(exceptions.filter((name) => !all.includes(name)), [], "an exception for a name the schema no longer has");
  });

  test("the vocabulary check finds the internal schema's names, so it is not blind", () => {
    // The same check, run on the console's names, must find plenty.
    const internalNames = ["floor", "artistsMinimum", "breakdown", "approveChange", "fingerprint", "auditEvents", "eligible", "session", "topUp"];
    assert.deepEqual(internalNames.filter((name) => !INTERNAL_WORDS.test(name)), []);
  });

  test("accepts no price anywhere: no argument or input field carries Money (§4.5)", () => {
    const priced: string[] = [];
    for (const type of Object.values(schema.getTypeMap())) {
      if (isObjectType(type)) {
        for (const field of Object.values(type.getFields())) {
          for (const arg of field.args) if (getNamedType(arg.type).name === "Money") priced.push(`${type.name}.${field.name}(${arg.name})`);
        }
      }
      if (isInputObjectType(type)) {
        for (const field of Object.values(type.getFields())) if (getNamedType(field.type).name === "Money") priced.push(`${type.name}.${field.name}`);
      }
    }
    assert.deepEqual(priced, []);
  });
});

describe("the site's API, answered by an engine that plants marked values in every internal field", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness({ engine: { sentinels: true } });
  });
  after(async () => {
    await harness.close();
  });

  test("every public field comes back, and not one marked value with it", async () => {
    const schema = buildPublicSchema();
    const query = schema.getQueryType();
    assert.ok(query);
    const fields = Object.values(query.getFields());
    const selection = fields.map((field) => {
      const args = field.args.map((arg) => `${arg.name}: ${arg.name === "market" ? '"IT"' : '"student"'}`).join(", ");
      return `${field.name}${args ? `(${args})` : ""} ${everything(getNamedType(field.type))}`;
    }).join(" ");
    const site = harness.site();
    const answers = [
      await site.graphql(`{ ${selection} }`),
      await site.graphql(`mutation { requestQuote(plan: "student", market: "IT", offerId: "9001") ${everything(schema.getType("QuoteResult") as GraphQLNamedType)} }`),
      await site.graphql(`mutation { requestQuote(plan: "family", market: "IT") ${everything(schema.getType("QuoteResult") as GraphQLNamedType)} }`),
      await site.graphql(`mutation { requestQuote(plan: "student", market: "IT", offerId: "424") ${everything(schema.getType("QuoteResult") as GraphQLNamedType)} }`),
    ];
    for (const answer of answers) assert.equal(answer.body.errors, undefined, answer.text);
    // The answers are full: the check below is not passing on empty data.
    const [catalog, quote, plain, ended] = answers.map((answer) => answer.body.data);
    assert.equal(catalog.markets.length, 4);
    assert.equal(catalog.plans.length, 5);
    assert.ok(catalog.prices.length >= 1);
    assert.deepEqual(catalog.offers[0].price, { amountMinor: "299", currency: "EUR" });
    assert.deepEqual(quote.requestQuote.price, { amountMinor: "299", currency: "EUR" });
    assert.equal(plain.requestQuote.__typename, "Quote");
    assert.deepEqual(ended.requestQuote, { __typename: "QuoteRefusal", code: "OFFER_ENDED", reason: "This offer is no longer on sale." });
    // The engine's messages carried the marks in floors, minimums, breakdowns,
    // price-list change ids, below-floor flags, top-ups and offer versions.
    const engineSent = JSON.stringify(harness.engine.calls.length);
    assert.ok(Number(engineSent) >= 4);
    for (const answer of answers) {
      for (const mark of [String(SENTINEL.amount), SENTINEL.changeId, "987654", "belowFloor", "breakdown", "floor"]) {
        assert.ok(!answer.text.includes(mark), `the public answer carries ${mark}: ${answer.text.slice(0, 400)}`);
      }
    }
  });

  test("the planted values are really in the engine's messages, so their absence above means something", async () => {
    const reader = harness.console();
    await reader.signIn("finance-1");
    const internal = await reader.graphql(`{ markets { floor } plans(market: "IT") { breakdown { companyKeeps } } priceList(market: "IT") { belowFloor topUp } }`);
    assert.ok(internal.text.includes(String(SENTINEL.amount)), internal.text.slice(0, 300));
  });

  test("a refusal the site was not written for reads the gateway's fixed sentence", async () => {
    // GetQuote for a plan the engine cannot quote: NOT_FOUND, an error and not a refusal.
    const site = harness.site();
    const answer = await site.graphql(`mutation { requestQuote(plan: "free", market: "IT") { __typename } }`);
    assert.deepEqual(codes(answer), ["NOT_FOUND"]);
    assert.equal(answer.body.errors[0].message, "Not found.", "the site does not get the engine's own sentence");
  });

  test("the site's CORS answers its own origin only, and never with credentials", async () => {
    const site = harness.site();
    const allowed = await site.raw({ method: "OPTIONS", headers: { origin: SITE_ORIGIN, "access-control-request-method": "POST" } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers["access-control-allow-origin"], SITE_ORIGIN);
    assert.equal(allowed.headers["access-control-allow-credentials"], undefined);
    const console = await site.raw({ method: "OPTIONS", headers: { origin: "http://console.test:4631", "access-control-request-method": "POST" } });
    assert.equal(console.status, 403);
    assert.equal(console.headers["access-control-allow-origin"], undefined);
  });
});

describe("introspection of the site's schema", () => {
  test("works in development", async () => {
    const harness = await startHarness();
    try {
      const answer = await harness.site().graphql("{ __schema { queryType { name } } }");
      assert.deepEqual(answer.body.data, { __schema: { queryType: { name: "Query" } } });
    } finally {
      await harness.close();
    }
  });

  test("is off in production, and errors do not suggest field names", async () => {
    const harness = await startHarness({ env: { GATEWAY_ENV: "production", GATEWAY_ENDPOINTS: "public" } });
    try {
      assert.equal(harness.gateway.internal, null, "production serves the site's API alone");
      const site = harness.site();
      const schemaQuery = await site.graphql("{ __schema { types { name } } }");
      assert.equal(schemaQuery.body.data, undefined);
      assert.deepEqual(codes(schemaQuery), ["GRAPHQL_VALIDATION_FAILED"]);
      const typeQuery = await site.graphql('{ __type(name: "Offer") { fields { name } } }');
      assert.deepEqual(codes(typeQuery), ["GRAPHQL_VALIDATION_FAILED"]);
      const typo = await site.graphql('{ offer(market: "IT") { id } }');
      assert.deepEqual(codes(typo), ["GRAPHQL_VALIDATION_FAILED"]);
      assert.doesNotMatch(typo.text, /Did you mean/);
      const fine = await site.graphql('{ offers(market: "IT") { id } }');
      assert.deepEqual(fine.body.data, { offers: [{ id: "9001" }] });
    } finally {
      await harness.close();
    }
  });
});
