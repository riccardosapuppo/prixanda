// The subscriber's side through the site (stage 5): a student verified by the
// simulated provider, a quote confirmed into a subscription at exactly its
// price, the account, and every refusal of the engine said in the site's
// words. The fake engine follows the engine's order of checks
// (commerce/engine/subscribers.py); the integration test walks the same path
// through the real one.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { PublishedOfferSchema } from "contracts/commerce/v1/catalog";
import { LISTENERS } from "./support/fake-engine.ts";
import { type Client, codes, type Harness, startHarness } from "./support/harness.ts";

const EUR = (amountMinor: string) => ({ amountMinor, currency: "EUR" });
const SUBSCRIPTION = "plan market paid price startedOn billingDay offerTitle offerMonths offerMonthsLeft fullPriceFrom fullPrice nextBillingOn nextCharge";
const PAYMENT = "state amount provider requestedAt settledAt receipt { id amount issuedAt provider providerReference demonstration note }";
const CONFIRM = `mutation ($q: ID!) { confirmSubscription(quoteId: $q) { __typename
  ... on Confirmation { subscription { ${SUBSCRIPTION} } payment { ${PAYMENT} } }
  ... on Refusal { code reason } } }`;
const ACCOUNT = `{ me { account { market subscription { ${SUBSCRIPTION} } payment { ${PAYMENT} } studentVerification { verifiedOn validUntil provider valid } } } }`;

/** 26 October 2026, 10:30 in Rome: the Student Autumn Pass is on sale (§14.1). */
const MONDAY_26_OCTOBER = Date.parse("2026-10-26T09:30:00Z");

function moveTo(harness: Harness, instant: number): void {
  harness.clock.advance(instant - harness.clock.now().getTime());
}

/** A quote of the session's listener (or of a visitor), its id. */
async function quote(client: Client, offerId: string | null, plan = "student"): Promise<string> {
  const answer = await client.graphql(`mutation ($o: ID) { requestQuote(plan: "${plan}", market: "IT", offerId: $o) { __typename ... on Quote { id } ... on Refusal { code reason } } }`, {
    variables: { o: offerId },
  });
  const id = answer.body?.data?.requestQuote?.id;
  if (typeof id !== "string") throw new Error(`no quote: ${answer.text}`);
  return id;
}

async function listener(harness: Harness, id: string): Promise<Client> {
  const client = harness.site();
  await client.signInAsListener(id);
  return client;
}

