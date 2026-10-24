// The engine and the gateway together, on the Student Autumn Pass of the
// business book's §14.1, from a draft to the subscription of a student on the
// site; then, on the same engine a week later, the Family price in Germany of
// §14.3 and a prepaid pass of §14.4.
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

/** §14.3: the Family plan in Germany from €18.99 to €20.99, asked on 2 November at 09:00 in Berlin, for new subscribers from 1 December. */
const MIGRATION = {
  title: "Family price in Germany", plan: "family", market: "DE", amount: { amountMinor: "2099", currency: "EUR" },
  noticesLocal: "2026-11-02T09:00", startsLocal: "2026-12-01T00:00",
};
/** 09:00 in Berlin on 2 November is 08:00 UTC. */
const PAST_THE_NOTICES = "2026-11-02T08:00:05Z";
/** §9.1, §14.4: three months of Individual in Italy, €29.99, on sale from 3 November at 09:00 in Rome. */
const PASS = {
  title: "Three-month gift pass", plan: "individual", months: 3, prices: [{ market: "IT", amount: { amountMinor: "2999", currency: "EUR" } }],
  periods: [{ market: "IT", startsLocal: "2026-11-03T09:00" }], codeValidMonths: 12,
  pages: [{ market: "IT", title: "Three-month gift pass", text: "Three months of Individual, paid once: a code to keep, or to give.", terms: "A single-use code. It never renews." }],
};
const PAST_THE_SALE = "2026-11-03T08:00:05Z";
const STEP = "price net artists paymentCosts contribution";
const PREPAID_VALUE = "{ overview { prepaid { market sold activated expired unearned unearnedEur } prepaidUnearnedEur } }";
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

