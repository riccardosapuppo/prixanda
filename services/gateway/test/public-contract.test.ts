// The contract of the site's schema: it exposes nothing internal. Three
// checks that do not share their assumption, so that one blind spot is not
// confirmed by its echo:
//   1. the schema's whole surface equals the list written here, both ways;
//   2. no name in it belongs to the internal vocabulary;
//   3. an engine that plants marked values in every internal field of its
//      messages answers every public field, and none of the marks comes out.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { PublishedOfferSchema } from "contracts/commerce/v1/catalog";
import { ChangeState } from "contracts/commerce/v1/changes";
import {
  getNamedType, type GraphQLNamedType, type GraphQLSchema, isEnumType, isInputObjectType, isLeafType, isObjectType, isScalarType,
  isUnionType, specifiedScalarTypes,
} from "graphql";
import { buildPublicSchema } from "../src/core/schemas.ts";
import { connectEngine } from "../src/node/grpc.ts";
import { LISTENERS, SENTINEL } from "./support/fake-engine.ts";
import { type Client, codes, type Harness, internalIn, SITE_ORIGIN, startHarness } from "./support/harness.ts";
import { unionConflicts } from "./support/unions.ts";

/** Everything the site's API may show, and nothing else. */
const ALLOWED = [
  "scalar Date",
  "scalar DateTime",
  "scalar LocalDateTime",
  "scalar MarketCode",
  "scalar Money",
  "scalar PlanCode",
  "enum AudioQuality: STANDARD, LOSSLESS",
  "enum RefusalCode: OFFER_ENDED, QUOTE_EXPIRED, NOT_ELIGIBLE, ALREADY_SUBSCRIBED, NOT_COMBINABLE, CAP_REACHED, PAYMENT_DECLINED, ANSWER_CLOSED, CODE_NOT_USABLE, NOT_AVAILABLE",
  "enum PaymentState: PENDING, SUCCEEDED, FAILED",
  "union QuoteResult = Quote | Refusal",
  "union VerificationResult = StudentVerification | Refusal",
  "union SubscriptionResult = Confirmation | Refusal",
  // Stage 7, §8 and §14.3: a price change of the listener's own subscription,
  // and their answer to it. Its dates are worked out on their billing days,
  // so that the site writes them and computes nothing.
  "enum PriceChangeKind: CONSENT, NOTICE",
  "enum PriceChangeState: WAITING, ACCEPTED, DECLINED, LAPSED, NEW_PRICE",
  "union PriceChangeResult = PriceChange | Refusal",
  "Mutation.answerPriceChange(priceChangeId: ID!, accept: Boolean!): PriceChangeResult!",
  "Account.priceChanges: [PriceChange!]!",
  "PriceChange.id: ID!",
  "PriceChange.plan: PlanCode!",
  "PriceChange.oldPrice: Money!",
  "PriceChange.newPrice: Money!",
  "PriceChange.kind: PriceChangeKind!",
  "PriceChange.sentAt: DateTime!",
  "PriceChange.windowEnds: MarketTime!",
  "PriceChange.newSubscribersFrom: MarketTime!",
  "PriceChange.state: PriceChangeState!",
  "PriceChange.newPriceFrom: Date",
  "PriceChange.appliesFrom: Date",
  "PriceChange.ifNoLeavesOn: Date",
  "PriceChange.leavesOn: Date",
  // The market's choice and its law, each in its own field (§8.1): the words
  // the engine writes for the listener, as an offer's terms are.
  "PriceChange.ifNoAnswer: String!",
  "PriceChange.legalBasis: String!",
  // The day the paid subscription ends if the listener does nothing more (§8).
  "Subscription.endsOn: Date",
  // Stage 7, §9 and §14.4: the prepaid passes on sale, a demonstration
  // purchase of one with its code, the code's activation, and the codes the
  // listener bought. Who activated a code is not shown: a code can be a gift.
  "enum PrepaidCodeState: PENDING, READY, ACTIVATED, EXPIRED, FAILED",
  "union PrepaidPurchaseResult = PrepaidPurchase | Refusal",
  "union PrepaidActivationResult = Subscription | Refusal",
  "Query.prepaidPasses(market: MarketCode!): [PrepaidPass!]!",
  "Mutation.buyPrepaidPass(passId: ID!): PrepaidPurchaseResult!",
  "Mutation.activatePrepaidPass(code: String!): PrepaidActivationResult!",
  "Account.prepaidCodes: [PrepaidCode!]!",
  "PrepaidPass.id: ID!",
  "PrepaidPass.market: MarketCode!",
  "PrepaidPass.title: String!",
  "PrepaidPass.plan: PlanCode!",
  "PrepaidPass.months: Int!",
  "PrepaidPass.price: Money!",
  "PrepaidPass.codeValidMonths: Int!",
  "PrepaidPass.text: String!",
  "PrepaidPass.terms: String!",
  "PrepaidPurchase.prepaidCode: PrepaidCode!",
  "PrepaidCode.code: String!",
  "PrepaidCode.passId: ID!",
  "PrepaidCode.title: String!",
  "PrepaidCode.plan: PlanCode!",
  "PrepaidCode.market: MarketCode!",
  "PrepaidCode.months: Int!",
  "PrepaidCode.price: Money!",
  "PrepaidCode.boughtAt: DateTime!",
  "PrepaidCode.validUntil: Date!",
  "PrepaidCode.state: PrepaidCodeState!",
  "PrepaidCode.payment: Payment!",
  "PrepaidCode.activatedOn: Date",
  "Subscription.prepaidCode: String",
  "Subscription.prepaidPrice: Money",
  "Query.markets: [Market!]!",
  "Query.plans(market: MarketCode!): [Plan!]!",
  "Query.prices(market: MarketCode!, plan: PlanCode): [ListPrice!]!",
  "Query.offers(market: MarketCode!): [Offer!]!",
  "Query.demoListeners: [DemoListener!]!",
  "Query.me: Me",
  "Mutation.requestQuote(plan: PlanCode!, market: MarketCode!, offerId: ID): QuoteResult!",
  "Mutation.signInAsListener(listenerId: ID!): Me!",
  "Mutation.signOutListener: Boolean!",
  "Mutation.verifyStudent: VerificationResult!",
  "Mutation.confirmSubscription(quoteId: ID!): SubscriptionResult!",
  "Market.code: MarketCode!",
  "Market.name: String!",
  "Market.currency: String!",
  "Market.timeZone: String!",
  // Public by the coordinator's decision of 24 October: where a price goes is
  // the promise of §1.2 and §5, which the site shows its visitors. The floor,
  // the thresholds and the simulations stay the console's.
  // The VAT rate the prices include (§3.1), which the breakdown's VAT follows from.
  "Market.vatBasisPoints: Int!",
  // The guaranteed minimum every paying subscription brings the artists (§1.2, §5.3).
  "Market.artistsMinimum: Money!",
  // Where a price goes, per subscription per month (§3.5, §5): each part, the top-up and what the service keeps included.
  "PriceBreakdown.price: Money!",
  "PriceBreakdown.vat: Money!",
  "PriceBreakdown.net: Money!",
  "PriceBreakdown.artists: Money!",
  "PriceBreakdown.topUp: Money!",
  "PriceBreakdown.paymentCosts: Money!",
  "PriceBreakdown.companyKeeps: Money!",
  // Of a plan's list price, as ListPlans gives it.
  "Plan.breakdown: PriceBreakdown",
  // Of an offer's price (PublishedOffer.breakdown, stage 6; null from the engine of stage 5).
  "Offer.breakdown: PriceBreakdown",
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
  // Stage 5, the subscriber's side: the demo's listeners, the site's session, the account.
  "DemoListener.id: ID!",
  "DemoListener.market: MarketCode!",
  "DemoListener.title: String!",
  "DemoListener.label: String!",
  "DemoListener.plan: PlanCode",
  "DemoListener.studentVerified: Boolean!",
  "Me.id: ID!",
  "Me.market: MarketCode!",
  "Me.title: String!",
  "Me.csrfToken: String!",
  "Me.expiresAt: DateTime!",
  "Me.account: Account!",
  "Account.market: MarketCode!",
  "Account.subscription: Subscription!",
  "Account.payment: Payment",
  "Account.studentVerification: StudentVerification",
  "Subscription.plan: PlanCode!",
  "Subscription.market: MarketCode!",
  "Subscription.paid: Boolean!",
  "Subscription.price: Money!",
  "Subscription.startedOn: Date!",
  "Subscription.billingDay: Int",
  "Subscription.offerTitle: String",
  "Subscription.offerMonths: Int!",
  "Subscription.offerMonthsLeft: Int!",
  "Subscription.fullPriceFrom: Date",
  "Subscription.fullPrice: Money",
  "Subscription.nextBillingOn: Date",
  "Subscription.nextCharge: Money",
  "StudentVerification.verifiedOn: Date!",
  "StudentVerification.validUntil: Date!",
  "StudentVerification.provider: String!",
  "StudentVerification.valid: Boolean!",
  "Payment.state: PaymentState!",
  "Payment.amount: Money!",
  "Payment.provider: String!",
  "Payment.requestedAt: DateTime!",
  "Payment.settledAt: DateTime",
  "Payment.receipt: Receipt",
  "Receipt.id: ID!",
  "Receipt.amount: Money!",
  "Receipt.issuedAt: DateTime!",
  "Receipt.provider: String!",
  "Receipt.providerReference: String!",
  "Receipt.demonstration: Boolean!",
  "Receipt.note: String!",
  "Confirmation.subscription: Subscription!",
  "Confirmation.payment: Payment!",
  "Refusal.code: RefusalCode!",
  "Refusal.reason: String!",
];