describe("the Student Autumn Pass, from the site", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
    moveTo(harness, MONDAY_26_OCTOBER);
  });
  after(async () => {
    await harness.close();
  });

  test("a verified student subscribes at the quoted price: €2.99 for three months, then €5.79 from 26 January 2027", async () => {
    const student = await listener(harness, LISTENERS.verified);
    const quoteId = await quote(student, "9001");
    harness.engine.clearCalls();
    const answer = await student.graphql(CONFIRM, { variables: { q: quoteId }, key: "confirm-autumn-0001" });
    assert.equal(answer.body.errors, undefined, answer.text);
    const { subscription, payment } = answer.body.data.confirmSubscription;
    assert.deepEqual(subscription, {
      plan: "student", market: "IT", paid: true, price: EUR("299"), startedOn: "2026-10-26", billingDay: 26,
      offerTitle: "Student Autumn Pass", offerMonths: 3, offerMonthsLeft: 3, fullPriceFrom: "2027-01-26", fullPrice: EUR("579"),
      nextBillingOn: "2026-11-26", nextCharge: EUR("299"),
    });
    // The first month is asked for after the confirmation: pending, and no receipt yet.
    assert.deepEqual(payment, { state: "PENDING", amount: EUR("299"), provider: "simulated", requestedAt: "2026-10-26T09:30:00Z", settledAt: null, receipt: null });
    // The engine heard the quote's id and the session's listener, and no person of the team.
    const call = harness.engine.calls.find((candidate) => candidate.method === "ConfirmQuote");
    const sent = call?.message as { quoteId: string; subscriberId: string } | undefined;
    assert.deepEqual({ quoteId: sent?.quoteId, subscriberId: sent?.subscriberId }, { quoteId, subscriberId: "5001" });
    assert.deepEqual([call?.actor, call?.role, call?.idempotencyKey], [null, null, "confirm-autumn-0001"]);
    // The account says the same: the subscription runs while the payment is pending.
    const account = await student.graphql(ACCOUNT);
    assert.deepEqual(account.body.data.me.account.subscription, subscription);
    assert.deepEqual(account.body.data.me.account.payment, payment);
  });

  test("the provider's answer settles the payment: the account then has the receipt, which says no money moved", async () => {
    harness.clock.advance(800);
    assert.equal(harness.engine.settlePayments(), 1);
    const account = await (await listener(harness, LISTENERS.verified)).graphql(ACCOUNT);
    const { receipt, ...payment } = account.body.data.me.account.payment;
    assert.deepEqual(payment, { state: "SUCCEEDED", amount: EUR("299"), provider: "simulated", requestedAt: "2026-10-26T09:30:00Z", settledAt: "2026-10-26T09:30:00Z" });
    assert.deepEqual({ amount: receipt.amount, provider: receipt.provider, demonstration: receipt.demonstration, issuedAt: receipt.issuedAt },
      { amount: EUR("299"), provider: "simulated", demonstration: true, issuedAt: "2026-10-26T09:30:00Z" });
    assert.match(receipt.note, /no money moved/);
    assert.match(receipt.providerReference, /^sim-pay-/);
    assert.equal(harness.engine.settlePayments(), 0, "an answer counts once");
  });

  test("the audit log has the subscription, written by the subscriber with the site's request id", async () => {
    const event = harness.engine.audit.find((candidate) => candidate.action === "subscription.confirmed");
    assert.ok(event);
    const auditor = harness.console();
    await auditor.signIn("auditor-1");
    const log = await auditor.graphql('{ auditEvents(filter: { action: "subscription.confirmed" }) { nodes { actor actorRole subject requestId } } }');
    assert.equal(log.body.errors, undefined, log.text);
    assert.deepEqual(log.body.data.auditEvents.nodes, [{ actor: "subscriber-5001", actorRole: "SUBSCRIBER", subject: event.subject, requestId: event.requestId }]);
    const confirmed = harness.logs.find((entry) => entry["msg"] === "request" && entry["requestId"] === event.requestId);
    assert.equal(confirmed?.["listener"], "5001", "the request that confirmed is the one the event names");
  });

  test("months later, the account follows the price: the offer's last month, then the list price", async () => {
    moveTo(harness, Date.parse("2026-12-27T09:00:00Z"));
    const december = await (await listener(harness, LISTENERS.verified)).graphql(ACCOUNT);
    assert.deepEqual(pick(december.body.data.me.account.subscription), { price: EUR("299"), offerMonthsLeft: 1, nextBillingOn: "2027-01-26", nextCharge: EUR("579") });
    moveTo(harness, Date.parse("2027-01-27T09:00:00Z"));
    const january = await (await listener(harness, LISTENERS.verified)).graphql(ACCOUNT);
    assert.deepEqual(pick(january.body.data.me.account.subscription), { price: EUR("579"), offerMonthsLeft: 0, nextBillingOn: "2027-02-26", nextCharge: EUR("579") });
  });
});

function pick(subscription: Record<string, unknown>) {
  return { price: subscription["price"], offerMonthsLeft: subscription["offerMonthsLeft"], nextBillingOn: subscription["nextBillingOn"], nextCharge: subscription["nextCharge"] };
}