/** Asks until `done` holds, every 100 ms, for 20 s at most. */
async function eventually<T>(ask: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const asked = performance.now();
  for (;;) {
    const value = await ask();
    if (done(value)) return value;
    if (performance.now() - asked > 20_000) throw new Error(`${what}: not in 20 s; last ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

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
  /** The engine's launch that published the pass, as its log names it: launch-12. */
  launchRun: "",
  /** The steps of that launch the console read, all done (step i). */
  launchSteps: 0,
  auditEvents: 0,
  /** What the student of step h pays, as the engine confirmed it and the log has it. */
  subscription: null as null | { price: string; months: number; fullPrice: string; fullPriceFrom: string; payment: string; logged: boolean },
  /** §14.3: the migration's change, and the subscribers its start asked for consent (step k). */
  migrationId: "",
  migration: null as null | { asked: number; waiting: number; answered: string },
  /** §14.4: the pass's change, its code, and finance's value not yet earned in Italy before and after its activation (steps l, m). */
  passId: "",
  code: "",
  buyerId: "",
  prepaid: null as null | { unearnedBefore: string; unearnedAfter: string; activated: boolean },
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

describe("the Student Autumn Pass (§14.1), then the Family price in Germany (§14.3) and a prepaid pass (§14.4), through the engine and the gateway", () => {
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
    // The engine's log says so: its launch (stage 6) did the publish step for this change. The line is
    // written when the engine's pass ends, a moment after the catalog went live.
    const published = () => engine?.log.find((entry) => entry["event"] === "launch_step_done" && entry["step"] === "publish"
      && String(entry["change"]) === state.changeId);
    const logged = performance.now();
    while (published() === undefined && performance.now() - logged < 5_000) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(published(), "the engine's log says its launch published the change");
    state.launchRun = String(published()?.["run"] ?? "");
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
    // Where the price goes (§1.2, §5), the §14.1 numbers: of the artists' €3.00, €1.47 comes from the subscriber
    // and €1.53 from the music service. (An engine before stage 6 sent no breakdown, and the site read null.)
    assert.deepEqual(offer.breakdown, { price: EUR("299"), net: EUR("245"), artists: EUR("300"), topUp: EUR("153") });
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
    // The activation is the engine's own job: its launch's run identifier stands for a request id.
    const activation = events.at(-1);
    assert.deepEqual({ actor: activation?.actor, role: activation?.actorRole }, { actor: "activation", role: "SYSTEM" });
    assert.match(activation?.requestId ?? "", /^launch-\d+$/);
    assert.equal(activation?.requestId, state.launchRun, "the run the engine's log named");
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

    // The first month's payment: asked of the provider after the confirmation,
    // through the engine's outbox (stage 6), so it comes back PENDING; the
    // provider's event settles it shortly after, and the site reads the account
    // again until it does.
    assert.deepEqual({ state: confirmation.payment.state, receipt: confirmation.payment.receipt }, { state: "PENDING", receipt: null });
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

  test("i. the console reads the pass's launch: one launch, its five steps done, the catalog before and after, the audit events it wrote", async () => {
    // Every role reads launches (§12.2): the auditor here. The launch was done publishing in step d; its last
    // two steps (notify, verify) follow on the engine's next passes, so the console reads until it is done.
    const listed = async () => (await people.auditor.graphql(`query ($change: ID!) { launches(filter: { changeId: $change }) { nodes { id run state } next } }`, {
      variables: { change: state.changeId },
    })).body.data.launches;
    let page = await listed();
    const asked = performance.now();
    while (page.nodes[0]?.state !== "DONE" && performance.now() - asked < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      page = await listed();
    }
    assert.deepEqual(page, { nodes: [{ id: page.nodes[0]?.id, run: state.launchRun, state: "DONE" }], next: null }, "one launch of the pass, done");
    const answer = await people.auditor.graphql(`query ($id: ID!) { launch(id: $id) {
      id run state currentStep attempts cause snapshotBefore snapshotAfter resolution starts { market local utc } change { id state }
      steps { name state attempts error } auditEventSeqs incidents { id } } }`, { variables: { id: page.nodes[0]?.id } });
    assert.equal(answer.body.errors, undefined, answer.text);
    const launch = answer.body.data.launch;
    assert.deepEqual(launch.steps.map((step: { name: string; state: string; error: string | null }) => `${step.name} ${step.state} ${step.error ?? "-"}`),
      ["check DONE -", "prepare DONE -", "publish DONE -", "notify DONE -", "verify DONE -"]);
    assert.deepEqual(
      { state: launch.state, currentStep: launch.currentStep, cause: launch.cause, incidents: launch.incidents, change: launch.change, starts: launch.starts },
      { state: "DONE", currentStep: null, cause: null, incidents: [], change: { id: state.changeId, state: "ACTIVE" }, starts: { market: "IT", local: "2026-10-26T09:00", utc: "2026-10-26T08:00:00Z" } },
    );
    assert.equal(launch.attempts, 5, "one attempt per step: nothing failed");
    assert.ok(launch.snapshotAfter !== null && launch.snapshotAfter !== launch.snapshotBefore, `the catalog went from ${launch.snapshotBefore} to ${launch.snapshotAfter}`);
    assert.match(launch.resolution ?? "", /^published at /);
    // The change's activation in the log is one of the events the launch names.
    const log = await people.auditor.graphql(`query ($subject: String!) { auditEvents(filter: { subject: $subject, action: "change.activated" }) { nodes { seq requestId } } }`, {
      variables: { subject: `change:${state.changeId}` },
    });
    const activated = log.body.data.auditEvents.nodes[0];
    assert.equal(activated?.requestId, launch.run);
    assert.ok(launch.auditEventSeqs.includes(activated?.seq), `${JSON.stringify(launch.auditEventSeqs)} names the activation, event ${activated?.seq}`);
    state.launchSteps = launch.steps.length;
  });

  test("j. the commercial lead writes the Family price in Germany; its simulation has the book's numbers; finance approves it and the commercial lead schedules it", async () => {
    const created = await people.lead.graphql(`mutation ($m: PriceMigrationInput!) { createPriceMigration(migration: $m) { ${CHANGE} ... on Change { kind } } }`, {
      variables: { m: MIGRATION }, headers: { "x-request-id": requestId("migration-create") },
    });
    const change = created.body.data.createPriceMigration;
    assert.equal(change.__typename, "Change", created.text);
    assert.deepEqual({ kind: change.kind, state: change.state, author: change.createdBy.id }, { kind: "PRICE_MIGRATION", state: "DRAFT", author: "commercial-lead-1" });
    state.migrationId = change.id;
    const validated = await people.lead.graphql(`mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { ${CHANGE} } }`, { variables: { id: state.migrationId } });
    const valid = validated.body.data.validateChange;
    assert.equal(valid.state, "VALIDATED", validated.text);
    assert.ok(valid.validation.eligible >= 1, `the Family subscribers in Germany, counted in the data: ${valid.validation.eligible}`);
    // §7.3: finance signs a price migration, for conditions 1 and 5.
    const [signature, ...others] = valid.requiredSignatures as Array<{ role: string; conditions: number[]; signed: boolean }>;
    assert.deepEqual([others, signature?.role, signature?.signed], [[], "FINANCE", false]);
    assert.deepEqual([...(signature?.conditions ?? [])].sort(), [1, 5]);

    // §8.7 with the book's assumptions typed: 8,412 subscribers, 93% acceptance.
    const simulated = await people.finance.graphql(`query ($id: ID!) { simulateMigration(changeId: $id, overrides: [{ name: EXISTING, value: 8412 }, { name: ACCEPTANCE, value: 9300 }]) {
      __typename ... on MigrationSimulation { before { ${STEP} } after { ${STEP} } newSubscribersFrom { local utc } noticesFrom { local utc } windowEnds { local utc }
        existing accepting notAccepting movingToFree monthlyRevenueChange monthlyContributionChange revenueAtRiskMonthly
        breakEvenAcceptanceRevenueBasisPoints breakEvenAcceptanceContributionBasisPoints prepaidPassesUntouched assumptions { name value source }
        financeConditions { number met } }
      ... on Refusal { code reason } } }`, { variables: { id: state.migrationId } });
    const simulation = simulated.body.data.simulateMigration;
    assert.equal(simulation.__typename, "MigrationSimulation", simulated.text);
    assert.deepEqual({ before: simulation.before, after: simulation.after }, {
      before: { price: EUR("1899"), net: EUR("1596"), artists: EUR("958"), paymentCosts: EUR("34"), contribution: EUR("604") },
      after: { price: EUR("2099"), net: EUR("1764"), artists: EUR("1058"), paymentCosts: EUR("38"), contribution: EUR("668") },
    });
    assert.deepEqual({
      existing: simulation.existing, accepting: simulation.accepting, notAccepting: simulation.notAccepting, movingToFree: simulation.movingToFree,
      revenue: simulation.monthlyRevenueChange, contribution: simulation.monthlyContributionChange, atRisk: simulation.revenueAtRiskMonthly,
      breakEven: [simulation.breakEvenAcceptanceRevenueBasisPoints, simulation.breakEvenAcceptanceContributionBasisPoints],
    }, {
      existing: 8412, accepting: 7823, notAccepting: 589, movingToFree: 589, revenue: EUR("374220"), contribution: EUR("144916"), atRisk: EUR("940044"),
      breakEven: [9048, 9042],
    });
    assert.deepEqual({ notices: simulation.noticesFrom, window: simulation.windowEnds, newSubscribers: simulation.newSubscribersFrom }, {
      notices: { local: "2026-11-02T09:00", utc: "2026-11-02T08:00:00Z" }, window: { local: "2026-12-17T23:59", utc: "2026-12-17T22:59:00Z" },
      newSubscribers: { local: "2026-12-01T00:00", utc: "2026-11-30T23:00:00Z" },
    });
    assert.deepEqual(simulation.assumptions.map((assumption: { name: string; value: number; source: string }) => [assumption.name, assumption.value, /^typed by finance at /.test(assumption.source)]),
      [["EXISTING", 8412, true], ["ACCEPTANCE", 9300, true]]);
    assert.deepEqual(simulation.financeConditions.filter((condition: { met: boolean }) => condition.met).map((condition: { number: number }) => condition.number), [1, 5]);

    const submitted = await people.lead.graphql(`mutation ($id: ID!) { submitChange(changeId: $id, version: 1) { ${CHANGE} } }`, { variables: { id: state.migrationId } });
    assert.equal(submitted.body.data?.submitChange?.state, "IN_APPROVAL", submitted.text);
    const approved = await people.finance.graphql(`mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { ${CHANGE} } }`, {
      variables: { id: state.migrationId, fp: change.current.fingerprint },
    });
    assert.equal(approved.body.data?.approveChange?.state, "APPROVED", approved.text);
    // Marketing schedules campaigns, not migrations: the engine refuses it by the change's kind (§12).
    const byMarketing = await people.marketing.graphql(`mutation ($id: ID!) { scheduleChange(changeId: $id) { ${CHANGE} } }`, { variables: { id: state.migrationId } });
    assert.equal(byMarketing.body.data.scheduleChange.code, "ROLE_NOT_ALLOWED", byMarketing.text);
    const scheduled = await people.lead.graphql(`mutation ($id: ID!) { scheduleChange(changeId: $id) { ${CHANGE} } }`, { variables: { id: state.migrationId } });
    assert.equal(scheduled.body.data?.scheduleChange?.state, "SCHEDULED", scheduled.text);
  });

  test("k. past 09:00 in Berlin on 2 November the migration starts: the Family subscriber of the demo reads the request for consent with the engine's dates, and says yes", async () => {
    assert.ok(engine);
    await engine.at(PAST_THE_NOTICES);
    const progress = "state migration { requirement windowEnds { local utc } asked waiting accepted declined lapsed newPrice left }";
    const read = async () => (await people.auditor.graphql(`query ($id: ID!) { change(id: $id) { ${progress} } }`, { variables: { id: state.migrationId } })).body.data.change;
    const started = await eventually(read, (change) => change.state === "ACTIVE" && (change.migration?.asked ?? 0) > 0, "the migration's start");
    const migration = started.migration;
    assert.deepEqual({ requirement: migration.requirement, windowEnds: migration.windowEnds }, {
      requirement: "CONSENT", windowEnds: { local: "2026-12-17T23:59", utc: "2026-12-17T22:59:00Z" },
    });
    // Nobody answered yet: every subscriber asked is waiting.
    assert.deepEqual([migration.waiting, migration.accepted, migration.declined, migration.lapsed, migration.newPrice, migration.left],
      [migration.asked, 0, 0, 0, 0, 0]);

    // On the site, the demo's Family subscriber in Germany, billed on the 15th since June 2025.
    const site = client("public");
    const entrance = (await site.graphql("{ demoListeners { id title market plan } }")).body.data.demoListeners as Array<{ id: string; title: string; market: string; plan: string }>;
    const family = entrance.find((listener) => listener.title === "Family subscriber in Germany");
    assert.ok(family, JSON.stringify(entrance));
    assert.deepEqual([family.market, family.plan], ["DE", "family"]);
    await site.signInAsListener(family.id);
    const fields = `id kind state oldPrice newPrice sentAt windowEnds { local utc } newSubscribersFrom { local utc } newPriceFrom appliesFrom ifNoLeavesOn leavesOn ifNoAnswer legalBasis`;
    const account = await site.graphql(`{ me { account { subscription { price billingDay nextBillingOn nextCharge endsOn } priceChanges { ${fields} } } } }`);
    assert.equal(account.body.errors, undefined, account.text);
    const [asked, ...older] = account.body.data.me.account.priceChanges;
    assert.deepEqual(older, []);
    assert.ok(asked.sentAt >= "2026-11-02T08:00:00Z", asked.sentAt);
    assert.deepEqual({ ...asked, id: undefined, sentAt: undefined, ifNoAnswer: undefined, legalBasis: undefined }, {
      id: undefined, kind: "CONSENT", state: "WAITING", oldPrice: EUR("1899"), newPrice: EUR("2099"), sentAt: undefined,
      windowEnds: { local: "2026-12-17T23:59", utc: "2026-12-17T22:59:00Z" }, newSubscribersFrom: { local: "2026-12-01T00:00", utc: "2026-11-30T23:00:00Z" },
      // A yes today: the first charge from tomorrow, not before new subscribers pay it. Without one: the first billing day on or
      // after the deadline, so that the month paid for is never cut short.
      newPriceFrom: null, appliesFrom: "2026-12-15", ifNoLeavesOn: "2027-01-15", leavesOn: null,
      ifNoAnswer: undefined, legalBasis: undefined,
    });
    assert.match(asked.ifNoAnswer, /not a legal requirement/);
    assert.match(asked.legalBasis, /Sources: /);
    // The subscription says when it ends if nothing more is done; November is charged at the old price.
    assert.deepEqual(account.body.data.me.account.subscription, {
      price: EUR("1899"), billingDay: 15, nextBillingOn: "2026-11-15", nextCharge: EUR("1899"), endsOn: "2027-01-15",
    });

    const answer = `mutation ($id: ID!, $yes: Boolean!) { answerPriceChange(priceChangeId: $id, accept: $yes) { __typename
      ... on PriceChange { state newPriceFrom appliesFrom ifNoLeavesOn leavesOn } ... on Refusal { code reason } } }`;
    const yes = await site.graphql(answer, { variables: { id: asked.id, yes: true }, headers: { "x-request-id": requestId("consent") } });
    assert.deepEqual(yes.body.data.answerPriceChange, {
      __typename: "PriceChange", state: "ACCEPTED", newPriceFrom: "2026-12-15", appliesFrom: null, ifNoLeavesOn: null, leavesOn: null,
    }, yes.text);
    const again = await site.graphql(answer, { variables: { id: asked.id, yes: true } });
    assert.deepEqual(again.body.data.answerPriceChange, yes.body.data.answerPriceChange, "the same answer again comes back the same");
    const no = await site.graphql(answer, { variables: { id: asked.id, yes: false } });
    assert.deepEqual(no.body.data.answerPriceChange, {
      __typename: "Refusal", code: "ANSWER_CLOSED", reason: "This price change takes no other answer now: you answered it already, or the time to answer has ended.",
    }, "the answer stays, in the site's words");
    const after = (await site.graphql("{ me { account { subscription { nextBillingOn nextCharge endsOn } } } }")).body.data.me.account.subscription;
    assert.deepEqual(after, { nextBillingOn: "2026-11-15", nextCharge: EUR("1899"), endsOn: null }, "it no longer ends");

    // The console counts the yes, and the log has it, by the subscriber, with the site's request id.
    const counted = await read();
    assert.deepEqual([counted.migration.accepted, counted.migration.waiting], [1, migration.asked - 1]);
    const logged = await people.auditor.graphql(`{ auditEvents(filter: { action: "price_change.answered" }, first: 10) { nodes { actor actorRole requestId } } }`);
    const event = (logged.body.data.auditEvents.nodes as Array<{ actor: string; actorRole: string; requestId: string }>).find((candidate) => candidate.requestId === state.requestIds["consent"]);
    assert.deepEqual({ actor: event?.actor, role: event?.actorRole }, { actor: `subscriber-${family.id}`, role: "SUBSCRIBER" }, logged.text);
    state.migration = { asked: migration.asked, waiting: migration.waiting, answered: "yes" };
  });

  test("l. a prepaid pass: the commercial lead writes it, finance approves it, its launch puts it on sale; the verified student buys one, and once paid its code is ready", async () => {
    assert.ok(engine);
    const created = await people.lead.graphql(`mutation ($p: PrepaidPassInput!) { createPrepaidPass(pass: $p) { ${CHANGE} ... on Change { kind } } }`, {
      variables: { p: PASS }, headers: { "x-request-id": requestId("pass-create") },
    });
    const change = created.body.data.createPrepaidPass;
    assert.equal(change.__typename, "Change", created.text);
    assert.equal(change.kind, "PREPAID");
    state.passId = change.id;
    const validated = await people.lead.graphql(`mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { ${CHANGE} } }`, { variables: { id: state.passId } });
    assert.equal(validated.body.data?.validateChange?.state, "VALIDATED", validated.text);
    assert.deepEqual(validated.body.data.validateChange.requiredSignatures.map((signature: { role: string; conditions: number[] }) => [signature.role, signature.conditions]),
      [["FINANCE", [1]]], "a pass is a price: finance signs it for condition 1");
    const submitted = await people.lead.graphql(`mutation ($id: ID!) { submitChange(changeId: $id, version: 1) { ${CHANGE} } }`, { variables: { id: state.passId } });
    assert.equal(submitted.body.data?.submitChange?.state, "IN_APPROVAL", submitted.text);
    const approved = await people.finance.graphql(`mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { ${CHANGE} } }`, {
      variables: { id: state.passId, fp: change.current.fingerprint },
    });
    assert.equal(approved.body.data?.approveChange?.state, "APPROVED", approved.text);
    const scheduled = await people.lead.graphql(`mutation ($id: ID!) { scheduleChange(changeId: $id) { ${CHANGE} } }`, { variables: { id: state.passId } });
    assert.equal(scheduled.body.data?.scheduleChange?.state, "SCHEDULED", scheduled.text);

    // Past 09:00 in Rome on 3 November its launch puts it on sale, and the site lists it.
    const site = client("public");
    await engine.at(PAST_THE_SALE);
    const onSale = await eventually(async () => (await site.graphql('{ prepaidPasses(market: "IT") { id title plan months price codeValidMonths terms } }')).body.data.prepaidPasses as Array<{ id: string }>,
      (passes) => passes.some((pass) => pass.id === state.passId), "the pass on sale");
    assert.deepEqual(onSale.find((pass) => pass.id === state.passId), {
      id: state.passId, title: "Three-month gift pass", plan: "individual", months: 3, price: EUR("2999"), codeValidMonths: 12, terms: "A single-use code. It never renews.",
    });

    const buyer = client("public");
    const entrance = (await buyer.graphql("{ demoListeners { id title } }")).body.data.demoListeners as Array<{ id: string; title: string }>;
    const student = entrance.find((listener) => listener.title === "Student in Italy, verified");
    assert.ok(student);
    state.buyerId = student.id;
    await buyer.signInAsListener(student.id);
    const bought = await buyer.graphql(`mutation ($p: ID!) { buyPrepaidPass(passId: $p) { __typename
      ... on PrepaidPurchase { prepaidCode { code passId state validUntil price boughtAt payment { state amount } } } ... on Refusal { code reason } } }`, {
      variables: { p: state.passId }, headers: { "x-request-id": requestId("pass-buy") },
    });
    const purchase = bought.body.data.buyPrepaidPass;
    assert.equal(purchase.__typename, "PrepaidPurchase", bought.text);
    const code = purchase.prepaidCode;
    assert.match(code.code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    // Sold on 3 November for 12 months: it can be activated until 2 November 2027.
    assert.deepEqual({ passId: code.passId, state: code.state, validUntil: code.validUntil, price: code.price, payment: code.payment }, {
      passId: state.passId, state: "PENDING", validUntil: "2027-11-02", price: EUR("2999"), payment: { state: "PENDING", amount: EUR("2999") },
    });
    state.code = code.code;
    // The provider's event settles its payment through the engine's outbox, as for a subscription: the code is ready.
    const codes = await eventually(async () => (await buyer.graphql("{ me { account { prepaidCodes { code state payment { state receipt { demonstration } } } } } }")).body.data.me.account.prepaidCodes as Array<{ code: string; state: string }>,
      (list) => list[0]?.state !== "PENDING", "the code's payment");
    assert.deepEqual(codes, [{ code: state.code, state: "READY", payment: { state: "SUCCEEDED", receipt: { demonstration: true } } }]);
  });

  test("m. finance reads the value not yet earned; given to the student not yet verified, the code is activated, and its first month is earned that day", async () => {
    const before = await people.finance.graphql(PREPAID_VALUE);
    assert.equal(before.body.errors, undefined, before.text);
    const italyBefore = before.body.data.overview.prepaid.find((row: { market: string }) => row.market === "IT");
    // The Italian pass, net €24.58, not activated yet: all of it unearned (§9.2).
    assert.deepEqual(italyBefore, { market: "IT", sold: 1, activated: 0, expired: 0, unearned: EUR("2458"), unearnedEur: EUR("2458") }, before.text);
    // The commercial lead reads revenue, not this: the engine leaves it out, and the gateway says so (§12.2).
    const lead = await people.lead.graphql(PREPAID_VALUE);
    assert.deepEqual(codes(lead), ["FORBIDDEN", "FORBIDDEN"], lead.text);

    const friend = client("public");
    const entrance = (await friend.graphql("{ demoListeners { id title } }")).body.data.demoListeners as Array<{ id: string; title: string }>;
    const unverified = entrance.find((listener) => listener.title === "Student in Italy, not verified yet");
    assert.ok(unverified);
    await friend.signInAsListener(unverified.id);
    const activate = `mutation ($c: String!) { activatePrepaidPass(code: $c) { __typename ... on Subscription { ${SUBSCRIPTION} endsOn prepaidCode prepaidPrice } ... on Refusal { code reason } } }`;
    const activated = await friend.graphql(activate, { variables: { c: state.code }, headers: { "x-request-id": requestId("pass-activate") } });
    const subscription = activated.body.data.activatePrepaidPass;
    assert.equal(subscription.__typename, "Subscription", activated.text);
    // Individual from 3 November for three months, never charged: then the free plan, from 3 February 2027.
    assert.deepEqual(subscription, {
      __typename: "Subscription", plan: "individual", market: "IT", paid: true, price: EUR("0"), startedOn: "2026-11-03", billingDay: null,
      offerTitle: null, offerMonths: 0, offerMonthsLeft: 0, fullPriceFrom: null, fullPrice: null, nextBillingOn: null, nextCharge: null,
      endsOn: "2027-02-03", prepaidCode: state.code, prepaidPrice: EUR("2999"),
    });
    // Typed again, as people type it: the same answer.
    const again = await friend.graphql(activate, { variables: { c: state.code.toLowerCase().replaceAll("-", " ") } });
    assert.deepEqual(again.body.data.activatePrepaidPass, subscription);

    const after = await people.finance.graphql(PREPAID_VALUE);
    const italyAfter = after.body.data.overview.prepaid.find((row: { market: string }) => row.market === "IT");
    // €24.58 is earned as €8.19, €8.19 and €8.20 from the activation: €16.39 is left.
    assert.deepEqual(italyAfter, { market: "IT", sold: 1, activated: 1, expired: 0, unearned: EUR("1639"), unearnedEur: EUR("1639") }, after.text);
    assert.deepEqual(after.body.data.overview.prepaidUnearnedEur, EUR("1639"));
    // The log: sold by the student who bought it, activated by the one it was given to, each with the site's request id.
    const logged = async (action: string) => (await people.auditor.graphql("query ($a: String!) { auditEvents(filter: { action: $a }, first: 20) { nodes { actor subject requestId } } }", {
      variables: { a: action },
    })).body.data.auditEvents.nodes as Array<{ actor: string; subject: string; requestId: string }>;
    const sold = (await logged("prepaid.sold")).find((event) => event.requestId === state.requestIds["pass-buy"]);
    const used = (await logged("prepaid.activated")).find((event) => event.requestId === state.requestIds["pass-activate"]);
    assert.ok(sold && used, "the purchase and the activation are in the log, with the site's request ids");
    assert.deepEqual([sold.subject === used.subject, /^prepaid:\d+$/.test(sold.subject)], [true, true]);
    assert.deepEqual([sold.actor, used.actor], [`subscriber-${state.buyerId}`, `subscriber-${unverified.id}`], "bought by one listener, activated by another");
    state.prepaid = { unearnedBefore: italyBefore.unearned.amountMinor, unearnedAfter: italyAfter.unearned.amountMinor, activated: true };
  });
});
