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

/**
 * Leaves. Only an exit the gateway answered makes the console forget the
 * session. One that failed before it (the network, a time-out) may have left
 * the session's cookie in the browser, and an entry without that session's
 * CSRF token would be refused: the session is read again with the cookie, and
 * what the gateway answers is installed, its token with it. A reading still
 * on its way left before the exit, and may answer for the person who left
 * (the exit can end the session and lose only its answer): it is cancelled
 * first, so the session is read as it is after the exit. If that reading
 * fails too, the session the console had stays, and the session's reading
 * holds the error, which the frame says with its retry.
 */
export async function leave(gateway: GatewayClient, client: QueryClient): Promise<void> {
  try {
    await gateway.run(SignOutDocument, {});
  } catch {
    let read: CurrentSessionQuery;
    try {
      await client.cancelQueries({ queryKey: SESSION_KEY, exact: true });
      read = await client.fetchQuery({ queryKey: SESSION_KEY, queryFn: ({ signal }) => gateway.run(CurrentSessionDocument, {}, { signal }), staleTime: 0 });
    } catch {
      return;
    }
    await installSession(client, read.session);
    return;
  }
  await installSession(client, null);
}
