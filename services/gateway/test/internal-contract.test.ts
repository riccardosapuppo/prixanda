// The contract of the console's schema: its operations as the console will
// call them, typed refusals on every mutation that reaches the engine, enums
// that match the engine's value for value, and a build that refuses a schema
// and resolvers that do not match, or an operation without an access rule.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ChangeKindSchema, ChangeStateSchema, SegmentSchema, SeveritySchema } from "contracts/commerce/v1/changes";
import { RefusalCodeSchema, RoleSchema } from "contracts/commerce/v1/common";
import { buildSchema, getNamedType, isEnumType, isUnionType } from "graphql";
import { bindResolvers } from "../src/core/bind.ts";
import { internalSdl } from "../src/core/generated/sdl.ts";
import { internalResolvers } from "../src/core/internal/resolvers.ts";
import { guardInternalSchema } from "../src/core/policy.ts";
import { buildInternalSchema } from "../src/core/schemas.ts";

/** The console's operations, with their arguments: changing one is changing the console's contract. */
const OPERATIONS = [
  "Query.people: [Person!]!",
  "Query.session: Session",
  "Query.overview(at: DateTime): Overview!",
  "Query.markets: [Market!]!",
  "Query.plans(market: MarketCode!, at: DateTime): [Plan!]!",
  "Query.priceList(market: MarketCode, plan: PlanCode): [PriceListEntry!]!",
  "Query.change(id: ID!): Change",
  "Query.changes(filter: ChangeFilter, first: Int!, after: String): ChangePage!",
  "Query.simulateOffer(changeId: ID!, version: Int!, market: MarketCode!, overrides: [AssumptionInput!]): SimulationOutcome!",
  "Query.auditEvents(filter: AuditFilter, first: Int!, after: String): AuditPage!",
  "Query.verifyAuditChain(anchor: ChainHeadInput): ChainVerification!",
  "Mutation.signIn(personId: ID!): Session!",
  "Mutation.signOut: Boolean!",
  "Mutation.createOffer(offer: OfferInput!): ChangeResult!",
  "Mutation.createListPrice(listPrice: ListPriceInput!): ChangeResult!",
  "Mutation.saveOfferVersion(changeId: ID!, baseVersion: Int!, offer: OfferInput!): ChangeResult!",
  "Mutation.saveListPriceVersion(changeId: ID!, baseVersion: Int!, listPrice: ListPriceInput!): ChangeResult!",
  "Mutation.validateChange(changeId: ID!, version: Int!): ChangeResult!",
  "Mutation.submitChange(changeId: ID!, version: Int!, authorReason: String): ChangeResult!",
  "Mutation.approveChange(changeId: ID!, version: Int!, fingerprint: Sha256!): ChangeResult!",
  "Mutation.rejectChange(changeId: ID!, version: Int!, reason: String!): ChangeResult!",
  "Mutation.scheduleChange(changeId: ID!): ChangeResult!",
  "Mutation.cancelChange(changeId: ID!, reason: String!): ChangeResult!",
  "Mutation.suspendChange(changeId: ID!, reason: String!): ChangeResult!",
  "Mutation.exportAuditHead: ExportHeadResult!",
];

describe("the console's schema", () => {
  const schema = buildInternalSchema();

  test("offers exactly the console's operations", () => {
    const actual = [schema.getQueryType(), schema.getMutationType()].flatMap((root) =>
      Object.values(root?.getFields() ?? {}).map((field) => {
        const args = field.args.length ? `(${field.args.map((arg) => `${arg.name}: ${String(arg.type)}`).join(", ")})` : "";
        return `${root?.name}.${field.name}${args}: ${String(field.type)}`;
      }));
    assert.deepEqual(actual, OPERATIONS);
  });

  test("answers every mutation that reaches the engine with a union that holds a typed Refusal", () => {
    const mutations = Object.values(schema.getMutationType()?.getFields() ?? {}).filter((field) => !["signIn", "signOut"].includes(field.name));
    // Create (2), save (2), validate, submit, approve, reject, schedule, cancel, suspend, export.
    assert.equal(mutations.length, 12);
    for (const field of mutations) {
      const result = getNamedType(field.type);
      assert.ok(isUnionType(result) && result.getTypes().some((member) => member.name === "Refusal"), field.name);
    }
  });

  test("has the engine's enums, value for value", () => {
    const pairs = [
      ["Role", RoleSchema], ["ChangeKind", ChangeKindSchema], ["ChangeState", ChangeStateSchema], ["Segment", SegmentSchema],
      ["Severity", SeveritySchema], ["RefusalCode", RefusalCodeSchema],
    ] as const;
    for (const [name, desc] of pairs) {
      const type = schema.getType(name);
      assert.ok(isEnumType(type), name);
      const engine = desc.values.filter((value) => value.number !== 0).map((value) => value.localName);
      assert.ok(engine.length >= 3, `${name}: the engine's values were read`);
      assert.deepEqual(type.getValues().map((value) => value.name), engine, name);
    }
    const actorRole = schema.getType("ActorRole");
    assert.ok(isEnumType(actorRole));
    assert.deepEqual(actorRole.getValues().map((value) => value.name), [...RoleSchema.values.filter((value) => value.number !== 0).map((value) => value.localName), "SYSTEM"]);
  });
});

describe("building a schema", () => {
  test("refuses a resolver for a field the schema does not have", () => {
    const resolvers = { ...internalResolvers, Market: { ...internalResolvers.Market, flor: () => null } };
    assert.throws(() => bindResolvers(buildSchema(internalSdl), resolvers, "test"), /Market\.flor is not a field/);
  });

  test("refuses a field left without its resolver", () => {
    const { floor: _floor, ...market } = internalResolvers.Market;
    assert.throws(() => bindResolvers(buildSchema(internalSdl), { ...internalResolvers, Market: market }, "test"), /Market\.floor has no resolver/);
  });

  test("refuses a union without __resolveType and a scalar without its implementation", () => {
    const { ChangeResult: _union, Sha256: _scalar, ...rest } = internalResolvers;
    assert.throws(() => bindResolvers(buildSchema(internalSdl), rest, "test"), (error: Error) =>
      /union ChangeResult has no __resolveType/.test(error.message) && /scalar Sha256 has no implementation/.test(error.message));
  });

  test("refuses an operation without an access rule, and a rule without its operation", () => {
    const extended = buildSchema(`${internalSdl}\nextend type Query { secret: Int }`);
    const bound = bindResolvers(extended, { ...internalResolvers, Query: { ...internalResolvers.Query, secret: () => 42 } }, "test");
    assert.throws(() => guardInternalSchema(bound), /no access rule for Query\.secret/);
    const trimmed = buildSchema(internalSdl.replace(/\n {2}"The head of the log's chain[^\n]*\n {2}exportAuditHead: ExportHeadResult!/, ""));
    assert.equal(trimmed.getMutationType()?.getFields()["exportAuditHead"], undefined, "the field was taken out of the SDL");
    const { exportAuditHead: _gone, ...mutations } = internalResolvers.Mutation;
    const rebound = bindResolvers(trimmed, { ...internalResolvers, Mutation: mutations }, "test");
    assert.throws(() => guardInternalSchema(rebound), /access rules for fields that do not exist: Mutation\.exportAuditHead/);
  });
});
