// The prepaid passes (stage 7, §9 and §14.4), from both sides. In the
// console: the commercial lead writes one, a change of its own kind that
// finance signs for condition 1, and finance alone reads the value sold and
// not yet earned. On the site: the passes on sale in a market, a
// demonstration purchase whose code is PENDING until the provider settles its
// payment, the code activated by its buyer or by whoever was given it, and
// every refusal in the gateway's words. The fake engine follows the
// coordinator's behaviours for the engine's §14.4 service.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ChangeState, type PrepaidPassContent } from "contracts/commerce/v1/changes";
import { LISTENERS } from "./support/fake-engine.ts";
import { type Client, codes, type Harness, startHarness } from "./support/harness.ts";

const EUR = (amountMinor: string) => ({ amountMinor, currency: "EUR" });
const PASS = {
  title: "Three-month gift pass", plan: "individual", months: 3, prices: [{ market: "IT", amount: EUR("2999") }],
  periods: [{ market: "IT", startsLocal: "2026-12-01T00:00" }], codeValidMonths: 12,
  pages: [{ market: "IT", title: "Three-month gift pass", text: "Three months of Individual, paid once.", terms: "A single-use code. It never renews." }],
};
const CHANGE = `__typename ... on Change { id kind state currentVersion requiredSignatures { role conditions signed }
  current { content { __typename ... on PrepaidPassContent {
    title plan months prices { market amount } periods { market startsLocal endsLocal } codeValidMonths pages { market title text terms treatment }
  } } } }
  ... on Refusal { code reason }`;
const PAYMENT = "state amount provider requestedAt settledAt receipt { amount provider demonstration }";
const CODE = `code passId title plan market months price boughtAt validUntil state activatedOn payment { ${PAYMENT} }`;
const BUY = `mutation ($p: ID!) { buyPrepaidPass(passId: $p) { __typename ... on PrepaidPurchase { prepaidCode { ${CODE} } } ... on Refusal { code reason } } }`;
const SUBSCRIPTION = "plan market paid price startedOn billingDay nextBillingOn nextCharge endsOn prepaidCode prepaidPrice";
const ACTIVATE = `mutation ($c: String!) { activatePrepaidPass(code: $c) { __typename ... on Subscription { ${SUBSCRIPTION} } ... on Refusal { code reason } } }`;
const UNEARNED = "{ overview { prepaid { market sold activated expired unearned unearnedEur } prepaidUnearnedEur } }";

function moveTo(harness: Harness, iso: string): void {
  harness.clock.advance(Date.parse(iso) - harness.clock.now().getTime());
}

/** A new session: the clock moves by weeks here, further than a session lives. */
async function listener(harness: Harness, id: string): Promise<Client> {
  const client = harness.site();
  await client.signInAsListener(id);
  return client;
}

async function person(harness: Harness, id: string): Promise<Client> {
  const client = harness.console();
  await client.signIn(id);
  return client;
}

async function buy(client: Client, passId: string, key?: string) {
  const answer = await client.graphql(BUY, { variables: { p: passId }, ...(key ? { key } : {}) });
  assert.equal(answer.body.errors, undefined, answer.text);
  return answer.body.data.buyPrepaidPass;
}

async function activate(client: Client, code: string) {
  const answer = await client.graphql(ACTIVATE, { variables: { c: code } });
  assert.equal(answer.body.errors, undefined, answer.text);
  return answer.body.data.activatePrepaidPass;
}

async function codesOf(client: Client) {
  const answer = await client.graphql(`{ me { account { prepaidCodes { ${CODE} } } } }`);
  assert.equal(answer.body.errors, undefined, answer.text);
  return answer.body.data.me.account.prepaidCodes;
}

