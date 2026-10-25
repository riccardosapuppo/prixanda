// A price change from the listener's side (stage 7, §8 and §14.3): the
// request for consent in Germany and the notice elsewhere, in the account
// with every date the engine works out on the listener's own billing days, so
// that the site writes them and computes nothing; and the answer, the
// session's listener's, idempotent, refused in the site's words once it can
// no longer be given. The fake engine follows the engine's behaviours
// (proto/README.md) for its §14.3 service; the integration test walks the same path
// through the real one once it is there.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ChangeState } from "contracts/commerce/v1/changes";
import { LISTENERS } from "./support/fake-engine.ts";
import { type Client, codes, type Harness, startHarness } from "./support/harness.ts";

const EUR = (amountMinor: string) => ({ amountMinor, currency: "EUR" });
const PRICE_CHANGE = `id plan oldPrice newPrice kind sentAt windowEnds { local utc } newSubscribersFrom { local utc } state
  newPriceFrom appliesFrom ifNoLeavesOn leavesOn ifNoAnswer legalBasis`;
const ACCOUNT = `{ me { account { subscription { plan paid price billingDay nextBillingOn nextCharge endsOn } priceChanges { ${PRICE_CHANGE} } } } }`;
const ANSWER = `mutation ($id: ID!, $accept: Boolean!) { answerPriceChange(priceChangeId: $id, accept: $accept) { __typename
  ... on PriceChange { ${PRICE_CHANGE} } ... on Refusal { code reason } } }`;

/** The site's sentence when a price change takes no other answer: the engine's own names the change by its number. */
const CLOSED = { __typename: "Refusal", code: "ANSWER_CLOSED", reason: "This price change takes no other answer now: you answered it already, or the time to answer has ended." };

/** 2 November 2026, 09:00 in Berlin and Paris: the migrations below ask and tell their subscribers. */
const NOTICES = "2026-11-02T08:00:00Z";

function moveTo(harness: Harness, iso: string): void {
  harness.clock.advance(Date.parse(iso) - harness.clock.now().getTime());
}

/** A new session of a demo listener: the clock moves by weeks here, further than a session lives. */
async function listener(harness: Harness, id: string): Promise<Client> {
  const client = harness.site();
  await client.signInAsListener(id);
  return client;
}

async function account(harness: Harness, id: string) {
  const answer = await (await listener(harness, id)).graphql(ACCOUNT);
  assert.equal(answer.body.errors, undefined, answer.text);
  return answer.body.data.me.account;
}

async function answer(client: Client, priceChangeId: string, accept: boolean, key?: string) {
  const reply = await client.graphql(ANSWER, { variables: { id: priceChangeId, accept }, ...(key ? { key } : {}) });
  assert.equal(reply.body.errors, undefined, reply.text);
  return reply.body.data.answerPriceChange;
}

/** The Family price in Germany, from €18.99 to €20.99 (§14.3), started at its notice time: the Family listener is asked for consent. */
async function familyAsked(): Promise<{ harness: Harness; priceChangeId: string }> {
  const harness = await startHarness();
  const migration = harness.engine.seedMigration(ChangeState.SCHEDULED);
  moveTo(harness, NOTICES);
  const [asked] = harness.engine.startMigration(migration.id);
  assert.ok(asked);
  return { harness, priceChangeId: asked.id };
}

/**
 * The listener on Free in France takes Individual at its list price on 24
 * October, so that their billing day is the 24th; the Individual price in
 * France then rises from €10.99 to €11.99, told 30 days ahead.
 */
async function franceTold(): Promise<{ harness: Harness; priceChangeId: string }> {
  const harness = await startHarness();
  const france = await listener(harness, LISTENERS.freeInFrance);
  const quoted = await france.graphql('mutation { requestQuote(plan: "individual", market: "FR") { __typename ... on Quote { id } } }');
  const confirmed = await france.graphql("mutation ($q: ID!) { confirmSubscription(quoteId: $q) { __typename } }", { variables: { q: quoted.body.data.requestQuote.id } });
  assert.equal(confirmed.body.data.confirmSubscription.__typename, "Confirmation", confirmed.text);
  const migration = harness.engine.seedMigration(ChangeState.SCHEDULED, { title: "Individual price in France", plan: "individual", market: "FR", amountMinor: 1199n });
  moveTo(harness, NOTICES);
  const [told] = harness.engine.startMigration(migration.id);
  assert.ok(told);
  return { harness, priceChangeId: told.id };
}

