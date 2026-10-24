"use client";
// What the pages ask for, one hook per need. Each wraps one operation of
// src/graphql in TanStack Query, under a key of keys.ts, so two parts of a
// page asking the same thing share one request. Mutations that change the
// demo listener's session or account update or refresh what the pages read.
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { LABELS, RELEASES } from "../content/editorial.ts";
import {
  SiteActivatePrepaidPass, SiteAnswerPriceChange, SiteBuyPrepaidPass, SiteConfirmSubscription, SiteDemoListeners, SiteMarkets, SiteMe,
  type SiteMeQuery, SiteOffers, type SiteOffersQuery, SitePlans, SitePrepaidPasses, type SitePrepaidPassesQuery, SiteRequestQuote,
  type SiteRequestQuoteMutationVariables, SiteVerifyStudent,
} from "../graphql/generated.ts";
import type { SiteApi } from "./api.ts";
import { OFFERS_REFRESH_MS } from "./config.ts";
import { keys } from "./keys.ts";
import { isSiteMarket, SITE_MARKETS, type SiteMarket } from "./markets.ts";
import { useSiteApi } from "./provider.tsx";
import { signInOptions, signOutOptions } from "./session.ts";

export type Offer = SiteOffersQuery["offers"][number];
export type PrepaidPass = SitePrepaidPassesQuery["prepaidPasses"][number];
export type Me = NonNullable<SiteMeQuery["me"]>;

export { keys };

/** The markets the API sells in that the site can write prices for, in the site's order (Italy first). */
export function useMarkets() {
  const api = useSiteApi();
  return useQuery({
    queryKey: keys.markets,
    queryFn: async ({ signal }) => (await api.query(SiteMarkets, {}, signal)).markets
      .filter((market) => isSiteMarket(market.code))
      .toSorted((a, b) => SITE_MARKETS.indexOf(a.code as SiteMarket) - SITE_MARKETS.indexOf(b.code as SiteMarket)),
    staleTime: 10 * 60_000,
  });
}

const plansQuery = (api: SiteApi, market: SiteMarket) => ({
  queryKey: keys.plans(market),
  queryFn: async ({ signal }: { readonly signal: AbortSignal }) => (await api.query(SitePlans, { market }, signal)).plans,
});

/** A market's plans now, with the price a new subscriber pays and where it goes. */
export function usePlans(market: SiteMarket) {
  const api = useSiteApi();
  return useQuery(plansQuery(api, market));
}

/**
 * Asks for the plans of every market once the page has shown its own, so a
 * visitor who changes market sees its prices at once (and the page reads
 * them again in the background, as for any page that opens).
 */
export function usePrefetchPlans(when: boolean) {
  const api = useSiteApi();
  const client = useQueryClient();
  useEffect(() => {
    if (!when) return;
    for (const market of SITE_MARKETS) void client.prefetchQuery({ ...plansQuery(api, market), staleTime: 60_000 });
  }, [when, api, client]);
}

/**
 * The offers on sale in a market now. An open page asks again every
 * OFFERS_REFRESH_MS while it is visible, so an offer that launches shows up
 * without a reload, and one that ends goes away.
 */
export function useOffers(market: SiteMarket, { live = true }: { readonly live?: boolean } = {}) {
  const api = useSiteApi();
  return useQuery({
    queryKey: keys.offers(market),
    queryFn: async ({ signal }) => (await api.query(SiteOffers, { market }, signal)).offers,
    staleTime: 0,
    refetchInterval: live ? OFFERS_REFRESH_MS : false,
  });
}

const prepaidPassesQuery = (api: SiteApi, market: SiteMarket, live: boolean) => ({
  queryKey: keys.prepaidPasses(market),
  queryFn: async ({ signal }: { readonly signal: AbortSignal }) => (await api.query(SitePrepaidPasses, { market }, signal)).prepaidPasses,
  staleTime: 0,
  refetchInterval: live ? OFFERS_REFRESH_MS : (false as const),
});

/** The prepaid passes on sale in a market now (§9), asked again like the offers while the page is open. */
export function usePrepaidPasses(market: SiteMarket, { live = true }: { readonly live?: boolean } = {}) {
  const api = useSiteApi();
  return useQuery(prepaidPassesQuery(api, market, live));
}

/**
 * The prepaid passes on sale in every market the site knows: where a pass is
 * sold, when the market the visitor looks at has none. The header asks it
 * too, to offer the way to the pass only while one is on sale somewhere.
 */
export function usePrepaidPassesEverywhere({ live = true }: { readonly live?: boolean } = {}) {
  const api = useSiteApi();
  return useQueries({
    queries: SITE_MARKETS.map((market) => prepaidPassesQuery(api, market, live)),
    combine: (results) => ({
      passes: results.flatMap((result) => result.data ?? []),
      settled: results.every((result) => !result.isPending),
    }),
  });
}