describe("writing a prepaid pass, in the console", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.close();
  });

  test("the commercial lead creates one: a change of its own kind, a fixed price, and finance's signature for condition 1 named at once", async () => {
    const lead = await person(harness, "commercial-lead-1");
    harness.engine.clearCalls();
    const answer = await lead.graphql(`mutation ($p: PrepaidPassInput!) { createPrepaidPass(pass: $p) { ${CHANGE} } }`, { variables: { p: PASS }, key: "create-pass-0001" });
    assert.equal(answer.body.errors, undefined, answer.text);
    const change = answer.body.data.createPrepaidPass;
    assert.deepEqual({ kind: change.kind, state: change.state, signatures: change.requiredSignatures }, {
      kind: "PREPAID", state: "DRAFT", signatures: [{ role: "FINANCE", conditions: [1], signed: false }],
    });
    assert.deepEqual(change.current.content, {
      __typename: "PrepaidPassContent", ...PASS, periods: [{ market: "IT", startsLocal: "2026-12-01T00:00", endsLocal: null }],
      pages: [{ ...PASS.pages[0], treatment: "standard" }],
    });
    const call = harness.engine.calls.find((candidate) => candidate.method === "CreateChange");
    assert.deepEqual([call?.actor, call?.role, call?.idempotencyKey], ["commercial-lead-1", "commercial_lead", "create-pass-0001"]);
    const sent = call?.message as { content: { case: string; value: PrepaidPassContent } };
    assert.equal(sent.content.case, "prepaid");
    assert.deepEqual(sent.content.value.prices.map((price) => [price.market, price.price.case, price.price.case === "fixed" ? price.price.value.amountMinor : null]),
      [["IT", "fixed", 2999n]], "the console can write a pass's price only as a fixed price");
  });

  test("a second version; marketing writes campaigns, not passes, and is refused before the engine", async () => {
    const lead = await person(harness, "commercial-lead-1");
    const created = await lead.graphql(`mutation ($p: PrepaidPassInput!) { createPrepaidPass(pass: $p) { ${CHANGE} } }`, { variables: { p: PASS } });
    const id = created.body.data.createPrepaidPass.id;
    const save = `mutation ($id: ID!, $p: PrepaidPassInput!) { savePrepaidPassVersion(changeId: $id, baseVersion: 1, pass: $p) { ${CHANGE} } }`;
    const saved = await lead.graphql(save, { variables: { id, p: { ...PASS, months: 6, prices: [{ market: "IT", amount: EUR("5499") }] } } });
    assert.equal(saved.body.errors, undefined, saved.text);
    assert.deepEqual([saved.body.data.savePrepaidPassVersion.currentVersion, saved.body.data.savePrepaidPassVersion.current.content.months], [2, 6]);
    const marketing = await person(harness, "marketing-1");
    harness.engine.clearCalls();
    const refused = await marketing.graphql(`mutation ($p: PrepaidPassInput!) { createPrepaidPass(pass: $p) { ${CHANGE} } }`, { variables: { p: PASS } });
    assert.equal(refused.body.data.createPrepaidPass.code, "ROLE_NOT_ALLOWED", refused.text);
    assert.equal(harness.engine.count("CreateChange"), 0);
  });

  test("an engine that sends a pass's price as a percentage breaks the contract: an error, never a price made up", async () => {
    const stored = harness.engine.seedPrepaidPass(ChangeState.DRAFT);
    const content = stored.versions[0]?.content as PrepaidPassContent;
    const first = content.prices[0];
    assert.ok(first);
    first.price = { case: "percentOffBp", value: 2_000 };
    const reader = await person(harness, "auditor-1");
    const answer = await reader.graphql(`query ($id: ID!) { change(id: $id) { current { content { ... on PrepaidPassContent { prices { amount } } } } } }`, {
      variables: { id: stored.id },
    });
    assert.deepEqual(codes(answer), ["INTERNAL_SERVER_ERROR"], answer.text);
  });
});