describe("a request for consent in Germany (§8.2): nothing changes without a yes, and silence is no", () => {
  describe("asked, then yes", () => {
    let harness: Harness;
    let priceChangeId: string;
    before(async () => {
      ({ harness, priceChangeId } = await familyAsked());
    });
    after(async () => {
      await harness.close();
    });

    test("the account has the request with every date the site writes: the new price after a yes today, the end of the plan without one", async () => {
      const { subscription, priceChanges } = await account(harness, LISTENERS.familyInGermany);
      assert.equal(priceChanges.length, 1);
      const [asked] = priceChanges;
      assert.deepEqual({ ...asked, ifNoAnswer: undefined, legalBasis: undefined }, {
        id: priceChangeId, plan: "family", oldPrice: EUR("1899"), newPrice: EUR("2099"), kind: "CONSENT", sentAt: NOTICES,
        // 45 days from the notice, to the end of the day in Berlin.
        windowEnds: { local: "2026-12-17T23:59", utc: "2026-12-17T22:59:00Z" },
        newSubscribersFrom: { local: "2026-12-01T00:00", utc: "2026-11-30T23:00:00Z" },
        state: "WAITING", newPriceFrom: null,
        // A yes today: the first charge from tomorrow, not before the start for new subscribers.
        appliesFrom: "2026-12-15",
        // No yes: the plan runs to the first billing day on or after the deadline, so a paid month is never cut short.
        ifNoLeavesOn: "2027-01-15", leavesOn: null,
        ifNoAnswer: undefined, legalBasis: undefined,
      });
      // The law and the music service's choice, each in its own words: the choice says it is no law.
      assert.match(asked.legalBasis, /consent/);
      assert.match(asked.ifNoAnswer, /Free/);
      assert.match(asked.ifNoAnswer, /not a legal requirement/);
      assert.ok(!asked.legalBasis.includes(asked.ifNoAnswer) && !asked.ifNoAnswer.includes(asked.legalBasis));
      // The subscription says when it ends if nothing more is done; November and December are charged at the old price.
      assert.deepEqual(subscription, {
        plan: "family", paid: true, price: EUR("1899"), billingDay: 15, nextBillingOn: "2026-11-15", nextCharge: EUR("1899"), endsOn: "2027-01-15",
      });
    });

    test("yes: accepted, at the new price from 15 December; the engine heard the session's listener and no person of the team", async () => {
      const family = await listener(harness, LISTENERS.familyInGermany);
      harness.engine.clearCalls();
      const accepted = await answer(family, priceChangeId, true, "answer-yes-0001");
      assert.deepEqual({ typename: accepted.__typename, state: accepted.state, newPriceFrom: accepted.newPriceFrom }, {
        typename: "PriceChange", state: "ACCEPTED", newPriceFrom: "2026-12-15",
      });
      assert.deepEqual([accepted.appliesFrom, accepted.ifNoLeavesOn, accepted.leavesOn], [null, null, null], "the dates of a waiting request are gone once it is decided");
      const call = harness.engine.calls.find((candidate) => candidate.method === "AnswerPriceChange");
      const sent = call?.message as { subscriberId: string; priceChangeId: string; accept: boolean } | undefined;
      assert.deepEqual({ subscriberId: sent?.subscriberId, priceChangeId: sent?.priceChangeId, accept: sent?.accept }, {
        subscriberId: LISTENERS.familyInGermany, priceChangeId, accept: true,
      });
      assert.deepEqual([call?.actor, call?.role, call?.idempotencyKey], [null, null, "answer-yes-0001"]);
      const { subscription } = await account(harness, LISTENERS.familyInGermany);
      assert.deepEqual({ endsOn: subscription.endsOn, nextBillingOn: subscription.nextBillingOn, nextCharge: subscription.nextCharge }, {
        endsOn: null, nextBillingOn: "2026-11-15", nextCharge: EUR("1899"),
      });
    });

    test("the same yes again comes back the same, and the audit log has one answer, by the listener", async () => {
      const family = await listener(harness, LISTENERS.familyInGermany);
      const again = await answer(family, priceChangeId, true);
      assert.deepEqual({ state: again.state, newPriceFrom: again.newPriceFrom }, { state: "ACCEPTED", newPriceFrom: "2026-12-15" });
      const answered = harness.engine.audit.filter((event) => event.action === "price_change.answered");
      assert.deepEqual(answered.map((event) => event.actor), [`subscriber-${LISTENERS.familyInGermany}`]);
      assert.match(answered[0]?.subject ?? "", /^subscription:\d+$/, "the engine's subject is the subscription the answer acts on");
      assert.equal(JSON.parse(answered[0]?.bodyJson ?? "{}").price_change, priceChangeId);
    });

    test("a no after the yes is refused in the site's words, never the engine's", async () => {
      const family = await listener(harness, LISTENERS.familyInGermany);
      const reply = await family.graphql(ANSWER, { variables: { id: priceChangeId, accept: false } });
      assert.deepEqual(reply.body.data.answerPriceChange, CLOSED);
      // The engine said "This price change was answered already, and the answer stays.".
      assert.ok(!reply.text.includes("answer stays"), reply.text);
    });

    test("from the charge after 15 November, the next one is at the new price; from 15 December, the price itself", async () => {
      moveTo(harness, "2026-11-16T09:00:00Z");
      const november = (await account(harness, LISTENERS.familyInGermany)).subscription;
      assert.deepEqual([november.price, november.nextBillingOn, november.nextCharge], [EUR("1899"), "2026-12-15", EUR("2099")]);
      moveTo(harness, "2026-12-15T09:00:00Z");
      const december = (await account(harness, LISTENERS.familyInGermany)).subscription;
      assert.deepEqual([december.price, december.nextBillingOn, december.nextCharge, december.endsOn], [EUR("2099"), "2027-01-15", EUR("2099"), null]);
    });
  });

  describe("asked, then no", () => {
    let harness: Harness;
    let priceChangeId: string;
    before(async () => {
      ({ harness, priceChangeId } = await familyAsked());
    });
    after(async () => {
      await harness.close();
    });

    test("no: declined, and the end decided at once: the plan ends on 15 January, when the month paid for runs out", async () => {
      const family = await listener(harness, LISTENERS.familyInGermany);
      const declined = await answer(family, priceChangeId, false);
      assert.deepEqual([declined.state, declined.newPriceFrom, declined.appliesFrom, declined.ifNoLeavesOn, declined.leavesOn], ["DECLINED", null, null, null, "2027-01-15"]);
      const { subscription } = await account(harness, LISTENERS.familyInGermany);
      assert.deepEqual([subscription.endsOn, subscription.nextBillingOn, subscription.nextCharge], ["2027-01-15", "2026-11-15", EUR("1899")]);
      const same = await answer(family, priceChangeId, false);
      assert.equal(same.state, "DECLINED", "the same no again comes back the same");
      const reply = await family.graphql(ANSWER, { variables: { id: priceChangeId, accept: true } });
      assert.deepEqual(reply.body.data.answerPriceChange, CLOSED);
    });

    test("at the deadline it stays declined; after the December charge there is no next one", async () => {
      moveTo(harness, "2026-12-17T22:59:00Z");
      const closed = await account(harness, LISTENERS.familyInGermany);
      assert.deepEqual([closed.priceChanges[0].state, closed.priceChanges[0].leavesOn], ["DECLINED", "2027-01-15"]);
      moveTo(harness, "2026-12-20T09:00:00Z");
      const { subscription } = await account(harness, LISTENERS.familyInGermany);
      assert.deepEqual([subscription.endsOn, subscription.nextBillingOn, subscription.nextCharge], ["2027-01-15", null, null]);
    });
  });

  describe("asked, and no answer", () => {
    let harness: Harness;
    let priceChangeId: string;
    before(async () => {
      ({ harness, priceChangeId } = await familyAsked());
    });
    after(async () => {
      await harness.close();
    });

    test("on the last day a yes would still bring the new price, from the first charge after it", async () => {
      moveTo(harness, "2026-12-17T22:58:00Z");
      const [waiting] = (await account(harness, LISTENERS.familyInGermany)).priceChanges;
      assert.deepEqual([waiting.state, waiting.appliesFrom, waiting.ifNoLeavesOn], ["WAITING", "2027-01-15", "2027-01-15"]);
    });

    test("at the deadline silence is no: lapsed, the plan ends on 15 January, and a yes after it is refused", async () => {
      moveTo(harness, "2026-12-17T22:59:00Z");
      const { subscription, priceChanges } = await account(harness, LISTENERS.familyInGermany);
      const [lapsed] = priceChanges;
      assert.deepEqual([lapsed.state, lapsed.leavesOn, lapsed.appliesFrom, lapsed.ifNoLeavesOn, lapsed.newPriceFrom], ["LAPSED", "2027-01-15", null, null, null]);
      assert.equal(subscription.endsOn, "2027-01-15");
      const family = await listener(harness, LISTENERS.familyInGermany);
      const reply = await family.graphql(ANSWER, { variables: { id: priceChangeId, accept: true } });
      assert.deepEqual(reply.body.data.answerPriceChange, CLOSED);
      // The engine said when the time to answer ended, in its own words.
      assert.ok(!reply.text.includes("time to answer ended on"), reply.text);
    });
  });
});

