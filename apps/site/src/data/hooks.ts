"use client";
// What the pages ask for, one hook per need. Each wraps one operation of
// src/graphql in TanStack Query, under a key of keys.ts, so two parts of a
// page asking the same thing share one request. Mutations that change the
// demo listener's session or account update or refresh what the pages read.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { LABELS, RELEASES } from "../content/editorial.ts";
import {
  SiteConfirmSubscription, SiteDemoListeners, SiteMarkets, SiteMe, type SiteMeQuery, SiteOffers, type SiteOffersQuery, SitePlans,
  SiteRequestQuote, type SiteRequestQuoteMutationVariables, SiteSignIn, SiteSignOut, SiteVerifyStudent,
} from "../graphql/generated.ts";
import type { SiteApi } from "./api.ts";
import { OFFERS_REFRESH_MS } from "./config.ts";
import { keys } from "./keys.ts";
import { isSiteMarket, SITE_MARKETS, type SiteMarket } from "./markets.ts";
import { useSiteApi } from "./provider.tsx";

export type Offer = SiteOffersQuery["offers"][number];
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

export function useSignIn() {
  const api = useSiteApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (listenerId: string) => api.mutate(SiteSignIn, { listenerId }, { idempotencyKey: null }),
    onSuccess: (data) => client.setQueryData<SiteMeQuery["me"]>(keys.me, data.signInAsListener),
  });
}

export function useSignOut() {
  const api = useSiteApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.mutate(SiteSignOut, {}, { idempotencyKey: null }),
    onSuccess: () => client.setQueryData<SiteMeQuery["me"]>(keys.me, null),
  });
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
