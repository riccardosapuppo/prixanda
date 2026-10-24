// Changing who is in the console. A reading of the session that left before
// an entry or an exit went with the old cookie: its late answer must not put
// the previous person back, with their CSRF token, nor keep the console inside
// after leaving. A reading that leaves after the change is installed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { CurrentSessionQuery, Role } from "../src/graphql/generated.ts";
import { csrfToken, setCsrfToken } from "../src/lib/csrf.ts";
import type { GatewayClient } from "../src/lib/gateway.ts";
import { enter, leave, SESSION_KEY, type Session } from "../src/lib/session-switch.ts";

function person(id: string, label: string, role: Role): NonNullable<Session> {
  return { mode: "DEMONSTRATION", roles: [role], csrfToken: `csrf-${id}`, expiresAt: "2026-10-24T09:42:00Z", person: { id, label, roles: [role] } };
}

const MARKETING = person("marketing-1", "Giulia Ferri", "MARKETING");
const FINANCE = person("finance-1", "Paolo Greco", "FINANCE");

/** A gateway that answers the entry with the person given, and the exit. */
function gatewayEntering(next: NonNullable<Session>): GatewayClient {
  return {
    async run(operation) {
      if (operation.name === "SignIn") return { signIn: next } as never;
      if (operation.name === "SignOut") return { signOut: true } as never;
      throw new Error(`unexpected ${operation.name}`);
    },
  };
}

/** No timers left behind: the cache keeps what it has until the test ends. */
const newClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY, retry: false } } });

/**
 * A reading of CurrentSession on its way, answering only when told. settled()
 * waits until the reading is over either way (a cancelled reading settles with
 * the data from before it, or with an error) and its answer, if taken, is in.
 */
function readingOnItsWay(client: QueryClient) {
  let answer: (data: CurrentSessionQuery) => void = () => {};
  const over = client
    .fetchQuery({ queryKey: SESSION_KEY, queryFn: () => new Promise<CurrentSessionQuery>((resolve) => { answer = resolve; }) })
    .then(() => undefined, () => undefined);
  return {
    answer: (data: CurrentSessionQuery) => answer(data),
    settled: async () => {
      await over;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const sessionIn = (client: QueryClient) => client.getQueryData<CurrentSessionQuery>(SESSION_KEY)?.session ?? null;

describe("changing who is in the console", () => {
  it("drops a reading of the session that left before an entry, and keeps the new person's CSRF token", async () => {
    const client = newClient();
    client.setQueryData<CurrentSessionQuery>(SESSION_KEY, { session: MARKETING });
    setCsrfToken(MARKETING.csrfToken);
    const late = readingOnItsWay(client);
    await enter(gatewayEntering(FINANCE), client, "finance-1");
    late.answer({ session: MARKETING });
    await late.settled();
    assert.equal(sessionIn(client)?.person.id, "finance-1");
    assert.equal(csrfToken(), "csrf-finance-1");
    client.clear();
  });

  it("drops it after an exit too: the console does not look still inside", async () => {
    const client = newClient();
    client.setQueryData<CurrentSessionQuery>(SESSION_KEY, { session: MARKETING });
    setCsrfToken(MARKETING.csrfToken);
    const late = readingOnItsWay(client);
    await leave(gatewayEntering(FINANCE), client);
    late.answer({ session: MARKETING });
    await late.settled();
    assert.equal(sessionIn(client), null);
    assert.equal(csrfToken(), null);
    client.clear();
  });

  it("installs a reading that left after the entry: it went with the new cookie", async () => {
    const client = newClient();
    await enter(gatewayEntering(FINANCE), client, "finance-1");
    const fresh = readingOnItsWay(client);
    fresh.answer({ session: { ...FINANCE, expiresAt: "2026-10-24T10:12:00Z" } });
    await fresh.settled();
    assert.equal(sessionIn(client)?.expiresAt, "2026-10-24T10:12:00Z");
    client.clear();
  });

  it("resets what was read as the previous person, and keeps the people to choose from", async () => {
    const client = newClient();
    client.setQueryData(["Home", { readsRevenue: true }], { overview: "as Finance" });
    client.setQueryData(["People", {}], { people: [] });
    await enter(gatewayEntering(MARKETING), client, "marketing-1");
    assert.equal(client.getQueryData(["Home", { readsRevenue: true }]), undefined);
    assert.deepEqual(client.getQueryData(["People", {}]), { people: [] });
    client.clear();
  });
});