/**
 * Names of the internal vocabulary that the site shows by the coordinator's
 * decision of 24 October, each with its reason: where a price goes is the
 * promise of §1.2 and §5. The floor, the thresholds and the simulations are
 * not among them.
 */
const PUBLIC_BY_DECISION: Record<string, string> = {
  "Market.vatBasisPoints": "the VAT rate the prices include (§3.1)",
  "Market.artistsMinimum": "the minimum every paying subscription brings the artists, whatever the discount (§1.2, §5.3)",
  PriceBreakdown: "where a price goes, per subscription per month (§3.5, §5)",
  "Plan.breakdown": "where a plan's list price goes",
  "Offer.breakdown": "where an offer's price goes, in each of its months",
  "PriceBreakdown.vat": "the VAT in the price (§3.5)",
  "PriceBreakdown.net": "the price without VAT, which the artists' share is counted on (§5.1)",
  "PriceBreakdown.artists": "what the artists' pool receives (§5.2, §5.3)",
  "PriceBreakdown.topUp": "what the music service adds to reach the artists' minimum (§5.3)",
  "PriceBreakdown.paymentCosts": "what collecting the money costs (§5.6)",
  "PriceBreakdown.companyKeeps": "what the music service keeps, below zero when an offer costs it (§5.7)",
};

