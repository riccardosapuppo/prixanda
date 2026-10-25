// Changing the demo listener of this browser: entering as one of the demo's
// listeners, or leaving (DEMONSTRATION MODE, not a sign-in). The gateway
// keeps the listener in its session cookie, and the data layer sends the
// session's CSRF token from what `me` read last (provider.tsx). A reading of
// `me` that left before the change went with the old cookie: its late answer
// would put the listener of before back, with their CSRF token, after the
// cookie changed (and the next mutations fail), or keep the account page on
// them after leaving. So the new session is written only once the readings
// of `me` still on their way are cancelled: TanStack Query aborts their
// requests and drops their answers. The console does the same
// (apps/console/src/lib/session-switch.ts).
//
// The offers change with who entered, too: an offer for an artist's listeners
// comes only to a listener in its audience (§6.8). So the readings of the
// offers still on their way are dropped, the offers for an artist's listeners
// read for the listener of before go at once, and the pages read the offers
// again for the new one. The offers everyone sees stay meanwhile: a campaign
// page keeps its steps while its visitor enters on it.
import type { QueryClient } from "@tanstack/react-query";
import { type SiteMeQuery, type SiteOffersQuery, SiteSignIn, type SiteSignInMutation, SiteSignOut } from "../graphql/generated.ts";
import type { SiteApi } from "./api.ts";
import { keys } from "./keys.ts";

export type MeAnswer = SiteMeQuery["me"];

type Offers = SiteOffersQuery["offers"];

/**
 * Writes the listener an entry or an exit answered, after cancelling every
 * reading of `me` and of the offers still on its way, and has the offers read
 * again for them, without the listener of before's offers for an artist's
 * listeners meanwhile.
 */
export async function installMe(client: QueryClient, me: MeAnswer): Promise<void> {
  await client.cancelQueries({ queryKey: keys.me, exact: true });
  await client.cancelQueries({ queryKey: keys.everyOffer });
  client.setQueryData<MeAnswer>(keys.me, me);
  client.setQueriesData<Offers>({ queryKey: keys.everyOffer }, (offers) => offers?.filter((offer) => offer.listening === null));
  void client.invalidateQueries({ queryKey: keys.everyOffer });
}

/** The entry as one of the demo's listeners, as useSignIn runs it. */
export function signInOptions(api: Pick<SiteApi, "mutate">, client: QueryClient) {
  return {
    mutationFn: (listenerId: string) => api.mutate(SiteSignIn, { listenerId }, { idempotencyKey: null }),
    onSuccess: (data: SiteSignInMutation) => installMe(client, data.signInAsListener),
  };
}

/** Leaving, as useSignOut runs it. */
export function signOutOptions(api: Pick<SiteApi, "mutate">, client: QueryClient) {
  return {
    mutationFn: () => api.mutate(SiteSignOut, {}, { idempotencyKey: null }),
    onSuccess: () => installMe(client, null),
  };
}