describe("a payment the provider declines", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
    moveTo(harness, MONDAY_26_OCTOBER);
  });
  after(async () => {
    await harness.close();
  });

  test("is FAILED, with no receipt: the subscription runs to the end of the day, and the free plan follows", async () => {
    const student = await listener(harness, LISTENERS.verified);
    const confirmed = await student.graphql(CONFIRM, { variables: { q: await quote(student, "9001") } });
    assert.equal(confirmed.body.data.confirmSubscription.payment.state, "PENDING", confirmed.text);
    assert.equal(harness.engine.settlePayments("failed", "Card ending 4242 declined by the simulated provider."), 1);
    const today = (await student.graphql(ACCOUNT)).body.data.me.account;
    assert.deepEqual({ state: today.payment.state, settledAt: today.payment.settledAt, receipt: today.payment.receipt },
      { state: "FAILED", settledAt: "2026-10-26T09:30:00Z", receipt: null });
    assert.equal(today.subscription.plan, "student", "paid for until the end of the day");
    assert.doesNotMatch(JSON.stringify(today), /4242/, "the provider's own words stay with the engine");
    moveTo(harness, Date.parse("2026-10-27T09:30:00Z"));
    const tomorrow = (await (await listener(harness, LISTENERS.verified)).graphql(ACCOUNT)).body.data.me.account;
    assert.deepEqual({ plan: tomorrow.subscription.plan, paid: tomorrow.subscription.paid, payment: tomorrow.payment }, { plan: "free", paid: false, payment: null });
  });
});

describe("an engine that charges at the confirmation, as the engine of stage 5 does", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness({ engine: { payments: "at-confirmation" } });
    moveTo(harness, MONDAY_26_OCTOBER);
  });
  after(async () => {
    await harness.close();
  });

  test("answers with the receipt alone: the site reads a payment that succeeded at the confirmation", async () => {
    const student = await listener(harness, LISTENERS.verified);
    const answer = await student.graphql(CONFIRM, { variables: { q: await quote(student, "9001") } });
    assert.equal(answer.body.errors, undefined, answer.text);
    const { receipt, ...payment } = answer.body.data.confirmSubscription.payment;
    assert.deepEqual(payment, { state: "SUCCEEDED", amount: EUR("299"), provider: "simulated", requestedAt: "2026-10-26T09:30:00Z", settledAt: "2026-10-26T09:30:00Z" });
    assert.deepEqual({ amount: receipt.amount, demonstration: receipt.demonstration, issuedAt: receipt.issuedAt }, { amount: EUR("299"), demonstration: true, issuedAt: "2026-10-26T09:30:00Z" });
    assert.match(receipt.note, /no money moved/);
    // That engine keeps no payment in the account: the confirmation's is the one to show.
    const account = await student.graphql(ACCOUNT);
    assert.deepEqual({ plan: account.body.data.me.account.subscription.plan, payment: account.body.data.me.account.payment }, { plan: "student", payment: null });
  });

  test("a charge the provider declines there is PAYMENT_DECLINED, and nothing is subscribed", async () => {
    const student = await listener(harness, LISTENERS.unverified);
    await student.graphql("mutation { verifyStudent { __typename } }");
    const quoteId = await quote(student, "9001");
    harness.engine.declineNextCharge("Card ending 4242 declined by the simulated provider.");
    const answer = await student.graphql(CONFIRM, { variables: { q: quoteId } });
    assert.deepEqual(answer.body.data.confirmSubscription, {
      __typename: "Refusal", code: "PAYMENT_DECLINED", reason: "The payment provider declined the charge, so no subscription was made.",
    });
    const account = await student.graphql(ACCOUNT);
    assert.equal(account.body.data.me.account.subscription.plan, "free");
  });
});

describe("a confirmation, retried", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
    moveTo(harness, MONDAY_26_OCTOBER);
  });
  after(async () => {
    await harness.close();
  });

  test("with the same Idempotency-Key gives the same answer and subscribes once; the key does not do for another request", async () => {
    const student = await listener(harness, LISTENERS.verified);
    const quoteId = await quote(student, "9001");
    const first = await student.graphql(CONFIRM, { variables: { q: quoteId }, key: "confirm-retried-01" });
    const again = await student.graphql(CONFIRM, { variables: { q: quoteId }, key: "confirm-retried-01" });
    assert.equal(first.body.data.confirmSubscription.__typename, "Confirmation", first.text);
    assert.deepEqual(again.body.data, first.body.data);
    assert.equal(harness.engine.replays, 1);
    const paid = harness.engine.listeners.get(LISTENERS.verified)?.subscriptions.filter((subscription) => subscription.paid) ?? [];
    assert.equal(paid.length, 1, "one subscription, however many times it was asked");
    assert.equal(harness.engine.audit.filter((event) => event.action === "subscription.confirmed").length, 1);
    const other = await quote(student, null, "family");
    const reused = await student.graphql(CONFIRM, { variables: { q: other }, key: "confirm-retried-01" });
    assert.deepEqual(codes(reused), ["BAD_USER_INPUT"]);
  });

  test("without an Idempotency-Key is refused before the engine", async () => {
    const student = await listener(harness, LISTENERS.unverified);
    harness.engine.clearCalls();
    const answer = await student.graphql(CONFIRM, { variables: { q: "q_0123456789abcdef0123456789abcdef" }, key: false });
    assert.deepEqual(codes(answer), ["BAD_USER_INPUT"]);
    assert.match(answer.body.errors[0].message, /Idempotency-Key/);
    assert.equal(harness.engine.count("ConfirmQuote"), 0);
  });
});