describe("the passes on sale, on the site", () => {
  let harness: Harness;
  let onSale: string;
  before(async () => {
    harness = await startHarness();
    onSale = harness.engine.seedPrepaidPass(ChangeState.ACTIVE).id;
    // Approved but not launched yet, and launched for a period still to come: not on sale.
    harness.engine.seedPrepaidPass(ChangeState.SCHEDULED, { title: "Not launched yet" });
    harness.engine.seedPrepaidPass(ChangeState.ACTIVE, { title: "Christmas gift pass", periods: [{ market: "IT", startsLocal: "2026-12-01T00:00" }] });
  });
  after(async () => {
    await harness.close();
  });

  test("lists, for anyone, the passes whose period holds now in the market, at the engine's price", async () => {
    const visitor = harness.site();
    const italy = await visitor.graphql('{ prepaidPasses(market: "IT") { id market title plan months price codeValidMonths text terms } }');
    assert.equal(italy.body.errors, undefined, italy.text);
    assert.deepEqual(italy.body.data.prepaidPasses, [{
      id: onSale, market: "IT", title: "Three-month gift pass", plan: "individual", months: 3, price: EUR("2999"), codeValidMonths: 12,
      text: "Three months of Individual, paid once: a code to keep, or to give.",
      terms: "A single-use code. It never renews, and price changes made after it was sold do not touch it.",
    }]);
    const france = await visitor.graphql('{ prepaidPasses(market: "FR") { id } }');
    assert.deepEqual(france.body.data.prepaidPasses, []);
    harness.engine.clearCalls();
    const malformed = await visitor.graphql("query ($m: MarketCode!) { prepaidPasses(market: $m) { id } }", { variables: { m: "italy" } });
    assert.deepEqual(codes(malformed), ["BAD_USER_INPUT"], "a market code that cannot be one");
    assert.equal(harness.engine.count("ListPrepaidPasses"), 0);
  });
});

