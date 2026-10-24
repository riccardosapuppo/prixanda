// The engine and the gateway together, on the Student Autumn Pass of the
// business book's §14.1, from a draft to the subscription of a student on the
// site.
//
// Run by tools/check.ts (suite integration), which hands it a database cloned
// from the migrated template and filled with the small generated data (seed
// 7). Everything else this file starts and stops itself: the real engine, on
// a clock the test moves (services/commerce/tests/clocked_server.py, the
// test's launcher of the same serve() the server runs), and the real gateway
// in front of it. Every step goes through HTTP only, as the console and the
// site will: GraphQL, the session cookie, the CSRF token, Idempotency-Key and
// X-Request-Id.
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { commerceDir, PORTS, venvPython } from "../../../../tools/lib/paths.ts";
import { loadConfig } from "../../src/node/config.ts";
import { type Gateway, startGateway } from "../../src/node/gateway.ts";
import { connectEngine, type EngineConnection } from "../../src/node/grpc.ts";
import { createLogger } from "../../src/node/log.ts";
import { SITE_COOKIE } from "../../src/node/sessions.ts";
import { assertPortsFree, Client, codes, CONSOLE_ORIGIN, SITE_ORIGIN, TestClock } from "../support/harness.ts";

const DATABASE_URL = process.env["INTEGRATION_DATABASE_URL"] ?? "";
const SUMMARY = process.env["INTEGRATION_SUMMARY"] ?? "";
/** The engine's clock when the test starts: the last day of the generated data, two days before the pass starts. */
const START = "2026-10-24T10:00:00Z";
/** 09:00 in Rome on 26 October is 08:00 UTC: the clocks went back the night before (§3.7). */
const PAST_THE_START = "2026-10-26T08:00:05Z";
const ACTIVATION_INTERVAL_SECONDS = 0.5;

const OFFER = {
  title: "Student Autumn Pass",
  plan: "student",
  audience: { segment: "NEVER_PAID", needsStudentCheck: true },
  prices: [{ market: "IT", fixed: { amountMinor: "299", currency: "EUR" } }],
  monthsAtOfferPrice: 3,
  periods: [{ market: "IT", startsLocal: "2026-10-26T09:00", endsLocal: "2026-11-30T00:00" }],
  nonCombinabilityGroup: "student-offers",
  pages: [{ market: "IT", title: "Student Autumn Pass", text: "Three months of Student for 2,99 €.", terms: "New subscribers only. One pass per verified student.", treatment: "autumn" }],
};
const SAVED = { ...OFFER, pages: [{ ...OFFER.pages[0], text: "Three months of Student for 2,99 €, then the Student price." }] };

const CHANGE = `__typename ... on Change { id state currentVersion sentence createdBy { id }
  current { version fingerprint } versions { version fingerprint }
  validation { valid eligible findings { check severity } }
  requiredSignatures { role conditions signed why } approvals { approver { id } role fingerprint } }
  ... on Refusal { code reason facts { name value } }`;

const SUBSCRIPTION = "plan market paid price startedOn billingDay offerTitle offerMonths offerMonthsLeft fullPriceFrom fullPrice nextBillingOn nextCharge";
const PAYMENT = "state amount provider requestedAt settledAt receipt { amount provider providerReference demonstration note }";
const EUR = (amountMinor: string) => ({ amountMinor, currency: "EUR" });

/** The engine as a child process, its log lines read as they come, its clock moved through its standard input. */
type Engine = {
  process: ChildProcessWithoutNullStreams;
  log: Array<Record<string, unknown>>;
  exited: Promise<number | null>;
  /** Moves the engine's clock, and resolves when the engine says it has. */
  at(instant: string): Promise<void>;
  stop(): Promise<number | null>;
};

