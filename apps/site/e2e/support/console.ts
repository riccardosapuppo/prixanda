// The console's API, driven over HTTP the way the console's page drives it:
// a demonstration sign-in per person, the session cookie kept, the CSRF token
// sent back, an Idempotency-Key for every change and an X-Request-Id of the
// test's own, to be found again in the audit log.
//
// The site's end-to-end tests launch their changes through here (an offer, an
// offer for an artist's listeners, a prepaid pass, a price migration): the
// console's own pages have tests of their own, and the site's tests are about
// the site.
import { randomUUID } from "node:crypto";

export type Answer = { readonly status: number; readonly body: any; readonly text: string };

/** One of the demo's people, signed in on the console's API: over HTTP here, through the sandbox's worker in the demo's test. */
export type Session = {
  graphql(query: string, variables?: Record<string, unknown>, headers?: Record<string, string>): Promise<Answer>;
};

/** How a launch gets a person's session: by default, over HTTP to the console's API at that address. */
export type Sessions = string | ((person: string) => Promise<Session>);

export class ConsoleSession {
  readonly url: string;
  readonly person: string;
  #cookies = new Map<string, string>();
  #csrf: string | null = null;

  constructor(url: string, person: string) {
    this.url = url;
    this.person = person;
  }

  async graphql(query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Answer> {
    const sent: Record<string, string> = { "content-type": "application/json", ...headers };
    if (this.#cookies.size) sent["cookie"] = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (this.#csrf !== null) sent["x-csrf-token"] = this.#csrf;
    if (/^\s*mutation\b/.test(query) && !/^\s*mutation\s+SignIn\b/.test(query) && sent["idempotency-key"] === undefined) {
      sent["idempotency-key"] = `e2e-key-${randomUUID()}`;
    }
    const response = await fetch(this.url, { method: "POST", headers: sent, body: JSON.stringify({ query, variables }) });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      if (at > 0) {
        const name = pair.slice(0, at);
        if (/Max-Age=0/i.test(line)) this.#cookies.delete(name);
        else this.#cookies.set(name, pair.slice(at + 1));
      }
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, text };
  }

  /** DEMONSTRATION MODE: becomes one of the demo's people. */
  async signIn(): Promise<this> {
    const answer = await this.graphql("mutation SignIn($id: ID!) { signIn(personId: $id) { csrfToken } }", { id: this.person });
    const token = answer.body?.data?.signIn?.csrfToken;
    if (typeof token !== "string") throw new Error(`could not sign in as ${this.person}: ${answer.text}`);
    this.#csrf = token;
    return this;
  }
}

/** The Student Autumn Pass of the business book's §14.1, as marketing writes it. */
export function studentAutumnPass(startsLocal: string, endsLocal: string) {
  return {
    title: "Student Autumn Pass",
    plan: "student",
    audience: { segment: "NEVER_PAID", needsStudentCheck: true },
    prices: [{ market: "IT", fixed: { amountMinor: "299", currency: "EUR" } }],
    monthsAtOfferPrice: 3,
    periods: [{ market: "IT", startsLocal, endsLocal }],
    nonCombinabilityGroup: "student-offers",
    pages: [{
      market: "IT",
      title: "Student Autumn Pass",
      text: "Three months of Student for 2,99 € a month. Then the usual Student price.",
      terms: "One pass per verified student. New subscribers only. From your fourth month you pay the Student price in force then.",
      treatment: "autumn",
    }],
  };
}

/**
 * The album release of the business book's §14.2, as marketing writes it:
 * two months of Individual at 1,99 € in Italy, for the Free listeners who
 * played Ottoline Marr for more than 2 hours in the last 30 days, while her
 * new record, Low Tide Hymns, is out.
 */
export function albumRelease(startsLocal: string, endsLocal: string) {
  return {
    title: "Low Tide Hymns",
    plan: "individual",
    audience: { segment: "FREE_LISTENERS", listening: { artistId: 2, minSeconds: 7_200, withinDays: 30 } },
    prices: [{ market: "IT", fixed: { amountMinor: "199", currency: "EUR" } }],
    monthsAtOfferPrice: 2,
    periods: [{ market: "IT", startsLocal, endsLocal }],
    nonCombinabilityGroup: "release-offers",
    redemptionCap: 1_500,
    pages: [{
      market: "IT",
      title: "Low Tide Hymns",
      text: "Ottoline Marr's new record is out. Two months of Individual at 1,99 € a month, for the listeners who play her most.",
      terms: "For listeners on Free. Two months at 1,99 €, then the Individual price in force. One release offer per listener.",
      treatment: "standard",
    }],
  };
}

const CHANGE = `__typename ... on Change { id state currentVersion current { version fingerprint } validation { valid eligible }
  requiredSignatures { role conditions signed } } ... on Refusal { code reason facts { name value } }`;

export type Launched = {
  readonly changeId: string;
  /** The request id the test sent with each step, by the audit action it should be written under. */
  readonly requestIds: Readonly<Record<string, string>>;
};

/**
 * A prepaid pass (§9, §14.4) as the commercial lead writes it: three months
 * of Individual for 29,99 € in Italy, on sale from `startsLocal`, its code
 * good for twelve months.
 */
export function giftPass(startsLocal: string) {
  return {
    title: "Three-month gift pass",
    plan: "individual",
    months: 3,
    prices: [{ market: "IT", amount: { amountMinor: "2999", currency: "EUR" } }],
    periods: [{ market: "IT", startsLocal }],
    codeValidMonths: 12,
    pages: [{
      market: "IT",
      title: "Give three months",
      text: "Three months of Individual, 29,99 € paid once. The code never renews, and later price changes don't touch it.",
      terms: "A single-use code, valid for twelve months from the day it is bought. Activated, it gives three months of Individual, then Free.",
    }],
  };
}

/** A price migration (§8, §14.3): a higher price for one plan in one market, existing subscribers asked or told from `noticesLocal`. */
export function priceMigration(title: string, plan: string, market: string, amountMinor: string, noticesLocal: string, startsLocal: string) {
  return { title, plan, market, amount: { amountMinor, currency: market === "GB" ? "GBP" : "EUR" }, noticesLocal, startsLocal };
}

/** Each kind of change: the mutation that creates it, its input type, who writes it, and why it is wanted. */
const KINDS = {
  offer: { create: "createOffer", argument: "offer", input: "OfferInput", author: "marketing-1",
    reason: "We are buying students for the autumn: the pass pays for itself from the second year." },
  release: { create: "createOffer", argument: "offer", input: "OfferInput", author: "marketing-1",
    reason: "Her new record is out: the listeners who already play her on Free are the likeliest to pay for it." },
  prepaid: { create: "createPrepaidPass", argument: "pass", input: "PrepaidPassInput", author: "commercial-lead-1",
    reason: "A gift for the holidays that brings new listeners in, paid in advance and never renewed." },
  migration: { create: "createPriceMigration", argument: "migration", input: "PriceMigrationInput", author: "commercial-lead-1",
    reason: "The plan's costs rose: the artists' share and the payment costs follow the price, and the margin holds." },
} as const;

/**
 * Marketing creates, validates and submits the offer; finance approves the
 * exact version and fingerprint; marketing schedules it. The engine then
 * activates it at its start, on its own.
 */
export async function launchOffer(sessions: Sessions, offer: Record<string, unknown>, tag = randomUUID().slice(0, 8)): Promise<Launched> {
  return launchChange(sessions, "offer", offer, tag);
}

/**
 * Its author creates, validates and submits the change; finance approves the
 * exact version and fingerprint; the author schedules it. The engine then
 * starts it on its own: an offer or a pass goes on sale, a migration asks or
 * tells the existing subscribers.
 */
export async function launchChange(sessions: Sessions, kind: keyof typeof KINDS, content: Record<string, unknown>, tag = randomUUID().slice(0, 8)): Promise<Launched> {
  const how = KINDS[kind];
  const open = typeof sessions === "string" ? (person: string) => new ConsoleSession(sessions, person).signIn() : sessions;
  const author = await open(how.author);
  const finance = await open("finance-1");
  const marketing = author;
  const requestIds: Record<string, string> = {};
  const step = async (session: Session, action: string, query: string, variables: Record<string, unknown>) => {
    const requestId = `e2e-${action.replace("change.", "")}-${tag}`;
    requestIds[action] = requestId;
    const answer = await session.graphql(query, variables, { "x-request-id": requestId });
    const result = answer.body?.data ? Object.values(answer.body.data)[0] as any : null;
    if (result?.__typename !== "Change") throw new Error(`${action} did not go through: ${answer.text}`);
    return result;
  };
  const created = await step(marketing, "change.created", `mutation ($o: ${how.input}!) { ${how.create}(${how.argument}: $o) { ${CHANGE} } }`, { o: content });
  const changeId: string = created.id;
  const validated = await step(marketing, "change.validated", `mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { ${CHANGE} } }`, { id: changeId });
  if (validated.state !== "VALIDATED") throw new Error(`the ${kind} did not validate: ${JSON.stringify(validated)}`);
  await step(marketing, "change.submitted",
    `mutation ($id: ID!, $why: String!) { submitChange(changeId: $id, version: 1, authorReason: $why) { ${CHANGE} } }`,
    { id: changeId, why: how.reason });
  const fingerprint: string = validated.current.fingerprint;
  const approved = await step(finance, "change.approved",
    `mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { ${CHANGE} } }`, { id: changeId, fp: fingerprint });
  if (approved.state !== "APPROVED") throw new Error(`finance's signature did not approve it: ${JSON.stringify(approved)}`);
  await step(marketing, "change.scheduled", `mutation ($id: ID!) { scheduleChange(changeId: $id) { ${CHANGE} } }`, { id: changeId });
  return { changeId, requestIds };
}