/**
 * The internal vocabulary: economics, workflow, people and the log. None of it
 * may name anything public, but for the names above. A listener's own payment
 * is theirs; what the payment provider costs the company is in the vocabulary.
 */
const INTERNAL_WORDS = /floor|artist|minimum|top.?up|breakdown|keeps|margin|payment.?cost|vat|net\b|approv|author|version|fingerprint|hash|sign|audit|eligib|simulat|person|people|role|session|csrf|change|draft|state|below|internal|cost|contribution|revenue|actor|request.?id|engine|migration|polic/i;

/**
 * A price change the listener is asked or told about is theirs (§8); a
 * change of the workflow, and the migration that makes it, are the console's.
 * These names say "change" or "state" of the listener's own, each where it stands.
 */
const PRICE_CHANGE_NAMES = [
  "Mutation.answerPriceChange", "Mutation.answerPriceChange(priceChangeId)", "Account.priceChanges", "PriceChange", "PriceChangeKind",
  "PriceChangeState", "PriceChange.state", "PriceChangeResult",
];

/**
 * A prepaid code the listener bought has a state of its own, as a payment
 * has: no change's state of the workflow. And activating a code holds the
 * letters of VAT without being any.
 */
const PREPAID_CODE_NAMES = [
  "PrepaidCodeState", "PrepaidCode.state", "Mutation.activatePrepaidPass", "PrepaidActivationResult", "PrepaidCodeState.ACTIVATED",
  "PrepaidCode.activatedOn",
];

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

