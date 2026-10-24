// The price migrations in the console's schema (stage 7, §8 and §14.3): the
// commercial lead writes one, its validation blocks a price that does not
// rise, dates that are not to come or out of order, and an overlap; finance
// signs it for conditions 1 and 5 (§7.3); only the commercial lead schedules
// it, and the commercial lead or the on-call engineer cancels it; its
// simulation has the numbers of §8.7; each market's policy keeps the law and
// the commercial choice in fields apart; a migration that started shows where
// its subscribers stand. The fake engine follows the coordinator's behaviours
// for the engine's §14.3 service.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ChangeState } from "contracts/commerce/v1/changes";
import { type GraphQLObjectType } from "graphql";
import { buildInternalSchema } from "../src/core/schemas.ts";
import { LISTENERS } from "./support/fake-engine.ts";
import { type Client, codes, type Harness, startHarness } from "./support/harness.ts";

const EUR = (amountMinor: string) => ({ amountMinor, currency: "EUR" });
const MIGRATION = {
  title: "Family price in Germany", plan: "family", market: "DE", amount: EUR("2099"), noticesLocal: "2026-11-02T09:00", startsLocal: "2026-12-01T00:00",
};
const CHANGE = `id kind title state currentVersion createdBy { id } requiredSignatures { role conditions signed }
  current { version fingerprint content { __typename ... on PriceMigrationContent { title plan market amount noticesLocal startsLocal } } }`;
const RESULT = `__typename ... on Change { ${CHANGE} }
  ... on Refusal { code reason facts { name value } change { id state validation { valid eligible findings { check severity market } } } }`;
const CREATE = `mutation ($m: PriceMigrationInput!) { createPriceMigration(migration: $m) { ${RESULT} } }`;
const STEP = "price net artists paymentCosts contribution";
const SIMULATION = `__typename ... on MigrationSimulation {
    before { ${STEP} } after { ${STEP} } newSubscribersFrom { local utc } noticesFrom { local utc } windowEnds { local utc } existingFrom
    existing accepting notAccepting movingToFree monthlyRevenueChange monthlyContributionChange revenueAtRiskMonthly
    breakEvenAcceptanceRevenueBasisPoints breakEvenAcceptanceContributionBasisPoints prepaidPassesUntouched
    assumptions { name value source } financeConditions { number met }
  }
  ... on Refusal { code reason change { id } }`;

async function person(harness: Harness, id: string): Promise<Client> {
  const client = harness.console();
  await client.signIn(id);
  return client;
}

async function create(lead: Client, migration: Record<string, unknown> = {}) {
  const answer = await lead.graphql(CREATE, { variables: { m: { ...MIGRATION, ...migration } } });
  assert.equal(answer.body.errors, undefined, answer.text);
  return answer.body.data.createPriceMigration;
}

async function validate(lead: Client, changeId: string, version = 1) {
  const answer = await lead.graphql(`mutation ($id: ID!, $v: Int!) { validateChange(changeId: $id, version: $v) { ${RESULT} } }`, { variables: { id: changeId, v: version } });
  assert.equal(answer.body.errors, undefined, answer.text);
  return answer.body.data.validateChange;
}