describe("verifying a student", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.close();
  });

  const VERIFY = "mutation { verifyStudent { __typename ... on StudentVerification { verifiedOn validUntil provider valid } ... on Refusal { code reason } } }";

  test("a verification still valid comes back as it is, and nothing is written", async () => {
    const answer = await (await listener(harness, LISTENERS.verified)).graphql(VERIFY);
    assert.deepEqual(answer.body.data.verifyStudent, { __typename: "StudentVerification", verifiedOn: "2026-09-04", validUntil: "2027-09-04", provider: "simulated", valid: true });
    assert.equal(harness.engine.audit.length, 0);
  });

  test("a student not verified yet is verified by the simulated provider for 12 months, and the log says so", async () => {
    const student = await listener(harness, LISTENERS.unverified);
    const answer = await student.graphql(VERIFY);
    assert.deepEqual(answer.body.data.verifyStudent, { __typename: "StudentVerification", verifiedOn: "2026-10-24", validUntil: "2027-10-24", provider: "simulated", valid: true });
    const event = harness.engine.audit.at(-1);
    assert.deepEqual([event?.action, event?.actor, event?.actorRole], ["student.verified", "subscriber-5002", "subscriber"]);
    const entrance = await student.graphql("{ demoListeners { id studentVerified } }");
    assert.ok(entrance.body.data.demoListeners.some((entry: { id: string; studentVerified: boolean }) => entry.id === "5002" && entry.studentVerified));
  });

  test("the simulated provider finds no student record for the Free listener in France: a refusal, in the site's words", async () => {
    const answer = await (await listener(harness, LISTENERS.freeInFrance)).graphql(VERIFY);
    assert.deepEqual(answer.body.data.verifyStudent, {
      __typename: "Refusal", code: "NOT_ELIGIBLE", reason: "The student verification found no student record for you.",
    });
  });
});