/** Every name the schema shows, with where it shows it: Type, Type.field, Type.field(argument), Enum.VALUE. */
function names(schema: GraphQLSchema): Array<{ name: string; where: string }> {
  const found: Array<{ name: string; where: string }> = [];
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith("__") || specifiedScalarTypes.includes(type as never)) continue;
    found.push({ name: type.name, where: type.name });
    if (isEnumType(type)) for (const value of type.getValues()) found.push({ name: value.name, where: `${type.name}.${value.name}` });
    if (isObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        found.push({ name: field.name, where: `${type.name}.${field.name}` });
        for (const arg of field.args) found.push({ name: arg.name, where: `${type.name}.${field.name}(${arg.name})` });
      }
    }
    if (isInputObjectType(type)) for (const name of Object.keys(type.getFields())) found.push({ name, where: `${type.name}.${name}` });
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
    // The exceptions, each where it stands. A visitor may be told they are
    // not eligible for an offer; how many people are eligible is the
    // console's. A listener signs in and out of the site's demonstration,
    // which is no signature of an approval, and their page sends back its own
    // session's CSRF token. A payment has a state of its own, which is no
    // change's state of the workflow; so has a price change the listener answers.
    const exceptions = [
      "RefusalCode.NOT_ELIGIBLE", "Mutation.signInAsListener", "Mutation.signOutListener", "Me.csrfToken", "PaymentState", "Payment.state",
      ...PRICE_CHANGE_NAMES, ...PREPAID_CODE_NAMES, ...Object.keys(PUBLIC_BY_DECISION),
    ];
    assert.deepEqual(all.filter(({ name, where }) => INTERNAL_WORDS.test(name) && !exceptions.includes(where)).map(({ where }) => where), []);
    assert.deepEqual(exceptions.filter((where) => !all.some((entry) => entry.where === where)), [], "an exception for a name the schema no longer has");
    // Each name made public by decision is one the vocabulary would refuse: the decision is what lets it through.
    assert.deepEqual(Object.keys(PUBLIC_BY_DECISION).filter((where) => !INTERNAL_WORDS.test(where.split(".").at(-1) ?? "")), []);
  });

  test("the vocabulary check finds the internal schema's names, so it is not blind", () => {
    // The same check, run on the console's names, must find plenty.
    const internalNames = [
      "floor", "artistsMinimum", "breakdown", "approveChange", "fingerprint", "auditEvents", "eligible", "session", "topUp", "paymentCosts", "ChangeState",
      // Stage 7: the console's migration, its progress and simulation, and the market's policy.
      "createPriceMigration", "MigrationProgress", "simulateMigration", "priceChangePolicy", "PriceChangePolicy",
    ];
    assert.deepEqual(internalNames.filter((name) => !INTERNAL_WORDS.test(name)), []);
  });

  test("lets a client ask for every member of a union in one selection, without an alias", () => {
    // A prepaid code's code and a refusal's are String! and RefusalCode!: a purchase holds its code one level down.
    assert.deepEqual(unionConflicts(schema), []);
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
    const all = (name: string) => everything(schema.getType(name) as GraphQLNamedType);
    const site = harness.site();
    // A listener of the demo, so that me, its account, the verification and the subscription answer too.
    await site.signInAsListener(LISTENERS.verified);
    // A prepaid pass on sale in Italy, so that prepaidPasses answers too.
    const pass = harness.engine.seedPrepaidPass(ChangeState.ACTIVE);
    // Every root field of the queries, one request each: all of them in one would pass the site's cost limit.
    const answers = [];
    const catalog: Record<string, any> = {};
    for (const field of Object.values(query.getFields())) {
      const args = field.args.map((arg) => `${arg.name}: ${arg.name === "market" ? '"IT"' : '"student"'}`).join(", ");
      const answer = await site.graphql(`{ ${field.name}${args ? `(${args})` : ""} ${everything(getNamedType(field.type))} }`);
      answers.push(answer);
      Object.assign(catalog, answer.body.data);
    }
    const quoted = await site.graphql(`mutation { requestQuote(plan: "student", market: "IT", offerId: "9001") ${all("QuoteResult")} }`);
    answers.push(
      quoted,
      await site.graphql(`mutation { requestQuote(plan: "family", market: "IT") ${all("QuoteResult")} }`),
      await site.graphql(`mutation { requestQuote(plan: "student", market: "IT", offerId: "424") ${all("QuoteResult")} }`),
      await site.graphql(`mutation { verifyStudent ${all("VerificationResult")} }`),
    );
    const quoteId: unknown = quoted.body?.data?.requestQuote?.id;
    assert.equal(typeof quoteId, "string", quoted.text);
    answers.push(await site.graphql(`mutation ($q: ID!) { confirmSubscription(quoteId: $q) ${all("SubscriptionResult")} }`, { variables: { q: quoteId } }));
    answers.push(await site.graphql(`{ me ${all("Me")} }`));
    // The provider's event: the payment succeeds, and the account has its receipt.
    assert.equal(harness.engine.settlePayments(), 1);
    answers.push(await site.graphql(`{ me ${all("Me")} }`));
    for (const answer of answers) assert.equal(answer.body.errors, undefined, answer.text);
    // The answers are full: the check below is not passing on empty data.
    const [quote, plain, ended, verified, confirmed, pending, settled] = answers.slice(-7).map((answer) => answer.body.data);
    assert.equal(catalog["markets"].length, 4);
    assert.deepEqual({ vat: catalog["markets"][0].vatBasisPoints, minimum: catalog["markets"][0].artistsMinimum }, { vat: 2200, minimum: { amountMinor: "300", currency: "EUR" } });
    assert.equal(catalog["plans"].length, 5);
    const student = catalog["plans"].find((plan: { code: string }) => plan.code === "student");
    // §5.5: the Student price in Italy, €5.79, is €4.75 net; its pool of €2.85 gets €0.15 more to reach the €3.00.
    assert.deepEqual({ net: student.breakdown.net, artists: student.breakdown.artists, topUp: student.breakdown.topUp },
      { net: { amountMinor: "475", currency: "EUR" }, artists: { amountMinor: "300", currency: "EUR" }, topUp: { amountMinor: "15", currency: "EUR" } });
    assert.ok(catalog["prices"].length >= 1);
    assert.deepEqual(catalog["offers"][0].price, { amountMinor: "299", currency: "EUR" });
    // §14.1: of the artists' €3.00, €1.47 comes from the subscriber and €1.53 from the music service.
    assert.deepEqual(catalog["offers"][0].breakdown, {
      price: { amountMinor: "299", currency: "EUR" }, vat: { amountMinor: "54", currency: "EUR" }, net: { amountMinor: "245", currency: "EUR" },
      artists: { amountMinor: "300", currency: "EUR" }, topUp: { amountMinor: "153", currency: "EUR" }, paymentCosts: { amountMinor: "5", currency: "EUR" },
      companyKeeps: { amountMinor: "-60", currency: "EUR" },
    });
    assert.equal(catalog["demoListeners"].length, 6);
    assert.equal(catalog["me"].id, LISTENERS.verified);
    assert.equal(catalog["me"].account.subscription.plan, "free");
    assert.equal(catalog["me"].account.studentVerification.valid, true);
    assert.deepEqual(quote.requestQuote.price, { amountMinor: "299", currency: "EUR" });
    assert.equal(plain.requestQuote.__typename, "Quote");
    assert.deepEqual(ended.requestQuote, { __typename: "Refusal", code: "OFFER_ENDED", reason: "This offer is no longer on sale." });
    assert.equal(verified.verifyStudent.__typename, "StudentVerification");
    assert.equal(confirmed.confirmSubscription.__typename, "Confirmation");
    assert.equal(confirmed.confirmSubscription.payment.state, "PENDING");
    assert.equal(pending.me.account.subscription.paid, true);
    assert.equal(pending.me.account.payment.state, "PENDING");
    assert.equal(settled.me.account.payment.state, "SUCCEEDED");
    assert.deepEqual(settled.me.account.payment.receipt.amount, { amountMinor: "299", currency: "EUR" });
    // A price change (§8, §14.3): the Family listener in Germany is asked for
    // consent by a migration that started, reads it and says yes; a no after
    // the yes is refused.
    const migration = harness.engine.seedMigration(ChangeState.SCHEDULED);
    assert.equal(harness.engine.startMigration(migration.id).length, 1);
    const family = harness.site();
    await family.signInAsListener(LISTENERS.familyInGermany);
    const asked = await family.graphql(`{ me ${all("Me")} }`);
    const priceChangeId: unknown = asked.body?.data?.me?.account?.priceChanges?.[0]?.id;
    assert.equal(typeof priceChangeId, "string", asked.text);
    const answer = (accept: boolean) => family.graphql(
      `mutation ($id: ID!, $accept: Boolean!) { answerPriceChange(priceChangeId: $id, accept: $accept) ${all("PriceChangeResult")} }`,
      { variables: { id: priceChangeId, accept } },
    );
    const accepted = await answer(true);
    const closed = await answer(false);
    for (const reply of [asked, accepted, closed]) assert.equal(reply.body.errors, undefined, reply.text);
    const waiting = asked.body.data.me.account.priceChanges[0];
    assert.deepEqual({ kind: waiting.kind, state: waiting.state, appliesFrom: waiting.appliesFrom, ifNoLeavesOn: waiting.ifNoLeavesOn },
      { kind: "CONSENT", state: "WAITING", appliesFrom: "2026-12-15", ifNoLeavesOn: "2027-01-15" });
    assert.ok(waiting.ifNoAnswer.length > 0 && waiting.legalBasis.length > 0);
    assert.equal(asked.body.data.me.account.subscription.endsOn, "2027-01-15");
    assert.deepEqual({ typename: accepted.body.data.answerPriceChange.__typename, state: accepted.body.data.answerPriceChange.state },
      { typename: "PriceChange", state: "ACCEPTED" });
    assert.equal(closed.body.data.answerPriceChange.code, "ANSWER_CLOSED");
    answers.push(asked, accepted, closed);
    // A prepaid pass (§9, §14.4): the verified student, who now pays for
    // Student, buys one and gives its code to the unverified student, who
    // activates it; the buyer's account then shows the code activated, and
    // the code, used once, is refused to the buyer.
    assert.equal(catalog["prepaidPasses"].length, 1);
    const bought = await site.graphql(`mutation ($p: ID!) { buyPrepaidPass(passId: $p) ${all("PrepaidPurchaseResult")} }`, { variables: { p: pass.id } });
    const giftCode: unknown = bought.body?.data?.buyPrepaidPass?.prepaidCode?.code;
    assert.equal(typeof giftCode, "string", bought.text);
    assert.equal(bought.body.data.buyPrepaidPass.prepaidCode.state, "PENDING");
    assert.equal(harness.engine.settlePayments(), 1);
    const friend = harness.site();
    await friend.signInAsListener(LISTENERS.unverified);
    const activate = `mutation ($c: String!) { activatePrepaidPass(code: $c) ${all("PrepaidActivationResult")} }`;
    const activated = await friend.graphql(activate, { variables: { c: giftCode } });
    const buyerTries = await site.graphql(activate, { variables: { c: giftCode } });
    const buyer = await site.graphql(`{ me ${all("Me")} }`);
    const holder = await friend.graphql(`{ me ${all("Me")} }`);
    for (const reply of [bought, activated, buyerTries, buyer, holder]) assert.equal(reply.body.errors, undefined, reply.text);
    assert.deepEqual({ code: activated.body.data.activatePrepaidPass.prepaidCode, price: activated.body.data.activatePrepaidPass.price },
      { code: giftCode, price: { amountMinor: "0", currency: "EUR" } });
    assert.equal(buyerTries.body.data.activatePrepaidPass.code, "CODE_NOT_USABLE");
    assert.deepEqual(buyer.body.data.me.account.prepaidCodes.map((code: { state: string }) => code.state), ["ACTIVATED"]);
    assert.equal(holder.body.data.me.account.subscription.prepaidCode, giftCode);
    answers.push(bought, activated, buyerTries, buyer, holder);
    // The engine's messages carried the marks in floors, quotes' breakdowns,
    // price-list change ids, below-floor flags and top-ups, offer versions,
    // in the subscriber's ids of subscriptions, accounts and payments, the
    // provider's reasons and the verifier's references, in the migration a
    // price change comes from, and in who activated a prepaid code.
    assert.ok(harness.engine.calls.length >= 9);
    for (const answer of answers) {
      for (const mark of [String(SENTINEL.amount), SENTINEL.changeId, "987654", SENTINEL.text, "belowFloor", "floor"]) {
        assert.ok(!answer.text.includes(mark), `the public answer carries ${mark}: ${answer.text.slice(0, 400)}`);
      }
    }
  });

  test("the planted values are really in the engine's messages, so their absence above means something", async () => {
    const reader = harness.console();
    await reader.signIn("finance-1");
    const internal = await reader.graphql(`{ markets { floor } plans(market: "IT") { breakdown { companyKeeps } } priceList(market: "IT") { belowFloor topUp } }`);
    assert.ok(internal.text.includes(String(SENTINEL.amount)), internal.text.slice(0, 300));
    // The subscriber's messages, read from the engine itself: the console has no field for them.
    const engine = connectEngine(harness.engine.url, harness.engine.token);
    try {
      const headers = { "x-request-id": "marks-are-there-0001" };
      const { account } = await engine.client.subscribers.getAccount({ subscriberId: LISTENERS.verified }, { headers });
      assert.equal(account?.subscriberId, SENTINEL.changeId);
      assert.equal(account?.subscription?.subscriptionId, SENTINEL.changeId);
      assert.equal(account?.studentVerification?.reference, SENTINEL.text);
      // The payment of the subscription the test above confirmed.
      assert.equal(account?.payment?.paymentId, SENTINEL.text);
      assert.equal(account?.payment?.failureReason, SENTINEL.text);
      // The price change the test above answered: the migration it comes from is the console's.
      const family = await engine.client.subscribers.getAccount({ subscriberId: LISTENERS.familyInGermany }, { headers });
      assert.equal(family.account?.priceChanges.length, 1);
      assert.equal(family.account?.priceChanges[0]?.changeId, SENTINEL.changeId);
      // The prepaid code the test above bought: who activated it is a listener's id.
      assert.equal(account?.prepaidCodes.length, 1);
      assert.equal(account?.prepaidCodes[0]?.activatedBy, SENTINEL.changeId);
      assert.equal(account?.prepaidCodes[0]?.payment?.paymentId, SENTINEL.text);
    } finally {
      engine.close();
    }
  });

  test("an offer the engine sends without its breakdown, as the engine of stage 5 does, reads null, and nothing fails", async () => {
    harness.engine.published.push(create(PublishedOfferSchema, {
      offerId: "9004", version: 1, market: "IT", plan: "student", title: "Student Winter Pass", text: "Two months at a student price.",
      terms: "Verified students.", price: { amountMinor: 399n, currency: "EUR" }, listPrice: { amountMinor: 579n, currency: "EUR" },
      monthsAtOfferPrice: 2, audience: "Verified students", needsStudentCheck: true,
    }));
    try {
      const answer = await harness.site().graphql('{ offers(market: "IT") { id breakdown { price artists topUp } } }');
      assert.equal(answer.body.errors, undefined, answer.text);
      assert.deepEqual(answer.body.data.offers.map((offer: { id: string; breakdown: unknown }) => [offer.id, offer.breakdown === null]), [["9001", false], ["9004", true]]);
    } finally {
      harness.engine.published.pop();
    }
  });

  test("a refusal the site was not written for reads the gateway's fixed sentence", async () => {
    // GetQuote for a plan the engine cannot quote: NOT_FOUND, an error and not a refusal.
    const site = harness.site();
    const answer = await site.graphql(`mutation { requestQuote(plan: "free", market: "IT") { __typename } }`);
    assert.deepEqual(codes(answer), ["NOT_FOUND"]);
    assert.equal(answer.body.errors[0].message, "Not found.", "the site does not get the engine's own sentence");
  });

  test("the site's port does not know the console's operations at all", async () => {
    const site = harness.site();
    for (const query of ["{ people { id } }", '{ change(id: "1") { id } }', 'mutation { signIn(personId: "finance-1") { csrfToken } }']) {
      const answer = await site.graphql(query, { key: "site-key-00001" });
      assert.deepEqual(codes(answer), ["GRAPHQL_VALIDATION_FAILED"], query);
    }
  });

  test("the site's CORS answers its own origin only, with credentials for the site's own session cookie", async () => {
    const site = harness.site();
    const allowed = await site.raw({ method: "OPTIONS", headers: { origin: SITE_ORIGIN, "access-control-request-method": "POST" } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers["access-control-allow-origin"], SITE_ORIGIN);
    // In production the site keeps no sessions, and sends no credentials header (test/site-sessions.test.ts).
    assert.equal(allowed.headers["access-control-allow-credentials"], "true");
    const console = await site.raw({ method: "OPTIONS", headers: { origin: "http://console.test:4631", "access-control-request-method": "POST" } });
    assert.equal(console.status, 403);
    assert.equal(console.headers["access-control-allow-origin"], undefined);
  });
});