describe("writing a price migration", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.close();
  });

  test("the commercial lead creates one: a draft of the new kind, with its content, and finance's signature for conditions 1 and 5 named at once", async () => {
    const lead = await person(harness, "commercial-lead-1");
    harness.engine.clearCalls();
    const answer = await lead.graphql(CREATE, { variables: { m: MIGRATION }, key: "create-migration-0001" });
    assert.equal(answer.body.errors, undefined, answer.text);
    const change = answer.body.data.createPriceMigration;
    assert.deepEqual({ ...change, id: undefined, current: { ...change.current, fingerprint: undefined } }, {
      __typename: "Change", id: undefined, kind: "PRICE_MIGRATION", title: "Family price in Germany", state: "DRAFT", currentVersion: 1,
      createdBy: { id: "commercial-lead-1" }, requiredSignatures: [{ role: "FINANCE", conditions: [1, 5], signed: false }],
      current: { version: 1, fingerprint: undefined, content: { __typename: "PriceMigrationContent", ...MIGRATION } },
    });
    const call = harness.engine.calls.find((candidate) => candidate.method === "CreateChange");
    assert.deepEqual([call?.actor, call?.role, call?.idempotencyKey], ["commercial-lead-1", "commercial_lead", "create-migration-0001"]);
    const sent = call?.message as { content: { case: string; value: { plan: string; market: string; amount: { amountMinor: bigint }; noticesLocal: string; startsLocal: string } } };
    assert.deepEqual(
      { case: sent.content.case, plan: sent.content.value.plan, market: sent.content.value.market, amount: sent.content.value.amount.amountMinor,
        noticesLocal: sent.content.value.noticesLocal, startsLocal: sent.content.value.startsLocal },
      { case: "priceMigration", plan: "family", market: "DE", amount: 2099n, noticesLocal: "2026-11-02T09:00", startsLocal: "2026-12-01T00:00" },
    );
  });

  test("a second version from the first, with its own content; a stale base version is refused", async () => {
    const lead = await person(harness, "commercial-lead-1");
    const { id } = await create(lead, { title: "Family price in Germany, second" });
    const save = `mutation ($id: ID!, $base: Int!, $m: PriceMigrationInput!) { savePriceMigrationVersion(changeId: $id, baseVersion: $base, migration: $m) { ${RESULT} } }`;
    const saved = await lead.graphql(save, { variables: { id, base: 1, m: { ...MIGRATION, title: "Family price in Germany, second", amount: EUR("2049") } } });
    assert.equal(saved.body.errors, undefined, saved.text);
    const change = saved.body.data.savePriceMigrationVersion;
    assert.deepEqual([change.currentVersion, change.current.content.amount], [2, EUR("2049")]);
    const stale = await lead.graphql(save, { variables: { id, base: 1, m: MIGRATION } });
    assert.equal(stale.body.data.savePriceMigrationVersion.code, "STALE_VERSION", stale.text);
  });

  test("marketing writes campaigns, not price migrations: refused before the engine", async () => {
    const marketing = await person(harness, "marketing-1");
    harness.engine.clearCalls();
    const answer = await marketing.graphql(CREATE, { variables: { m: MIGRATION } });
    assert.equal(answer.body.data.createPriceMigration.code, "ROLE_NOT_ALLOWED", answer.text);
    assert.equal(harness.engine.count("CreateChange"), 0);
  });

  test("the list of changes finds the migrations by their kind", async () => {
    const auditor = await person(harness, "auditor-1");
    const listed = await auditor.graphql("{ changes(filter: { kind: PRICE_MIGRATION }) { nodes { kind } } }");
    assert.equal(listed.body.errors, undefined, listed.text);
    const kinds: string[] = listed.body.data.changes.nodes.map((node: { kind: string }) => node.kind);
    assert.ok(kinds.length >= 2);
    assert.deepEqual([...new Set(kinds)], ["PRICE_MIGRATION"]);
  });
});

describe("validating a price migration: blocking checks", () => {
  let harness: Harness;
  let lead: Client;
  before(async () => {
    harness = await startHarness();
    lead = await person(harness, "commercial-lead-1");
  });
  after(async () => {
    await harness.close();
  });

  const blocked = async (migration: Record<string, unknown>, check: string) => {
    const { id } = await create(lead, migration);
    const refusal = await validate(lead, id);
    assert.deepEqual({ typename: refusal.__typename, code: refusal.code }, { typename: "Refusal", code: "INVALID" }, check);
    assert.deepEqual(refusal.facts.find((fact: { name: string }) => fact.name === "checks")?.value, check);
    assert.deepEqual(refusal.change.validation.findings, [{ check, severity: "BLOCKING", market: "DE" }]);
    assert.equal(refusal.change.state, "DRAFT");
    return refusal;
  };

  test("price: the new price must be above the list price in force", async () => {
    await blocked({ amount: EUR("1899") }, "price");
  });

  test("dates: existing subscribers are asked from a time still to come, and new ones never pay it before", async () => {
    await blocked({ noticesLocal: "2026-10-20T09:00" }, "dates");
    await blocked({ startsLocal: "2026-11-01T00:00" }, "dates");
  });

  test("a valid one passes, counting the subscribers it asks; another one on the same plan and market then overlaps it", async () => {
    const { id } = await create(lead);
    const validated = await validate(lead, id);
    assert.equal(validated.state, "VALIDATED", JSON.stringify(validated));
    // The Family listener in Germany is the one paid Family subscription of the fake engine's market.
    const read = await lead.graphql(`query ($id: ID!) { change(id: $id) { validation { valid eligible findings { check } } } }`, { variables: { id } });
    assert.deepEqual(read.body.data.change.validation, { valid: true, eligible: 1, findings: [] });
    await blocked({ title: "Family price in Germany, again" }, "overlap");
  });
});

