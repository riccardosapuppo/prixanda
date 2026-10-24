// The console's API, driven over HTTP the way the console's page drives it:
// a demonstration sign-in per person, the session cookie kept, the CSRF token
// sent back, an Idempotency-Key for every change and an X-Request-Id of the
// test's own, to be found again in the audit log.
//
// The site's end-to-end test launches its offer through here while the
// console of stage 4 is being built; once the two are joined, the launch goes
// through the console's pages instead.
import { randomUUID } from "node:crypto";

export type Answer = { readonly status: number; readonly body: any; readonly text: string };

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

const CHANGE = `__typename ... on Change { id state currentVersion current { version fingerprint } validation { valid eligible }
  requiredSignatures { role conditions signed } } ... on Refusal { code reason facts { name value } }`;

export type Launched = {
  readonly changeId: string;
  /** The request id the test sent with each step, by the audit action it should be written under. */
  readonly requestIds: Readonly<Record<string, string>>;
};

/**
 * Marketing creates, validates and submits the offer; finance approves the
 * exact version and fingerprint; marketing schedules it. The engine then
 * activates it at its start, on its own.
 */
export async function launchOffer(consoleUrl: string, offer: Record<string, unknown>, tag = randomUUID().slice(0, 8)): Promise<Launched> {
  const marketing = await new ConsoleSession(consoleUrl, "marketing-1").signIn();
  const finance = await new ConsoleSession(consoleUrl, "finance-1").signIn();
  const requestIds: Record<string, string> = {};
  const step = async (session: ConsoleSession, action: string, query: string, variables: Record<string, unknown>) => {
    const requestId = `e2e-${action.replace("change.", "")}-${tag}`;
    requestIds[action] = requestId;
    const answer = await session.graphql(query, variables, { "x-request-id": requestId });
    const result = answer.body?.data ? Object.values(answer.body.data)[0] as any : null;
    if (result?.__typename !== "Change") throw new Error(`${action} did not go through: ${answer.text}`);
    return result;
  };
  const created = await step(marketing, "change.created", `mutation ($o: OfferInput!) { createOffer(offer: $o) { ${CHANGE} } }`, { o: offer });
  const changeId: string = created.id;
  const validated = await step(marketing, "change.validated", `mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { ${CHANGE} } }`, { id: changeId });
  if (validated.state !== "VALIDATED") throw new Error(`the offer did not validate: ${JSON.stringify(validated)}`);
  await step(marketing, "change.submitted",
    `mutation ($id: ID!) { submitChange(changeId: $id, version: 1, authorReason: "We are buying students for the autumn: the pass pays for itself from the second year.") { ${CHANGE} } }`,
    { id: changeId });
  const fingerprint: string = validated.current.fingerprint;
  const approved = await step(finance, "change.approved",
    `mutation ($id: ID!, $fp: Sha256!) { approveChange(changeId: $id, version: 1, fingerprint: $fp) { ${CHANGE} } }`, { id: changeId, fp: fingerprint });
  if (approved.state !== "APPROVED") throw new Error(`finance's signature did not approve it: ${JSON.stringify(approved)}`);
  await step(marketing, "change.scheduled", `mutation ($id: ID!) { scheduleChange(changeId: $id) { ${CHANGE} } }`, { id: changeId });
  return { changeId, requestIds };
}