describe("the site's refusals: the gateway's sentences, never the engine's", () => {
  // Every answer of a site's client in these tests goes through the harness's
  // guard (INTERNAL_IN_PUBLIC): a number written with #, the word Subscriber,
  // an identifier of the audit log fail the test that received them.
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
    harness.clock.advance(Date.parse("2026-10-26T09:30:00Z") - harness.clock.now().getTime());
  });
  after(async () => {
    await harness.close();
  });

  test("the guard finds what the engine writes, so its silence below means something", () => {
    for (const engineSaid of [
      "Subscriber #5003 is not among verified students in italy who have never had a paid plan.",
      "Offer #9001 is no longer on sale in Italy.",
      "subject subscription:12", "actor subscriber-5001", "request launch-12", "payment pay_0123456789abcdef",
    ]) {
      assert.notEqual(internalIn(engineSaid), null, engineSaid);
    }
    for (const siteSays of ["It is for: verified students in Italy who have never had a paid plan.", "New subscribers only. One pass per verified student."]) {
      assert.equal(internalIn(siteSays), null, siteSays);
    }
  });

  test("every refusal a listener or a visitor can meet reads the site's sentence", async () => {
    const quoteOf = async (client: Client, plan: string, offerId: string | null) =>
      (await client.graphql(`mutation ($o: ID) { requestQuote(plan: "${plan}", market: "IT", offerId: $o) { __typename ... on Quote { id } ... on Refusal { code reason } } }`, {
        variables: { o: offerId },
      })).body.data.requestQuote;
    const france = harness.site();
    await france.signInAsListener(LISTENERS.freeInFrance);
    assert.deepEqual(await quoteOf(france, "student", "9001"), { __typename: "Refusal", code: "NOT_ELIGIBLE", reason: "It is not sold in your market." });
    assert.deepEqual((await france.graphql("mutation { verifyStudent { __typename ... on Refusal { code reason } } }")).body.data.verifyStudent,
      { __typename: "Refusal", code: "NOT_ELIGIBLE", reason: "The student verification found no student record for you." });
    const unverified = harness.site();
    await unverified.signInAsListener(LISTENERS.unverified);
    assert.deepEqual(await quoteOf(unverified, "student", null),
      { __typename: "Refusal", code: "NOT_ELIGIBLE", reason: "It needs a student verification that is valid today: verify first." });
    const visitor = harness.site();
    assert.deepEqual(await quoteOf(visitor, "student", "424"), { __typename: "Refusal", code: "OFFER_ENDED", reason: "This offer is no longer on sale." });
    const theirs = await quoteOf(visitor, "student", "9001");
    await visitor.signInAsListener(LISTENERS.paidBefore);
    const confirmed = await visitor.graphql("mutation ($q: ID!) { confirmSubscription(quoteId: $q) { __typename ... on Refusal { code reason } } }", { variables: { q: theirs.id } });
    assert.deepEqual(confirmed.body.data.confirmSubscription,
      { __typename: "Refusal", code: "NOT_ELIGIBLE", reason: "It is for: verified students in Italy who have never had a paid plan." });

    // What the engine itself answered there, read from it directly: its own sentences, with the numbers.
    const engine = connectEngine(harness.engine.url, harness.engine.token);
    try {
      const headers = { "x-request-id": "engine-says-0001", "idempotency-key": "engine-says-key-0001" };
      const answer = await engine.client.quotes.getQuote({ plan: "student", market: "IT", offerId: "9001", subscriberId: LISTENERS.freeInFrance }, { headers });
      assert.equal(answer.outcome.case, "refusal");
      assert.notEqual(internalIn(answer.outcome.value?.reason ?? ""), null, `the engine said: ${answer.outcome.value?.reason}`);
    } finally {
      engine.close();
    }
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