describe("approving, scheduling and cancelling a price migration", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.close();
  });

  test("finance signs for conditions 1 and 5; only the commercial lead schedules; marketing cannot cancel it, the on-call engineer can", async () => {
    const lead = await person(harness, "commercial-lead-1");
    const { id } = await create(lead);
    assert.equal((await validate(lead, id)).state, "VALIDATED");
    const submitted = await lead.graphql(`mutation ($id: ID!) { submitChange(changeId: $id, version: 1) { ${RESULT} } }`, { variables: { id } });
    assert.equal(submitted.body.data.submitChange.state, "IN_APPROVAL", submitted.text);
    const fingerprint = submitted.body.data.submitChange.current.fingerprint;
    const finance = await person(harness, "finance-1");
    const approved = await finance.graphql(`mutation ($id: ID!, $f: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $f) { ${RESULT} } }`, {
      variables: { id, f: fingerprint },
    });
    assert.deepEqual([approved.body.data.approveChange.state, approved.body.data.approveChange.requiredSignatures], [
      "APPROVED", [{ role: "FINANCE", conditions: [1, 5], signed: true }],
    ], approved.text);
    const schedule = `mutation ($id: ID!) { scheduleChange(changeId: $id) { ${RESULT} } }`;
    // Finance and the on-call engineer schedule nothing: refused before the
    // engine. Marketing schedules offers, so the gateway lets a person with
    // that one role ask without looking the change up, and the engine refuses
    // it for a migration, by the change's kind (§12).
    harness.engine.clearCalls();
    for (const someone of ["finance-1", "on-call-1"]) {
      const refused = await (await person(harness, someone)).graphql(schedule, { variables: { id } });
      assert.equal(refused.body.data.scheduleChange.code, "ROLE_NOT_ALLOWED", `${someone}: ${refused.text}`);
    }
    assert.equal(harness.engine.count("ScheduleChange"), 0, "a role that schedules nothing never reaches the engine");
    const notMarketing = await (await person(harness, "marketing-1")).graphql(schedule, { variables: { id } });
    assert.equal(notMarketing.body.data.scheduleChange.code, "ROLE_NOT_ALLOWED", notMarketing.text);
    assert.deepEqual(harness.engine.calls.filter((call) => call.method === "ScheduleChange").map((call) => call.role), ["marketing"]);
    const scheduled = await lead.graphql(schedule, { variables: { id } });
    assert.equal(scheduled.body.data.scheduleChange.state, "SCHEDULED", scheduled.text);
    const cancel = `mutation ($id: ID!) { cancelChange(changeId: $id, reason: "Rolled back: the notice text needs another review.") { ${RESULT} } }`;
    const marketingCancels = await (await person(harness, "marketing-1")).graphql(cancel, { variables: { id } });
    assert.equal(marketingCancels.body.data.cancelChange.code, "ROLE_NOT_ALLOWED", "marketing cancels an offer, not a migration");
    const cancelled = await (await person(harness, "on-call-1")).graphql(cancel, { variables: { id } });
    assert.equal(cancelled.body.data.cancelChange.state, "CANCELLED", cancelled.text);
  });
});

