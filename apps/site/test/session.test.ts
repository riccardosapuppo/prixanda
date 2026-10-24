// Changing the demo listener of this browser, as useSignIn and useSignOut run
// it (src/data/session.ts). A reading of `me` that left before an entry or an
// exit went with the old cookie: its late answer must not put the listener of
// before back, with the CSRF token every mutation carries, nor keep the
// account on them after leaving. A reading that leaves after the change is
// taken as it comes.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import type { SiteApi } from "../src/data/api.ts";
import { keys } from "../src/data/keys.ts";
import { type MeAnswer, signInOptions, signOutOptions } from "../src/data/session.ts";

type Me = NonNullable<MeAnswer>;

/** A demo listener as `me` answers it; only what these tests read matters. */
function listener(id: string, title: string): Me {
  return { id, market: "IT", title, csrfToken: `csrf-${id}`, expiresAt: "2026-10-25T10:00:00Z", account: null } as unknown as Me;
}

const BEFORE = listener("listener-1", "Student in Italy, verified");
const CHOSEN = listener("listener-2", "Free listener in France");

/** An API that answers the entry with the listener given, and the exit. */
function apiEntering(next: Me): Pick<SiteApi, "mutate"> {
  return {
    async mutate(operation) {
      if (operation.name === "SiteSignIn") return { signInAsListener: next } as never;
      if (operation.name === "SiteSignOut") return { signOutListener: true } as never;
      throw new Error(`unexpected ${operation.name}`);
    },
  };
}

/** No timers left behind: the cache keeps what it has until the test ends. */
const newClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY, retry: false }, mutations: { retry: false } } });

/** A reading of `me` on its way, answering only when told; settled() waits until it is over either way and its answer, if taken, is in. */
function readingOnItsWay(client: QueryClient) {
  let answer: (me: MeAnswer) => void = () => {};
  const over = client
    .fetchQuery({ queryKey: keys.me, queryFn: () => new Promise<MeAnswer>((resolve) => { answer = resolve; }) })
    .then(() => undefined, () => undefined);
  return {
    answer: (me: MeAnswer) => answer(me),
    settled: async () => {
      await over;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const meIn = (client: QueryClient) => client.getQueryData<MeAnswer>(keys.me) ?? null;

describe("changing the demo listener", () => {
  it("drops a reading of me that left before the entry, and keeps the chosen listener's CSRF token", async () => {
    const client = newClient();
    client.setQueryData<MeAnswer>(keys.me, BEFORE);
    const late = readingOnItsWay(client);
    await new MutationObserver(client, signInOptions(apiEntering(CHOSEN), client)).mutate("listener-2");
    late.answer(BEFORE);
    await late.settled();
    assert.equal(meIn(client)?.id, "listener-2");
    assert.equal(meIn(client)?.csrfToken, "csrf-listener-2");
    client.clear();
  });

  it("drops it after leaving too: the account does not come back", async () => {
    const client = newClient();
    client.setQueryData<MeAnswer>(keys.me, BEFORE);
    const late = readingOnItsWay(client);
    await new MutationObserver(client, signOutOptions(apiEntering(CHOSEN), client)).mutate();
    late.answer(BEFORE);
    await late.settled();
    assert.equal(meIn(client), null);
    client.clear();
  });

  it("takes a reading that left after the entry: it went with the new cookie", async () => {
    const client = newClient();
    await new MutationObserver(client, signInOptions(apiEntering(CHOSEN), client)).mutate("listener-2");
    const fresh = readingOnItsWay(client);
    fresh.answer({ ...CHOSEN, expiresAt: "2026-10-25T10:30:00Z" });
    await fresh.settled();
    assert.equal(meIn(client)?.expiresAt, "2026-10-25T10:30:00Z");
    client.clear();
  });
});