describe("buying a pass and activating its code, on the site", () => {
  let harness: Harness;
  let passId: string;
  before(async () => {
    harness = await startHarness();
    passId = harness.engine.seedPrepaidPass(ChangeState.ACTIVE).id;
  });
  after(async () => {
    await harness.close();
  });

  test("bought: the code comes back PENDING with its payment, at the engine's price; the engine heard the session's listener and no person of the team", async () => {
    const buyer = await listener(harness, LISTENERS.unverified);
    harness.engine.clearCalls();
    const purchase = await buy(buyer, passId, "buy-pass-0001");
    assert.equal(purchase.__typename, "PrepaidPurchase");
    const code = purchase.prepaidCode;
    assert.match(code.code, /^[A-Z0-9-]{8,}$/);
    assert.deepEqual({ ...code, code: undefined }, {
      code: undefined, passId, title: "Three-month gift pass", plan: "individual", market: "IT", months: 3, price: EUR("2999"),
      boughtAt: "2026-10-24T08:00:00Z", validUntil: "2027-10-23", state: "PENDING", activatedOn: null,
      payment: { state: "PENDING", amount: EUR("2999"), provider: "simulated", requestedAt: "2026-10-24T08:00:00Z", settledAt: null, receipt: null },
    });
    const call = harness.engine.calls.find((candidate) => candidate.method === "BuyPrepaidPass");
    const sent = call?.message as { subscriberId: string; passId: string } | undefined;
    assert.deepEqual({ subscriberId: sent?.subscriberId, passId: sent?.passId }, { subscriberId: LISTENERS.unverified, passId });
    assert.deepEqual([call?.actor, call?.role, call?.idempotencyKey], [null, null, "buy-pass-0001"]);
  });

  test("the provider's answer makes the code READY, with a receipt that says no money moved; the account lists it", async () => {
    assert.equal(harness.engine.settlePayments(), 1);
    const buyer = await listener(harness, LISTENERS.unverified);
    const [code] = await codesOf(buyer);
    assert.equal(code.state, "READY");
    assert.deepEqual({ state: code.payment.state, settledAt: code.payment.settledAt, receipt: code.payment.receipt }, {
      state: "SUCCEEDED", settledAt: "2026-10-24T08:00:00Z", receipt: { amount: EUR("2999"), provider: "simulated", demonstration: true },
    });
  });

  test("given as a gift: another listener of the market activates it, the plan for its months, never charged, then the free plan", async () => {
    moveTo(harness, "2026-11-02T09:00:00Z");
    const [bought] = await codesOf(await listener(harness, LISTENERS.unverified));
    const friend = await listener(harness, LISTENERS.paidBefore);
    harness.engine.clearCalls();
    const subscription = await activate(friend, bought.code);
    assert.deepEqual(subscription, {
      __typename: "Subscription", plan: "individual", market: "IT", paid: true, price: EUR("0"), startedOn: "2026-11-02", billingDay: null,
      nextBillingOn: null, nextCharge: null, endsOn: "2027-02-02", prepaidCode: bought.code, prepaidPrice: EUR("2999"),
    });
    const call = harness.engine.calls.find((candidate) => candidate.method === "ActivatePrepaidPass");
    assert.deepEqual([(call?.message as { subscriberId: string }).subscriberId, call?.actor, call?.role], [LISTENERS.paidBefore, null, null]);
    // The same listener with the same code: the same answer, and one activation in the log, by the listener.
    assert.deepEqual(await activate(friend, bought.code), subscription);
    const activations = harness.engine.audit.filter((event) => event.action === "prepaid.activated");
    assert.deepEqual(activations.map((event) => event.actor), [`subscriber-${LISTENERS.paidBefore}`]);
    // The buyer sees the code used, on that day, and not who used it.
    const [used] = await codesOf(await listener(harness, LISTENERS.unverified));
    assert.deepEqual([used.state, used.activatedOn], ["ACTIVATED", "2026-11-02"]);
    // The account of the one who activated it says when the pass ends.
    const account = await friend.graphql("{ me { account { subscription { plan price endsOn prepaidCode nextCharge } } } }");
    assert.deepEqual(account.body.data.me.account.subscription, { plan: "individual", price: EUR("0"), endsOn: "2027-02-02", prepaidCode: bought.code, nextCharge: null });
  });

  test("the code once used, by anyone else: refused in the site's words, never the engine's", async () => {
    const [used] = await codesOf(await listener(harness, LISTENERS.unverified));
    const buyer = await listener(harness, LISTENERS.unverified);
    const reply = await buyer.graphql(ACTIVATE, { variables: { c: used.code } });
    assert.deepEqual(reply.body.data.activatePrepaidPass, {
      __typename: "Refusal", code: "CODE_NOT_USABLE",
      reason: "This code cannot be activated: its payment has not gone through, it has been used, or its time to be activated has ended.",
    });
    assert.ok(!/Code \d+ is/.test(reply.text), reply.text);
  });
});