describe("the simulation of a price migration (§8.7)", () => {
  let harness: Harness;
  let changeId: string;
  before(async () => {
    harness = await startHarness();
    changeId = harness.engine.seedMigration(ChangeState.DRAFT).id;
  });
  after(async () => {
    await harness.close();
  });

  test("has the book's numbers: €15.96 net to €17.64, the artists' €9.58 to €10.58, the revenue at risk for 8,412 subscribers at 93% acceptance", async () => {
    const finance = await person(harness, "finance-1");
    harness.engine.clearCalls();
    const answer = await finance.graphql(`query ($id: ID!) { simulateMigration(changeId: $id, overrides: [{ name: EXISTING, value: 8412 }, { name: ACCEPTANCE, value: 9300 }]) { ${SIMULATION} } }`, {
      variables: { id: changeId },
    });
    assert.equal(answer.body.errors, undefined, answer.text);
    const simulation = answer.body.data.simulateMigration;
    assert.deepEqual({ before: simulation.before, after: simulation.after }, {
      before: { price: EUR("1899"), net: EUR("1596"), artists: EUR("958"), paymentCosts: EUR("34"), contribution: EUR("604") },
      after: { price: EUR("2099"), net: EUR("1764"), artists: EUR("1058"), paymentCosts: EUR("38"), contribution: EUR("668") },
    });
    assert.deepEqual({ ...simulation, before: undefined, after: undefined, existingFrom: undefined }, {
      __typename: "MigrationSimulation", before: undefined, after: undefined, existingFrom: undefined,
      newSubscribersFrom: { local: "2026-12-01T00:00", utc: "2026-11-30T23:00:00Z" },
      noticesFrom: { local: "2026-11-02T09:00", utc: "2026-11-02T08:00:00Z" },
      windowEnds: { local: "2026-12-17T23:59", utc: "2026-12-17T22:59:00Z" },
      existing: 8412, accepting: 7823, notAccepting: 589, movingToFree: 589,
      monthlyRevenueChange: EUR("374220"), monthlyContributionChange: EUR("144916"), revenueAtRiskMonthly: EUR("940044"),
      breakEvenAcceptanceRevenueBasisPoints: 9048, breakEvenAcceptanceContributionBasisPoints: 9042, prepaidPassesUntouched: 0,
      assumptions: [
        { name: "EXISTING", value: 8412, source: "typed by finance at 2026-10-24T08:00:00Z" },
        { name: "ACCEPTANCE", value: 9300, source: "typed by finance at 2026-10-24T08:00:00Z" },
      ],
      // The five conditions of §7.3: a migration sets a list price (1) and asks for consent (5).
      financeConditions: [{ number: 1, met: true }, { number: 2, met: false }, { number: 3, met: false }, { number: 4, met: false }, { number: 5, met: true }],
    });
    assert.match(simulation.existingFrom, /17 December 2026/);
    const call = harness.engine.calls.find((candidate) => candidate.method === "SimulateMigration");
    assert.deepEqual([call?.actor, call?.role, (call?.message as { version: number }).version], ["finance-1", "finance", 0], "no version: the current one");
  });

  test("without assumptions typed, the subscribers counted in the data, and the book's illustrative 90% (§16)", async () => {
    const lead = await person(harness, "commercial-lead-1");
    const answer = await lead.graphql(`query ($id: ID!) { simulateMigration(changeId: $id) { ${SIMULATION} } }`, { variables: { id: changeId } });
    assert.equal(answer.body.errors, undefined, answer.text);
    // The fake engine's one Family subscriber in Germany: the demo's listener.
    assert.deepEqual(answer.body.data.simulateMigration.assumptions, [
      { name: "EXISTING", value: 1, source: "counted in the data at 2026-10-24T08:00:00Z" },
      { name: "ACCEPTANCE", value: 9000, source: "default: business book §16 (illustrative)" },
    ]);
  });

  test("an acceptance typed as an assumption: at the break-even rate the monthly revenue barely moves", async () => {
    const lead = await person(harness, "commercial-lead-1");
    harness.engine.clearCalls();
    const answer = await lead.graphql(`query ($id: ID!) { simulateMigration(changeId: $id, version: 1, overrides: [{ name: EXISTING, value: 8412 }, { name: ACCEPTANCE, value: 9048 }]) { ${SIMULATION} } }`, {
      variables: { id: changeId },
    });
    assert.equal(answer.body.errors, undefined, answer.text);
    const simulation = answer.body.data.simulateMigration;
    assert.deepEqual([simulation.accepting, simulation.notAccepting, simulation.monthlyRevenueChange], [7611, 801, EUR("252")]);
    assert.deepEqual(simulation.assumptions[1], { name: "ACCEPTANCE", value: 9048, source: "typed by the commercial lead at 2026-10-24T08:00:00Z" });
    const sent = harness.engine.calls.find((candidate) => candidate.method === "SimulateMigration")?.message as { version: number; overrides: Array<{ name: string; value: bigint }> };
    assert.deepEqual([sent.version, sent.overrides.map((override) => [override.name, override.value])], [1, [["existing", 8412n], ["acceptance", 9048n]]]);
  });

  test("counts the prepaid passes of the plan in the market, which it never touches: paid for and not used yet, or running (§9.1)", async () => {
    const finance = await person(harness, "finance-1");
    const untouched = async () => {
      const answer = await finance.graphql(`query ($id: ID!) { simulateMigration(changeId: $id) { ... on MigrationSimulation { prepaidPassesUntouched } } }`, {
        variables: { id: changeId },
      });
      assert.equal(answer.body.errors, undefined, answer.text);
      return answer.body.data.simulateMigration.prepaidPassesUntouched;
    };
    assert.equal(await untouched(), 0);
    const pass = harness.engine.seedPrepaidPass(ChangeState.ACTIVE, {
      title: "Family gift pass", plan: "family", prices: [{ market: "DE", amountMinor: 5499n }], periods: [{ market: "DE", startsLocal: "2026-10-01T00:00" }],
    });
    const family = harness.site();
    await family.signInAsListener(LISTENERS.familyInGermany);
    const bought = await family.graphql("mutation ($p: ID!) { buyPrepaidPass(passId: $p) { __typename } }", { variables: { p: pass.id } });
    assert.equal(bought.body.data.buyPrepaidPass.__typename, "PrepaidPurchase", bought.text);
    assert.equal(await untouched(), 0, "a code whose payment is pending is not sold yet");
    harness.engine.settlePayments();
    assert.equal(await untouched(), 1);
  });

  test("an offer is no migration: a malformed request, in the engine's words, which the console reads", async () => {
    const offer = harness.engine.seedOffer("Student Winter Pass", "marketing-1", ChangeState.DRAFT);
    const marketing = await person(harness, "marketing-1");
    const answer = await marketing.graphql(`query ($id: ID!) { simulateMigration(changeId: $id) { ${SIMULATION} } }`, { variables: { id: offer.id } });
    assert.deepEqual(codes(answer), ["BAD_USER_INPUT"], answer.text);
    assert.equal(answer.body.errors[0].message, `The engine refused the request as malformed. change #${offer.id} is not a price migration; a campaign has SimulateOffer`);
  });
});

