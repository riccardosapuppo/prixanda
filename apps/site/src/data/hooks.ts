"use client";
// What the pages ask for, one hook per need. Each wraps one operation of
// src/graphql in TanStack Query, under a key that names it and its variables,
// so two parts of a page asking the same thing share one request.
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  SiteMarkets, SiteOffers, SitePlans, SiteRequestQuote, type SiteOffersQuery, type SiteRequestQuoteMutationVariables,
} from "../graphql/generated.ts";
import { LABELS, RELEASES } from "../content/editorial.ts";
import { OFFERS_REFRESH_MS } from "./config.ts";
import { isSiteMarket, SITE_MARKETS, type SiteMarket } from "./markets.ts";
import { useSiteApi } from "./provider.tsx";

export type Offer = SiteOffersQuery["offers"][number];

export const keys = {
  markets: ["markets"] as const,
  plans: (market: SiteMarket) => ["plans", market] as const,
  offers: (market: SiteMarket) => ["offers", market] as const,
};

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

/** A market's plans now, with the price a new subscriber pays. */
export function usePlans(market: SiteMarket) {
  const api = useSiteApi();
  return useQuery({
    queryKey: keys.plans(market),
    queryFn: async ({ signal }) => (await api.query(SitePlans, { market }, signal)).plans,
  });
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
  return useQuery({ queryKey: ["editorial", "labels"], queryFn: () => LABELS, initialData: LABELS, staleTime: Number.POSITIVE_INFINITY });
}

export function useReleases() {
  return useQuery({ queryKey: ["editorial", "releases"], queryFn: () => RELEASES, initialData: RELEASES, staleTime: Number.POSITIVE_INFINITY });
}

/** A quote from the engine; the variables carry the action's idempotency key. */
export function useRequestQuote() {
  const api = useSiteApi();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...variables }: SiteRequestQuoteMutationVariables & { readonly idempotencyKey: string }) =>
      api.mutate(SiteRequestQuote, variables, { idempotencyKey }),
  });
}