describe("a notice in France (§8.3 to §8.5): the new price applies unless the listener leaves before it", () => {
  describe("told, then yes", () => {
    let harness: Harness;
    let priceChangeId: string;
    before(async () => {
      ({ harness, priceChangeId } = await franceTold());
    });
    after(async () => {
      await harness.close();
    });

    test("the account has the notice: the new price from the first charge after it ends, the same day as leaving before it", async () => {
      const { subscription, priceChanges } = await account(harness, LISTENERS.freeInFrance);
      const [told] = priceChanges;
      assert.deepEqual({
        kind: told.kind, state: told.state, oldPrice: told.oldPrice, newPrice: told.newPrice, windowEnds: told.windowEnds,
        appliesFrom: told.appliesFrom, ifNoLeavesOn: told.ifNoLeavesOn, leavesOn: told.leavesOn, newPriceFrom: told.newPriceFrom,
      }, {
        kind: "NOTICE", state: "WAITING", oldPrice: EUR("1099"), newPrice: EUR("1199"),
        windowEnds: { local: "2026-12-02T23:59", utc: "2026-12-02T22:59:00Z" },
        appliesFrom: "2026-12-24", ifNoLeavesOn: "2026-12-24", leavesOn: null, newPriceFrom: null,
      });
      assert.match(told.legalBasis, /France/);
      assert.match(told.ifNoAnswer, /not a legal requirement/);
      // A notice ends nothing by itself.
      assert.deepEqual([subscription.billingDay, subscription.nextBillingOn, subscription.nextCharge, subscription.endsOn], [24, "2026-11-24", EUR("1099"), null]);
    });

    test("yes only says it was read: still waiting, and the same yes again is the same; a no after it is refused", async () => {
      const france = await listener(harness, LISTENERS.freeInFrance);
      const read = await answer(france, priceChangeId, true);
      assert.deepEqual([read.state, read.appliesFrom, read.ifNoLeavesOn], ["WAITING", "2026-12-24", "2026-12-24"]);
      assert.equal((await answer(france, priceChangeId, true)).state, "WAITING");
      const reply = await france.graphql(ANSWER, { variables: { id: priceChangeId, accept: false } });
      assert.deepEqual(reply.body.data.answerPriceChange, CLOSED);
    });

    test("when the notice runs out, the new price from 24 December", async () => {
      moveTo(harness, "2026-12-03T09:00:00Z");
      const { subscription, priceChanges } = await account(harness, LISTENERS.freeInFrance);
      assert.deepEqual([priceChanges[0].state, priceChanges[0].newPriceFrom, priceChanges[0].appliesFrom], ["NEW_PRICE", "2026-12-24", null]);
      assert.deepEqual([subscription.nextBillingOn, subscription.nextCharge, subscription.endsOn], ["2026-12-24", EUR("1199"), null]);
    });
  });

  describe("told, then no", () => {
    let harness: Harness;
    let priceChangeId: string;
    before(async () => {
      ({ harness, priceChangeId } = await franceTold());
    });
    after(async () => {
      await harness.close();
    });

    test("no: the subscription ends before the new price, decided at once", async () => {
      const france = await listener(harness, LISTENERS.freeInFrance);
      const declined = await answer(france, priceChangeId, false);
      assert.deepEqual([declined.state, declined.leavesOn, declined.appliesFrom, declined.ifNoLeavesOn], ["DECLINED", "2026-12-24", null, null]);
      const { subscription } = await account(harness, LISTENERS.freeInFrance);
      assert.deepEqual([subscription.endsOn, subscription.nextBillingOn, subscription.nextCharge], ["2026-12-24", "2026-11-24", EUR("1099")]);
      moveTo(harness, "2026-11-25T09:00:00Z");
      const after = (await account(harness, LISTENERS.freeInFrance)).subscription;
      assert.deepEqual([after.endsOn, after.nextBillingOn, after.nextCharge], ["2026-12-24", null, null], "no charge on the day it ends");
    });
  });
});