describe("each market's policy for price changes (§8.1): the law and the music service's choice, never mixed", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.close();
  });

  test("the schema keeps them in two types: the law with its sources, the choice with its label", () => {
    const schema = buildInternalSchema();
    const fields = (name: string) => Object.keys((schema.getType(name) as GraphQLObjectType).getFields());
    assert.deepEqual(fields("PriceChangePolicy"), ["law", "choice"]);
    assert.deepEqual(fields("PriceChangeLaw"), ["requirement", "basis", "sources"]);
    assert.deepEqual(fields("PriceChangeChoice"), ["windowDays", "afterWindow", "words", "alternatives", "label"]);
  });

  test("Germany asks for consent for 45 days, then moves to Free; Italy, France and the United Kingdom tell 30 days ahead", async () => {
    const marketing = await person(harness, "marketing-1");
    const answer = await marketing.graphql(`{ markets { code priceChangePolicy {
      law { requirement basis sources } choice { windowDays afterWindow words alternatives label } } } }`);
    assert.equal(answer.body.errors, undefined, answer.text);
    const policies = Object.fromEntries(answer.body.data.markets.map((market: { code: string; priceChangePolicy: unknown }) => [market.code, market.priceChangePolicy]));
    const germany = policies["DE"];
    assert.equal(germany.law.requirement, "CONSENT");
    assert.match(germany.law.basis, /Silence is not consent/);
    assert.equal(germany.law.sources.length, 2);
    assert.deepEqual({ ...germany.choice, alternatives: germany.choice.alternatives.length }, {
      windowDays: 45, afterWindow: "MOVE_TO_FREE", words: "Move the account to Free at the consent deadline, keeping playlists and library.", alternatives: 2,
      label: "The music service's choice, configurable per market; not a legal requirement.",
    });
    for (const code of ["IT", "FR", "GB"]) {
      const policy = policies[code];
      assert.deepEqual([policy.law.requirement, policy.choice.windowDays, policy.choice.afterWindow], ["NOTICE", 30, "NEW_PRICE"], code);
      assert.ok(policy.law.sources.length >= 1, code);
    }
    // The law says nothing of the choice, and the choice says it is no law.
    for (const [code, policy] of Object.entries(policies) as Array<[string, { law: { basis: string }; choice: { words: string; label: string } }]>) {
      assert.ok(!policy.law.basis.includes(policy.choice.words), code);
      assert.match(policy.choice.label, /not a legal requirement/, code);
    }
  });
});