describe("the engine's refusals, in the site's words and never the engine's", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
    moveTo(harness, MONDAY_26_OCTOBER);
    // A second student offer of the same non-combinability group, for anyone verified, taken once at most.
    harness.engine.published.push(create(PublishedOfferSchema, {
      offerId: "9003", version: 1, market: "IT", plan: "student", title: "Student Spring Pass", text: "Two months at a student price.",
      terms: "Verified students.", price: { amountMinor: 399n, currency: "EUR" }, listPrice: { amountMinor: 579n, currency: "EUR" }, monthsAtOfferPrice: 2,
      audience: "Verified students", needsStudentCheck: true,
    }));
    harness.engine.offerRules.set("9003", { neverPaid: false, group: "student", cap: 1 });
  });
  after(async () => {
    await harness.close();
  });

  const EXPIRED = "This quote has expired, or its offer is no longer on sale: ask for a new quote.";

  const refusal = async (client: Client, quoteId: string) => {
    const answer = await client.graphql(CONFIRM, { variables: { q: quoteId } });
    assert.equal(answer.body.errors, undefined, answer.text);
    return answer.body.data.confirmSubscription;
  };

  test("a quote of another listener is not found, and a malformed one is refused", async () => {
    const owner = await listener(harness, LISTENERS.verified);
    const theirs = await quote(owner, "9001");
    const other = await listener(harness, LISTENERS.unverified);
    assert.deepEqual(codes(await other.graphql(CONFIRM, { variables: { q: theirs } })), ["NOT_FOUND"]);
    assert.deepEqual(codes(await other.graphql(CONFIRM, { variables: { q: "not a quote" } })), ["BAD_USER_INPUT"]);
    assert.deepEqual(codes(await other.graphql(CONFIRM, { variables: { q: "q_tooshort" } })), ["BAD_USER_INPUT"], "the engine's own check");
  });

  test("a quote past its expiry is QUOTE_EXPIRED: ask for a new one", async () => {
    const student = await listener(harness, LISTENERS.verified);
    const quoteId = await quote(student, "9001");
    harness.clock.advance(16 * 60_000);
    const refreshed = await listener(harness, LISTENERS.verified);
    assert.deepEqual(await refusal(refreshed, quoteId), { __typename: "Refusal", code: "QUOTE_EXPIRED", reason: EXPIRED });
  });

  test("an offer no longer on sale is QUOTE_EXPIRED too", async () => {
    const student = await listener(harness, LISTENERS.verified);
    const quoteId = await quote(student, "9001");
    const kept = harness.engine.published.splice(0, 1);
    try {
      assert.deepEqual(await refusal(student, quoteId), { __typename: "Refusal", code: "QUOTE_EXPIRED", reason: EXPIRED });
    } finally {
      harness.engine.published.unshift(...kept);
    }
  });

  test("a visitor's quote, confirmed by a listener outside the audience, is NOT_ELIGIBLE", async () => {
    const visitor = harness.site();
    const quoteId = await quote(visitor, "9001");
    await visitor.signInAsListener(LISTENERS.paidBefore);
    // The offer's audience, in the words of its page: what the site shows anyway.
    assert.deepEqual(await refusal(visitor, quoteId), {
      __typename: "Refusal", code: "NOT_ELIGIBLE", reason: "It is for: verified students in Italy who have never had a paid plan.",
    });
  });

  test("asking for the quote signed in is already the listener's: the engine checks them then", async () => {
    const france = await listener(harness, LISTENERS.freeInFrance);
    harness.engine.clearCalls();
    const answer = await france.graphql('mutation { requestQuote(plan: "student", market: "IT", offerId: "9001") { __typename ... on Refusal { code reason } } }');
    // The engine said "Subscriber #5004 is in France, and this quote is for Italy.": the site says it without the number.
    assert.deepEqual(answer.body.data.requestQuote, { __typename: "Refusal", code: "NOT_ELIGIBLE", reason: "It is not sold in your market." });
    assert.equal((harness.engine.calls.find((call) => call.method === "GetQuote")?.message as { subscriberId: string }).subscriberId, "5004");
  });

  test("with a paid plan running, another subscription is ALREADY_SUBSCRIBED", async () => {
    const student = await listener(harness, LISTENERS.verified);
    const first = await quote(student, "9001");
    assert.equal((await refusal(student, first)).__typename, "Confirmation");
    const second = await quote(student, null, "family");
    assert.deepEqual(await refusal(student, second), {
      __typename: "Refusal", code: "ALREADY_SUBSCRIBED", reason: "A paid subscription of yours is already running.",
    });
  });

  test("a second offer of the same group is NOT_COMBINABLE, said without the group's name", async () => {
    const student = await listener(harness, LISTENERS.paidBefore);
    assert.equal((await refusal(student, await quote(student, "9003"))).__typename, "Confirmation");
    harness.engine.endPaidSubscription(LISTENERS.paidBefore);
    const answer = await refusal(student, await quote(student, "9003"));
    assert.deepEqual(answer, {
      __typename: "Refusal", code: "NOT_COMBINABLE",
      reason: "You already took an offer that does not combine with this one: offers of the same kind never stack (§10.3).",
    });
  });

  test("an offer taken as many times as its cap allows is CAP_REACHED, said without the cap", async () => {
    const student = await listener(harness, LISTENERS.unverified);
    await student.graphql("mutation { verifyStudent { __typename } }");
    const answer = await refusal(student, await quote(student, "9003"));
    assert.deepEqual(answer, { __typename: "Refusal", code: "CAP_REACHED", reason: "This offer has been taken as many times as it can be." });
  });
});
