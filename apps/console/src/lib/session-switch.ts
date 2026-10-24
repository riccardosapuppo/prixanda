// Changing who is in the console: entering as a person, or leaving. The
// gateway keeps the person in its session cookie, so a reading of
// CurrentSession that left before the change went with the old cookie and
// answers for whoever was there before, with their CSRF token. Installing the
// new session therefore cancels those readings first (TanStack Query aborts
// the request and drops the answer of a cancelled fetch), and only then writes
// what the gateway answered. Everything else read as the previous person is
// reset, not removed: the screens on display keep their queries and read them
// again as the new person.
import type { QueryClient } from "@tanstack/react-query";
import { CurrentSessionDocument, type CurrentSessionQuery, PeopleDocument, SignInDocument, SignOutDocument } from "../graphql/generated.ts";
import { queryKeyOf } from "../graphql/operation.ts";
import { setCsrfToken } from "./csrf.ts";
import type { GatewayClient } from "./gateway.ts";

export type Session = CurrentSessionQuery["session"];

export const SESSION_KEY = queryKeyOf(CurrentSessionDocument, {});

/** What does not depend on who is in: the session itself, and the people to choose from. */
const KEEP = new Set([CurrentSessionDocument.name, PeopleDocument.name]);

/** Installs the session an entry or an exit answered, after cancelling every reading of the session still on its way. */
export async function installSession(client: QueryClient, session: Session): Promise<void> {
  await client.cancelQueries({ queryKey: SESSION_KEY, exact: true });
  setCsrfToken(session?.csrfToken ?? null);
  client.setQueryData<CurrentSessionQuery>(SESSION_KEY, { session });
  void client.resetQueries({ predicate: (cached) => !KEEP.has(String(cached.queryKey[0])) });
}

/** Enters as a person: the gateway sets the cookie and answers with the session. */
export async function enter(gateway: GatewayClient, client: QueryClient, personId: string): Promise<void> {
  const data = await gateway.run(SignInDocument, { personId });
  await installSession(client, data.signIn);
}

/** Leaves: whatever the gateway answered, the console forgets the session. */
export async function leave(gateway: GatewayClient, client: QueryClient): Promise<void> {
  try {
    await gateway.run(SignOutDocument, {});
  } finally {
    await installSession(client, null);
  }
}