describe("the refusals of a purchase and of an activation", () => {
  let harness: Harness;
  let passId: string;
  before(async () => {
    harness = await startHarness();
    passId = harness.engine.seedPrepaidPass(ChangeState.ACTIVE).id;
  });
  after(async () => {
    await harness.close();
  });

  test("a pass not sold in the buyer's market: NOT_ELIGIBLE; an unknown one is not found; a malformed id never reaches the engine", async () => {
    const france = await listener(harness, LISTENERS.freeInFrance);
    const reply = await france.graphql(BUY, { variables: { p: passId } });
    assert.deepEqual(reply.body.data.buyPrepaidPass, { __typename: "Refusal", code: "NOT_ELIGIBLE", reason: "This pass is not sold in your market." });
    assert.ok(!reply.text.includes("France"), "the engine's own sentence names the market and the pass's number");
    const unknown = await france.graphql(BUY, { variables: { p: "999999" } });
    assert.deepEqual(codes(unknown), ["NOT_FOUND"]);
    assert.equal(unknown.body.errors[0].message, "Not found.");
    harness.engine.clearCalls();
    for (const id of ["0", "-1", "pass-1"]) assert.deepEqual(codes(await france.graphql(BUY, { variables: { p: id } })), ["BAD_USER_INPUT"], id);
    assert.equal(harness.engine.count("BuyPrepaidPass"), 0);
  });

  test("a code of another market, a listener already paying, a code whose payment is pending or failed: each in the site's words", async () => {
    const buyer = await listener(harness, LISTENERS.verified);
    const pending = (await buy(buyer, passId)).prepaidCode.code;
    // Pending: its payment is not settled.
    const unverified = await listener(harness, LISTENERS.unverified);
    assert.equal((await activate(unverified, pending)).code, "CODE_NOT_USABLE");
    // Another market's listener.
    assert.equal(harness.engine.settlePayments(), 1);
    const france = await listener(harness, LISTENERS.freeInFrance);
    assert.deepEqual(await activate(france, pending), { __typename: "Refusal", code: "NOT_ELIGIBLE", reason: "This code is for a pass of another market." });
    // A listener already paying: the verified student subscribes to Student first.
    const quoted = await buyer.graphql('mutation { requestQuote(plan: "student", market: "IT") { __typename ... on Quote { id } } }');
    const confirmed = await buyer.graphql("mutation ($q: ID!) { confirmSubscription(quoteId: $q) { __typename } }", { variables: { q: quoted.body.data.requestQuote.id } });
    assert.equal(confirmed.body.data.confirmSubscription.__typename, "Confirmation", confirmed.text);
    assert.deepEqual(await activate(buyer, pending), {
      __typename: "Refusal", code: "ALREADY_SUBSCRIBED", reason: "A paid subscription of yours is already running: a prepaid pass can be activated once it has ended.",
    });
    // A payment the provider declined: the code is FAILED, and cannot be activated.
    const declined = (await buy(buyer, passId)).prepaidCode.code;
    assert.equal(harness.engine.settlePayments("failed"), 2, "the Student subscription's first month and the second code's payment");
    assert.equal((await activate(unverified, declined)).code, "CODE_NOT_USABLE");
    const states = (await codesOf(buyer)).map((code: { code: string; state: string }) => [code.code, code.state]);
    assert.deepEqual(states, [[declined, "FAILED"], [pending, "READY"]], "the latest first");
  });

  test("an unknown code is not found; a malformed one never reaches the engine", async () => {
    const unverified = await listener(harness, LISTENERS.unverified);
    const unknown = await unverified.graphql(ACTIVATE, { variables: { c: "GIFT-0000-0000-0000" } });
    assert.deepEqual(codes(unknown), ["NOT_FOUND"]);
    assert.equal(unknown.body.errors[0].message, "Not found.");
    harness.engine.clearCalls();
    for (const code of ["", "GIFT 0000", "x".repeat(101)]) {
      assert.deepEqual(codes(await unverified.graphql(ACTIVATE, { variables: { c: code } })), ["BAD_USER_INPUT"], JSON.stringify(code));
    }
    assert.equal(harness.engine.count("ActivatePrepaidPass"), 0);
  });

  test("a code not activated by its last day expires: the account says so, and it cannot be activated", async () => {
    const shortLived = harness.engine.seedPrepaidPass(ChangeState.ACTIVE, { title: "One-month code", codeValidMonths: 1 }).id;
    const buyer = await listener(harness, LISTENERS.unverified);
    const code = (await buy(buyer, shortLived)).prepaidCode;
    assert.equal(code.validUntil, "2026-11-23");
    harness.engine.settlePayments();
    moveTo(harness, "2026-11-24T09:00:00Z");
    const later = await listener(harness, LISTENERS.unverified);
    const [expired] = await codesOf(later);
    assert.deepEqual([expired.code, expired.state], [code.code, "EXPIRED"]);
    assert.equal((await activate(later, code.code)).code, "CODE_NOT_USABLE");
  });
});