/**
 * The editorial catalogue (src/content/editorial.ts): static content of the
 * fictional service, served through the data layer like the rest, so a page
 * cannot tell, and a remote catalogue would change only these two hooks.
 */
export function useLabels() {
  return useQuery({ queryKey: keys.labels, queryFn: () => LABELS, initialData: LABELS, staleTime: Number.POSITIVE_INFINITY });
}

export function useReleases() {
  return useQuery({ queryKey: keys.releases, queryFn: () => RELEASES, initialData: RELEASES, staleTime: Number.POSITIVE_INFINITY });
}

// ---------------------------------------------------------------------------
// The demo listener. DEMONSTRATION MODE: the visitor picks one of the demo's
// invented listeners; the gateway keeps the choice in an HttpOnly cookie, and
// every call below acts for that listener. Not a sign-in.

/**
 * The listener of this browser, with their account; null when nobody entered.
 * `readAgain`, given what was read last, says in how many milliseconds to read
 * again (false: not by itself).
 */
export function useMe({ readAgain }: { readonly readAgain?: (me: Me | null | undefined) => number | false } = {}) {
  const api = useSiteApi();
  return useQuery({
    queryKey: keys.me,
    queryFn: async ({ signal }) => (await api.query(SiteMe, {}, signal)).me,
    staleTime: 0,
    refetchInterval: readAgain ? (query) => readAgain(query.state.data) : false,
    // The session lives in a cookie: every tab reads it from the API.
    refetchOnWindowFocus: true,
  });
}

export function useDemoListeners() {
  const api = useSiteApi();
  return useQuery({
    queryKey: keys.demoListeners,
    queryFn: async ({ signal }) => (await api.query(SiteDemoListeners, {}, signal)).demoListeners,
    staleTime: 10 * 60_000,
  });
}

/** Enters as one of the demo's listeners; the readings of `me` still on their way are cancelled first (session.ts). */
export function useSignIn() {
  const api = useSiteApi();
  const client = useQueryClient();
  return useMutation(signInOptions(api, client));
}

/** Leaves the demo; the readings of `me` still on their way are cancelled first (session.ts). */
export function useSignOut() {
  const api = useSiteApi();
  const client = useQueryClient();
  return useMutation(signOutOptions(api, client));
}

/** The simulated provider checks the session's listener as a student; the account then shows the check. */
export function useVerifyStudent() {
  const api = useSiteApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (idempotencyKey: string) => api.mutate(SiteVerifyStudent, {}, { idempotencyKey }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.me }),
  });
}

/** A quote from the engine; the variables carry the action's idempotency key. */
export function useRequestQuote() {
  const api = useSiteApi();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...variables }: SiteRequestQuoteMutationVariables & { readonly idempotencyKey: string }) =>
      api.mutate(SiteRequestQuote, variables, { idempotencyKey }),
  });
}

/** A yes or a no to a price change of the session's listener (§8); the account then shows what follows. */
export function useAnswerPriceChange() {
  const api = useSiteApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ priceChangeId, accept, idempotencyKey }: { readonly priceChangeId: string; readonly accept: boolean; readonly idempotencyKey: string }) =>
      api.mutate(SiteAnswerPriceChange, { priceChangeId, accept }, { idempotencyKey }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.me }),
  });
}

/**
 * Buys a prepaid pass for the session's listener, to keep or to give (§9). A
 * demonstration: the simulated provider settles the payment moments later, and
 * the code comes back pending until it does.
 */
export function useBuyPrepaidPass() {
  const api = useSiteApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ passId, idempotencyKey }: { readonly passId: string; readonly idempotencyKey: string }) =>
      api.mutate(SiteBuyPrepaidPass, { passId }, { idempotencyKey }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.me }),
  });
}

/** Activates a prepaid pass's code for the session's listener: its months from today, never charged, then Free (§9). */
export function useActivatePrepaidPass() {
  const api = useSiteApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ code, idempotencyKey }: { readonly code: string; readonly idempotencyKey: string }) =>
      api.mutate(SiteActivatePrepaidPass, { code }, { idempotencyKey }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.me }),
  });
}

/** Confirms a quote by its id: the demo subscription starts, its first payment pending (§4.5). */
export function useConfirmSubscription() {
  const api = useSiteApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ quoteId, idempotencyKey }: { readonly quoteId: string; readonly idempotencyKey: string }) =>
      api.mutate(SiteConfirmSubscription, { quoteId }, { idempotencyKey }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.me }),
  });
}