describe("answering, as the site's other mutations", () => {
  let harness: Harness;
  let priceChangeId: string;
  before(async () => {
    ({ harness, priceChangeId } = await familyAsked());
  });
  after(async () => {
    await harness.close();
  });

  test("names a price change of the session's listener: another listener's and an unknown one are not found, a malformed id never reaches the engine", async () => {
    const student = await listener(harness, LISTENERS.verified);
    for (const id of [priceChangeId, "999999"]) {
      const reply = await student.graphql(ANSWER, { variables: { id, accept: true } });
      assert.deepEqual(codes(reply), ["NOT_FOUND"], id);
      assert.equal(reply.body.errors[0].message, "Not found.", "the site does not get the engine's own sentence");
    }
    harness.engine.clearCalls();
    for (const id of ["0", "-3", "pc-1", "1e3"]) {
      assert.deepEqual(codes(await student.graphql(ANSWER, { variables: { id, accept: true } })), ["BAD_USER_INPUT"], id);
    }
    assert.equal(harness.engine.count("AnswerPriceChange"), 0);
    const [asked] = (await account(harness, LISTENERS.familyInGermany)).priceChanges;
    assert.equal(asked.state, "WAITING", "the other listener's request is untouched");
  });

  test("needs the session, its CSRF token and an Idempotency-Key; the engine hears nothing without them", async () => {
    harness.engine.clearCalls();
    const visitor = harness.site();
    assert.deepEqual(codes(await visitor.graphql(ANSWER, { variables: { id: priceChangeId, accept: true } })), ["UNAUTHENTICATED"]);
    const family = await listener(harness, LISTENERS.familyInGermany);
    const token = family.csrf;
    family.csrf = null;
    const unsigned = await family.graphql(ANSWER, { variables: { id: priceChangeId, accept: true } });
    assert.equal(unsigned.status, 403, unsigned.text);
    family.csrf = token;
    assert.deepEqual(codes(await family.graphql(ANSWER, { variables: { id: priceChangeId, accept: true }, key: false })), ["BAD_USER_INPUT"]);
    assert.equal(harness.engine.count("AnswerPriceChange"), 0);
  });

  test("a retry with the same Idempotency-Key gets the same answer", async () => {
    const family = await listener(harness, LISTENERS.familyInGermany);
    harness.engine.clearCalls();
    const first = await answer(family, priceChangeId, false, "answer-retry-0001");
    const retry = await answer(family, priceChangeId, false, "answer-retry-0001");
    assert.deepEqual(retry, first);
    assert.deepEqual(harness.engine.calls.filter((call) => call.method === "AnswerPriceChange").map((call) => call.idempotencyKey), ["answer-retry-0001", "answer-retry-0001"]);
  });
});