describe("buying and activating, as the site's other mutations", () => {
  let harness: Harness;
  let passId: string;
  before(async () => {
    harness = await startHarness();
    passId = harness.engine.seedPrepaidPass(ChangeState.ACTIVE).id;
  });
  after(async () => {
    await harness.close();
  });

  test("need the session, its CSRF token and an Idempotency-Key; the engine hears nothing without them", async () => {
    harness.engine.clearCalls();
    const visitor = harness.site();
    assert.deepEqual(codes(await visitor.graphql(BUY, { variables: { p: passId } })), ["UNAUTHENTICATED"]);
    assert.deepEqual(codes(await visitor.graphql(ACTIVATE, { variables: { c: "GIFT-0000-0000-0000" } })), ["UNAUTHENTICATED"]);
    const buyer = await listener(harness, LISTENERS.unverified);
    const token = buyer.csrf;
    buyer.csrf = null;
    assert.equal((await buyer.graphql(BUY, { variables: { p: passId } })).status, 403);
    buyer.csrf = token;
    assert.deepEqual(codes(await buyer.graphql(BUY, { variables: { p: passId }, key: false })), ["BAD_USER_INPUT"]);
    assert.deepEqual(codes(await buyer.graphql(ACTIVATE, { variables: { c: "GIFT-0000-0000-0000" }, key: false })), ["BAD_USER_INPUT"]);
    assert.equal(harness.engine.count("BuyPrepaidPass") + harness.engine.count("ActivatePrepaidPass"), 0);
  });

  test("a purchase retried with the same Idempotency-Key gets the same code, and buys one", async () => {
    const buyer = await listener(harness, LISTENERS.unverified);
    const first = await buy(buyer, passId, "buy-pass-retry-0001");
    const retry = await buy(buyer, passId, "buy-pass-retry-0001");
    assert.deepEqual(retry, first);
    assert.equal((await codesOf(buyer)).length, 1);
  });
});

describe("the value of prepaid passes sold and not yet earned, for finance (§9.2)", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.close();
  });

  const unearned = async () => {
    const finance = await person(harness, "finance-1");
    const answer = await finance.graphql(UNEARNED);
    assert.equal(answer.body.errors, undefined, answer.text);
    return answer.body.data.overview;
  };

  test("an Italian pass, net €24.58, is earned as €8.19, €8.19 and €8.20 from its activation; a code not used stays unearned", async () => {
    assert.deepEqual(await unearned(), { prepaid: [], prepaidUnearnedEur: EUR("0") });
    const passId = harness.engine.seedPrepaidPass(ChangeState.ACTIVE).id;
    const buyer = await listener(harness, LISTENERS.unverified);
    const gift = (await buy(buyer, passId)).prepaidCode.code;
    await buy(buyer, passId);
    // Not paid yet: not sold.
    assert.deepEqual((await unearned()).prepaid, []);
    harness.engine.settlePayments();
    assert.deepEqual(await unearned(), {
      prepaid: [{ market: "IT", sold: 2, activated: 0, expired: 0, unearned: EUR("4916"), unearnedEur: EUR("4916") }], prepaidUnearnedEur: EUR("4916"),
    });
    // Activated on 2 November: its first month is earned that day.
    moveTo(harness, "2026-11-02T09:00:00Z");
    await activate(await listener(harness, LISTENERS.paidBefore), gift);
    const rows = async () => (await unearned()).prepaid[0];
    assert.deepEqual(await rows(), { market: "IT", sold: 2, activated: 1, expired: 0, unearned: EUR("4097"), unearnedEur: EUR("4097") });
    // 2458 + 1639: the code not used, and the activated one less €8.19.
    moveTo(harness, "2026-12-02T09:00:00Z");
    assert.deepEqual((await rows()).unearned, EUR("3278"), "less a second €8.19");
    moveTo(harness, "2027-01-02T09:00:00Z");
    assert.deepEqual((await rows()).unearned, EUR("2458"), "the last part, €8.20, earned: only the code not used is left");
  });

  test("a code not used by its last day expires, and leaves the value not yet earned", async () => {
    // The code bought above and never used is valid for 12 months from 24 October 2026.
    moveTo(harness, "2027-10-24T09:00:00Z");
    assert.deepEqual(await unearned(), {
      prepaid: [{ market: "IT", sold: 2, activated: 1, expired: 1, unearned: EUR("0"), unearnedEur: EUR("0") }], prepaidUnearnedEur: EUR("0"),
    });
  });
});