describe("a price migration that started", () => {
  let harness: Harness;
  let changeId: string;
  before(async () => {
    harness = await startHarness();
    changeId = harness.engine.seedMigration(ChangeState.SCHEDULED).id;
  });
  after(async () => {
    await harness.close();
  });

  const PROGRESS = "state migration { requirement windowEnds { local utc } asked waiting accepted declined lapsed newPrice left }";

  test("has no progress before it starts, and then counts the subscribers it asked, as they answer", async () => {
    const reader = await person(harness, "auditor-1");
    const read = async () => {
      const answer = await reader.graphql(`query ($id: ID!) { change(id: $id) { ${PROGRESS} } }`, { variables: { id: changeId } });
      assert.equal(answer.body.errors, undefined, answer.text);
      return answer.body.data.change;
    };
    assert.deepEqual(await read(), { state: "SCHEDULED", migration: null });
    harness.clock.advance(Date.parse("2026-11-02T08:00:00Z") - harness.clock.now().getTime());
    harness.engine.startMigration(changeId);
    const reader2 = await person(harness, "auditor-1");
    const progress = async () => {
      const answer = await reader2.graphql(`query ($id: ID!) { change(id: $id) { ${PROGRESS} } }`, { variables: { id: changeId } });
      assert.equal(answer.body.errors, undefined, answer.text);
      return answer.body.data.change;
    };
    assert.deepEqual(await progress(), {
      state: "ACTIVE",
      migration: {
        requirement: "CONSENT", windowEnds: { local: "2026-12-17T23:59", utc: "2026-12-17T22:59:00Z" },
        asked: 1, waiting: 1, accepted: 0, declined: 0, lapsed: 0, newPrice: 0, left: 0,
      },
    });
    const family = harness.site();
    await family.signInAsListener(LISTENERS.familyInGermany);
    const account = await family.graphql("{ me { account { priceChanges { id } } } }");
    const priceChangeId = account.body.data.me.account.priceChanges[0].id;
    const answered = await family.graphql("mutation ($id: ID!) { answerPriceChange(priceChangeId: $id, accept: false) { __typename } }", { variables: { id: priceChangeId } });
    assert.equal(answered.body.data.answerPriceChange.__typename, "PriceChange", answered.text);
    assert.deepEqual((await progress()).migration, {
      requirement: "CONSENT", windowEnds: { local: "2026-12-17T23:59", utc: "2026-12-17T22:59:00Z" },
      asked: 1, waiting: 0, accepted: 0, declined: 1, lapsed: 0, newPrice: 0, left: 0,
    });
    // From 15 January 2027 the Family listener who said no is on Free: they left.
    harness.clock.advance(Date.parse("2027-01-15T09:00:00Z") - harness.clock.now().getTime());
    const late = await person(harness, "auditor-1");
    const answer = await late.graphql(`query ($id: ID!) { change(id: $id) { migration { declined left } } }`, { variables: { id: changeId } });
    assert.deepEqual(answer.body.data.change.migration, { declined: 1, left: 1 });
  });

  test("a change of another kind has no migration progress", async () => {
    const offer = harness.engine.seedOffer("Student Winter Pass", "marketing-1", ChangeState.DRAFT);
    const reader = await person(harness, "auditor-1");
    const answer = await reader.graphql(`query ($id: ID!) { change(id: $id) { kind migration { asked } } }`, { variables: { id: offer.id } });
    assert.deepEqual(answer.body.data.change, { kind: "OFFER", migration: null });
  });
});