async function startEngine(token: string): Promise<Engine> {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("COMMERCE_")) env[name] = value;
  const child = spawn(venvPython, [join(commerceDir, "tests", "clocked_server.py"), START], {
    cwd: commerceDir,
    windowsHide: true,
    env: {
      ...env,
      PYTHONPATH: join(commerceDir, "src"),
      PYTHONIOENCODING: "utf-8",
      COMMERCE_DATABASE_URL: DATABASE_URL,
      COMMERCE_INTERNAL_TOKEN: token,
      COMMERCE_ENGINE_HOST: "127.0.0.1",
      COMMERCE_ENGINE_PORT: String(PORTS.engineCheck),
      COMMERCE_ACTIVATION_INTERVAL_SECONDS: String(ACTIVATION_INTERVAL_SECONDS),
      COMMERCE_HEALTH_INTERVAL_SECONDS: "1",
      COMMERCE_SHUTDOWN_GRACE_SECONDS: "2",
    },
  });
  const log: Array<Record<string, unknown>> = [];
  const waiting = new Map<string, () => void>();
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let errors = "";
  let acks = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
    const lines = errors.split("\n");
    errors = lines.pop() ?? "";
    // The engine writes JSON lines; gRPC's own library may add a plain one (a warning at shutdown).
    for (const line of lines) {
      const text = line.trim();
      if (text) log.push(text.startsWith("{") ? JSON.parse(text) as Record<string, unknown> : { raw: text });
    }
  });
  child.stdout.on("data", (chunk: string) => {
    acks += chunk;
    const lines = acks.split("\n");
    acks = lines.pop() ?? "";
    for (const line of lines) {
      const instant = /^clock (\S+)$/.exec(line.trim())?.[1];
      if (instant) waiting.get(instant)?.();
    }
  });
  try {
    const listening = await until(() => log.find((entry) => entry["event"] === "listening"), 60_000, exited, () => JSON.stringify(log));
    assert.equal(listening["address"], `127.0.0.1:${PORTS.engineCheck}`);
  } catch (error) {
    // An engine that did not come up is not left running behind the test.
    if (child.exitCode === null) child.kill();
    await exited;
    throw error;
  }
  return {
    process: child,
    log,
    exited,
    at(instant) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(instant);
          reject(new Error(`the engine did not move its clock to ${instant}`));
        }, 10_000);
        waiting.set(instant, () => {
          clearTimeout(timer);
          waiting.delete(instant);
          resolve();
        });
        child.stdin.write(`at ${instant}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null) return child.exitCode;
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 15_000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

/** What `find` returns once it returns something, polling; fails when the time is up or the process ended. */
async function until<T>(find: () => T | undefined, ms: number, ended: Promise<unknown>, what: () => string): Promise<T> {
  const deadline = performance.now() + ms;
  let gone = false;
  void ended.then(() => (gone = true));
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (gone) throw new Error(`the engine ended: ${what()}`);
    if (performance.now() > deadline) throw new Error(`not in ${ms} ms: ${what()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let engine: Engine | null = null;
let connection: EngineConnection | null = null;
let gateway: Gateway | null = null;
/** The console's people, each in a browser of their own: cookie and CSRF token kept. */
let people: Record<"marketing" | "lead" | "finance" | "auditor", Client>;
/** What the steps hand each other. */
const state = {
  changeId: "",
  fingerprints: [] as string[],
  requestIds: {} as Record<string, string>,
  activationMs: Number.NaN,
  auditEvents: 0,
  /** What the student of step h pays, as the engine confirmed it and the log has it. */
  subscription: null as null | { price: string; months: number; fullPrice: string; fullPriceFrom: string; payment: string; logged: boolean },
};

function client(endpoint: "internal" | "public"): Client {
  const url = endpoint === "internal" ? gateway?.internal?.url : gateway?.public?.url;
  if (!url) throw new Error("the gateway is not running");
  return endpoint === "internal" ? new Client(url) : new Client(url, SITE_COOKIE);
}

/** A request id of this test, kept to be found again in the audit log. */
function requestId(step: string): string {
  const id = `it-${step}-${randomUUID().slice(0, 8)}`;
  state.requestIds[step] = id;
  return id;
}

describe("the Student Autumn Pass through the engine and the gateway (§14.1)", () => {
  before(async () => {
    assert.ok(DATABASE_URL.startsWith("postgresql://"), "INTEGRATION_DATABASE_URL names the database tools/check.ts prepared");
    await assertPortsFree([PORTS.engineCheck, PORTS.gatewayCheckInternal, PORTS.gatewayCheckPublic]);
    const token = randomBytes(32).toString("hex");
    engine = await startEngine(token);
    const clock = new TestClock(START);
    const config = await loadConfig({
      COMMERCE_INTERNAL_TOKEN: token,
      ENGINE_URL: `http://127.0.0.1:${PORTS.engineCheck}`,
      GATEWAY_SESSION_SECRET: randomBytes(32).toString("hex"),
      GATEWAY_INTERNAL_PORT: String(PORTS.gatewayCheckInternal),
      GATEWAY_PUBLIC_PORT: String(PORTS.gatewayCheckPublic),
      GATEWAY_CONSOLE_ORIGINS: CONSOLE_ORIGIN,
      GATEWAY_SITE_ORIGINS: SITE_ORIGIN,
    }, join(tmpdir(), "integration-writes-nothing"));
    const engineConnection = connectEngine(config.engineUrl, config.engineToken);
    connection = engineConnection;
    gateway = await startGateway(config, {
      engine: engineConnection.client,
      engineHealth: () => engineConnection.health(),
      logger: createLogger({ clock: clock.now, write: () => {} }),
      clock: clock.now,
      monotonic: clock.monotonic,
    });
    people = { marketing: client("internal"), lead: client("internal"), finance: client("internal"), auditor: client("internal") };
    await people.marketing.signIn("marketing-1");
    await people.lead.signIn("commercial-lead-1");
    await people.finance.signIn("finance-1");
    await people.auditor.signIn("auditor-1");
  });

  after(async () => {
    await gateway?.close();
    connection?.close();
    const code = await engine?.stop();
    if (SUMMARY) {
      await writeFile(SUMMARY, JSON.stringify({ ...state, engineExit: code ?? null, activationMs: Number.isNaN(state.activationMs) ? null : state.activationMs }));
    }
    assert.equal(code, 0, "the engine stops in order");
  });

  test("a. marketing creates the pass, saves a second version, validates it and submits it; finance must sign", async () => {
    const created = await people.marketing.graphql(`mutation ($o: OfferInput!) { createOffer(offer: $o) { ${CHANGE} } }`, {
      variables: { o: OFFER }, headers: { "x-request-id": requestId("create") },
    });
    const change = created.body.data.createOffer;
    assert.equal(change.__typename, "Change", created.text);
    assert.deepEqual({ state: change.state, version: change.currentVersion, author: change.createdBy.id }, { state: "DRAFT", version: 1, author: "marketing-1" });
    state.changeId = change.id;
    state.fingerprints.push(change.current.fingerprint);

    const saved = await people.marketing.graphql(`mutation ($id: ID!, $o: OfferInput!) { saveOfferVersion(changeId: $id, baseVersion: 1, offer: $o) { ${CHANGE} } }`, {
      variables: { id: state.changeId, o: SAVED }, headers: { "x-request-id": requestId("save") },
    });
    const second = saved.body.data.saveOfferVersion;
    assert.equal(second.currentVersion, 2, saved.text);
    assert.notEqual(second.current.fingerprint, state.fingerprints[0], "a new version, a new fingerprint");
    state.fingerprints.push(second.current.fingerprint);

    const validated = await people.marketing.graphql(`mutation ($id: ID!) { validateChange(changeId: $id, version: 2) { ${CHANGE} } }`, {
      variables: { id: state.changeId }, headers: { "x-request-id": requestId("validate") },
    });
    const valid = validated.body.data.validateChange;
    assert.equal(valid.state, "VALIDATED", validated.text);
    assert.equal(valid.validation.valid, true);
    assert.ok(valid.validation.eligible >= 1, `eligible people counted in the data: ${valid.validation.eligible}`);
    // §6.5: the difference in business words, with the count from the data.
    assert.match(valid.sentence, new RegExp(`^Italy, Student: from €5\\.79 to €2\\.99 for 3 months, new subscribers only; ${valid.validation.eligible.toLocaleString("en")} eligible; conflicts: none\\.$`));
    // §7.3, condition 2: the price is under the Italian floor (€6.10), so finance must sign. With
    // the generated audience the simulated contribution is negative too (condition 4), which is
    // why the submission below carries the author's reason.
    const [signature, ...others] = valid.requiredSignatures as Array<{ role: string; conditions: number[]; signed: boolean }>;
    assert.deepEqual(others, []);
    assert.deepEqual({ role: signature?.role, signed: signature?.signed }, { role: "FINANCE", signed: false });
    assert.ok(signature?.conditions.includes(2), `the floor's condition: ${JSON.stringify(signature?.conditions)}`);
    assert.deepEqual(signature?.conditions.filter((condition) => ![2, 3, 4].includes(condition)), [], "an offer raises conditions 2 to 4 only");

    const submitted = await people.marketing.graphql(`mutation ($id: ID!) { submitChange(changeId: $id, version: 2, authorReason: "We are buying students for the autumn.") { ${CHANGE} } }`, {
      variables: { id: state.changeId }, headers: { "x-request-id": requestId("submit") },
    });
    assert.equal(submitted.body.data.submitChange.state, "IN_APPROVAL", submitted.text);
  });

  test("b. marketing cannot approve, and the commercial lead's signature is not the one it needs", async () => {
    const own = await people.marketing.graphql(`mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 2, fingerprint: $fp) { ${CHANGE} } }`, {
      variables: { id: state.changeId, fp: state.fingerprints[1] },
    });
    assert.equal(own.body.data.approveChange.__typename, "Refusal", own.text);
    assert.equal(own.body.data.approveChange.code, "ROLE_NOT_ALLOWED");
    const lead = await people.lead.graphql(`mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 2, fingerprint: $fp) { ${CHANGE} } }`, {
      variables: { id: state.changeId, fp: state.fingerprints[1] },
    });
    const refusal = lead.body.data.approveChange;
    assert.equal(refusal.code, "ROLE_NOT_ALLOWED", lead.text);
    assert.ok(refusal.facts.some((fact: { name: string; value: string }) => fact.name === "needs" && fact.value === "finance"), JSON.stringify(refusal.facts));
  });

  test("c. finance: the first version's fingerprint is refused; the exact one approves", async () => {
    const old = await people.finance.graphql(`mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 2, fingerprint: $fp) { ${CHANGE} } }`, {
      variables: { id: state.changeId, fp: state.fingerprints[0] },
    });
    assert.equal(old.body.data.approveChange.code, "FINGERPRINT_MISMATCH", old.text);
    const approved = await people.finance.graphql(`mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 2, fingerprint: $fp) { ${CHANGE} } }`, {
      variables: { id: state.changeId, fp: state.fingerprints[1] }, headers: { "x-request-id": requestId("approve") },
    });
    const change = approved.body.data.approveChange;
    assert.equal(change.state, "APPROVED", approved.text);
    assert.deepEqual(change.approvals, [{ approver: { id: "finance-1" }, role: "FINANCE", fingerprint: state.fingerprints[1] }]);
  });

  test("d. marketing schedules it; past 09:00 in Rome the engine activates it and the site shows it", async () => {
    assert.ok(engine);
    const scheduled = await people.marketing.graphql(`mutation ($id: ID!) { scheduleChange(changeId: $id) { ${CHANGE} } }`, {
      variables: { id: state.changeId }, headers: { "x-request-id": requestId("schedule") },
    });
    assert.equal(scheduled.body.data.scheduleChange.state, "SCHEDULED", scheduled.text);
    const site = client("public");
    const offers = async () => (await site.graphql('{ offers(market: "IT") { id } }')).body.data.offers as Array<{ id: string }>;
    // Two minutes before the start the activation has nothing to do.
    await engine.at("2026-10-26T07:58:00Z");
    await new Promise((resolve) => setTimeout(resolve, ACTIVATION_INTERVAL_SECONDS * 3_000));
    assert.deepEqual(await offers(), []);
    const early = await people.marketing.graphql(`{ change(id: "${state.changeId}") { state } }`);
    assert.equal(early.body.data.change.state, "SCHEDULED");
    // Past the start: the activation runs on its next tick, and the site sees the offer.
    await engine.at(PAST_THE_START);
    const moved = performance.now();
    for (;;) {
      const listed = await offers();
      if (listed.some((offer) => offer.id === state.changeId)) break;
      if (performance.now() - moved > 20_000) throw new Error("the site did not show the offer in 20 s");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    state.activationMs = Math.round(performance.now() - moved);
    const active = await people.marketing.graphql(`{ change(id: "${state.changeId}") { state } }`);
    assert.equal(active.body.data.change.state, "ACTIVE");
    assert.ok(engine.log.some((entry) => entry["event"] === "activation" && entry["action"] === "activated" && String(entry["change"]) === state.changeId),
      "the engine's log says it activated the change");
  });

  test("e. the site: the pass in Italy at €2.99 with €5.79 struck through, and a quote of €2.99 for 3 months, then €5.79", async () => {
    const site = client("public");
    const breakdown = "breakdown { price net artists topUp }";
    const listed = await site.graphql(`{ offers(market: "IT") { id plan title price listPrice monthsAtOfferPrice needsStudentCheck audience takeableUntil { local utc } ${breakdown} } }`);
    assert.equal(listed.body.errors, undefined, listed.text);
    const offer = listed.body.data.offers.find((candidate: { id: string }) => candidate.id === state.changeId);
    assert.ok(offer, listed.text);
    assert.deepEqual(
      { plan: offer.plan, title: offer.title, price: offer.price, listPrice: offer.listPrice, months: offer.monthsAtOfferPrice, student: offer.needsStudentCheck, until: offer.takeableUntil },
      { plan: "student", title: "Student Autumn Pass", price: { amountMinor: "299", currency: "EUR" }, listPrice: { amountMinor: "579", currency: "EUR" }, months: 3, student: true, until: { local: "2026-11-30T00:00", utc: "2026-11-29T23:00:00Z" } },
    );
    assert.equal(offer.audience, "Verified students in Italy who have never had a paid plan");
    // Where the price goes (§1.2, §5). The engine of stage 5 sends no breakdown with its offers, and the site reads null;
    // from stage 6, the §14.1 numbers: of the artists' €3.00, €1.47 from the subscriber and €1.53 from the service.
    if (offer.breakdown !== null) {
      assert.deepEqual(offer.breakdown, { price: EUR("299"), net: EUR("245"), artists: EUR("300"), topUp: EUR("153") });
    }
    const catalog = await site.graphql(`{ markets { code vatBasisPoints artistsMinimum } plans(market: "IT") { code ${breakdown} } }`);
    assert.equal(catalog.body.errors, undefined, catalog.text);
    assert.deepEqual(catalog.body.data.markets.find((market: { code: string }) => market.code === "IT"), { code: "IT", vatBasisPoints: 2200, artistsMinimum: EUR("300") });
    // §5.5: the Student price in Italy, €5.79, is €4.75 net; its pool of €2.85 gets €0.15 more to reach the €3.00.
    assert.deepEqual(catalog.body.data.plans.find((plan: { code: string }) => plan.code === "student").breakdown,
      { price: EUR("579"), net: EUR("475"), artists: EUR("300"), topUp: EUR("15") });
    // A visitor not signed in: the engine quotes, and checks who they are when they subscribe (stage 5).
    const quoted = await site.graphql(`mutation ($offer: ID!) { requestQuote(plan: "student", market: "IT", offerId: $offer) {
      __typename ... on Quote { id price listPrice monthsAtPrice thenPrice expiresAt offerId } ... on Refusal { code reason } } }`, { variables: { offer: state.changeId } });
    const quote = quoted.body.data.requestQuote;
    assert.equal(quote.__typename, "Quote", quoted.text);
    assert.deepEqual(
      { price: quote.price, months: quote.monthsAtPrice, then: quote.thenPrice, list: quote.listPrice, offer: quote.offerId },
      { price: { amountMinor: "299", currency: "EUR" }, months: 3, then: { amountMinor: "579", currency: "EUR" }, list: { amountMinor: "579", currency: "EUR" }, offer: state.changeId },
    );
    assert.ok(quote.expiresAt > PAST_THE_START, `the quote expires after the engine's now: ${quote.expiresAt}`);
  });

  test("f. the auditor finds every step in the log, with the request id the console sent, and the chain holds", async () => {
    const answer = await people.auditor.graphql(`query ($subject: String!) { auditEvents(filter: { subject: $subject }, first: 50) {
      nodes { action actor actorRole requestId } } }`, { variables: { subject: `change:${state.changeId}` } });
    const events = [...answer.body.data.auditEvents.nodes].reverse() as Array<{ action: string; actor: string; actorRole: string; requestId: string }>;
    assert.deepEqual(events.map((event) => event.action), [
      "change.created", "change.version_saved", "change.validated", "change.submitted", "change.approved", "change.scheduled", "change.activated",
    ], answer.text);
    const sent: Record<string, string> = {
      "change.created": "create", "change.version_saved": "save", "change.validated": "validate", "change.submitted": "submit",
      "change.approved": "approve", "change.scheduled": "schedule",
    };
    for (const event of events) {
      const step = sent[event.action];
      if (step) assert.equal(event.requestId, state.requestIds[step], `${event.action} carries the console's request id`);
    }
    const activation = events.at(-1);
    assert.deepEqual({ actor: activation?.actor, role: activation?.actorRole }, { actor: "activation", role: "SYSTEM" });
    assert.match(activation?.requestId ?? "", /^activation-/);
    const actors = events.slice(0, -1).map((event) => `${event.actor} ${event.actorRole}`);
    assert.deepEqual(actors, ["marketing-1 MARKETING", "marketing-1 MARKETING", "marketing-1 MARKETING", "marketing-1 MARKETING", "finance-1 FINANCE", "marketing-1 MARKETING"]);
    state.auditEvents = events.length;

    const exported = await people.auditor.graphql("mutation { exportAuditHead { __typename ... on ChainHead { seq hash } } }");
    const head = exported.body.data.exportAuditHead;
    assert.equal(head.__typename, "ChainHead", exported.text);
    const verified = await people.auditor.graphql("query ($anchor: ChainHeadInput) { verifyAuditChain(anchor: $anchor) { ok events brokenAt why } }", {
      variables: { anchor: { seq: head.seq, hash: head.hash } },
    });
    assert.deepEqual({ ok: verified.body.data.verifyAuditChain.ok, broken: verified.body.data.verifyAuditChain.brokenAt }, { ok: true, broken: null }, verified.text);
    assert.ok(verified.body.data.verifyAuditChain.events >= events.length);
  });

  test("g. idempotency: the same key and request give the same answer; the same key for another request is BAD_USER_INPUT", async () => {
    const key = `it-key-${randomUUID()}`;
    const spring = { ...OFFER, title: "Student Spring Pass", periods: [{ market: "IT", startsLocal: "2027-03-01T09:00", endsLocal: "2027-04-01T00:00" }] };
    const count = async () => (await people.marketing.graphql('{ changes(filter: { kind: OFFER }, first: 100) { nodes { id } } }')).body.data.changes.nodes.length as number;
    const before = await count();
    const first = await people.marketing.graphql(`mutation ($o: OfferInput!) { createOffer(offer: $o) { ${CHANGE} } }`, { variables: { o: spring }, key });
    const again = await people.marketing.graphql(`mutation ($o: OfferInput!) { createOffer(offer: $o) { ${CHANGE} } }`, { variables: { o: spring }, key });
    assert.equal(first.body.data.createOffer.__typename, "Change", first.text);
    assert.deepEqual(again.body.data, first.body.data);
    assert.equal(await count(), before + 1, "one change, however many times it was asked");
    const other = await people.marketing.graphql(`mutation ($o: OfferInput!) { createOffer(offer: $o) { ${CHANGE} } }`, { variables: { o: { ...spring, title: "Another" } }, key });
    assert.deepEqual(codes(other), ["BAD_USER_INPUT"], other.text);
    assert.equal(await count(), before + 1);
  });

  test("h. on the site, the verified student of the demo subscribes: €2.99 on 26 October, November and December, €5.79 from 26 January 2027; the log shows it", async () => {
    const site = client("public");
    const entrance = await site.graphql("{ demoListeners { id title market plan studentVerified } }");
    const student = (entrance.body.data.demoListeners as Array<{ id: string; title: string; market: string; plan: string; studentVerified: boolean }>)
      .find((listener) => listener.title === "Student in Italy, verified");
    assert.ok(student, entrance.text);
    assert.deepEqual({ market: student.market, plan: student.plan, verified: student.studentVerified }, { market: "IT", plan: "free", verified: true });
    await site.signInAsListener(student.id);

    const quoted = await site.graphql(`mutation ($offer: ID!) { requestQuote(plan: "student", market: "IT", offerId: $offer) {
      __typename ... on Quote { id price monthsAtPrice thenPrice } ... on Refusal { code reason } } }`, { variables: { offer: state.changeId } });
    const quote = quoted.body.data.requestQuote;
    assert.equal(quote.__typename, "Quote", quoted.text);
    assert.deepEqual({ price: quote.price, months: quote.monthsAtPrice, then: quote.thenPrice }, { price: EUR("299"), months: 3, then: EUR("579") });

    const confirmed = await site.graphql(`mutation ($q: ID!) { confirmSubscription(quoteId: $q) { __typename
      ... on Confirmation { subscription { ${SUBSCRIPTION} } payment { ${PAYMENT} } }
      ... on Refusal { code reason } } }`, { variables: { q: quote.id }, headers: { "x-request-id": requestId("confirm") } });
    const confirmation = confirmed.body.data.confirmSubscription;
    assert.equal(confirmation.__typename, "Confirmation", confirmed.text);
    // The engine's clock is 09:00:05 in Rome on Monday 26 October: the first month is charged today.
    assert.deepEqual(confirmation.subscription, {
      plan: "student", market: "IT", paid: true, price: EUR("299"), startedOn: "2026-10-26", billingDay: 26,
      offerTitle: "Student Autumn Pass", offerMonths: 3, offerMonthsLeft: 3, fullPriceFrom: "2027-01-26", fullPrice: EUR("579"),
      nextBillingOn: "2026-11-26", nextCharge: EUR("299"),
    });
    const account = await site.graphql(`{ me { id account { subscription { ${SUBSCRIPTION} } studentVerification { valid } } } }`);
    assert.deepEqual(account.body.data.me, { id: student.id, account: { subscription: confirmation.subscription, studentVerification: { valid: true } } });

    // The first month's payment. An engine that charges after the confirmation
    // (stage 6) answers it PENDING and its provider settles it shortly after,
    // so the site reads the account again; the engine of stage 5 charged at
    // the confirmation, and the gateway reads its receipt as a payment that
    // succeeded then.
    let payment = confirmation.payment;
    const asked = performance.now();
    while (payment?.state === "PENDING") {
      if (performance.now() - asked > 20_000) throw new Error("the payment was not settled in 20 s");
      await new Promise((resolve) => setTimeout(resolve, 100));
      payment = (await site.graphql(`{ me { account { payment { ${PAYMENT} } } } }`)).body.data.me.account.payment;
    }
    assert.deepEqual({ state: payment?.state, amount: payment?.amount, provider: payment?.provider }, { state: "SUCCEEDED", amount: EUR("299"), provider: "simulated" });
    assert.deepEqual({ amount: payment.receipt.amount, demonstration: payment.receipt.demonstration }, { amount: EUR("299"), demonstration: true });
    assert.match(payment.receipt.note, /no money moved/);

    // The auditor: the subscription, written by the subscriber, with the request id the site sent.
    const log = await people.auditor.graphql(`{ auditEvents(filter: { action: "subscription.confirmed" }, first: 10) { nodes { actor actorRole subject requestId body } } }`);
    const event = (log.body.data.auditEvents.nodes as Array<{ actor: string; actorRole: string; subject: string; requestId: string; body: string }>)
      .find((candidate) => candidate.requestId === state.requestIds["confirm"]);
    assert.ok(event, log.text);
    assert.deepEqual({ actor: event.actor, role: event.actorRole }, { actor: `subscriber-${student.id}`, role: "SUBSCRIBER" });
    assert.match(event.subject, /^subscription:\d+$/);
    const body = JSON.parse(event.body) as Record<string, unknown>;
    assert.deepEqual({ quote: body["quote"], offer: String(body["offer"]), price: body["price"], from: body["full_price_from"] },
      { quote: quote.id, offer: state.changeId, price: 299, from: "2027-01-26" });
    const verified = await people.auditor.graphql("{ verifyAuditChain { ok brokenAt } }");
    assert.deepEqual(verified.body.data.verifyAuditChain, { ok: true, brokenAt: null }, "the chain holds with the subscriber's event in it");
    state.subscription = {
      price: "299", months: 3, fullPrice: "579", fullPriceFrom: confirmation.subscription.fullPriceFrom,
      payment: confirmation.payment.state === "PENDING" ? "settled after the confirmation" : "taken at the confirmation", logged: true,
    };
  });
});
