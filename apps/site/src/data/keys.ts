// The names of what the data layer keeps, one per question asked of the API.
// Two parts of a page asking the same thing share one answer under its key.
import type { SiteMarket } from "./markets.ts";

export const keys = {
  markets: ["markets"] as const,
  plans: (market: SiteMarket) => ["plans", market] as const,
  offers: (market: SiteMarket) => ["offers", market] as const,
  /** The demo listener of this browser's session, with their account. */
  me: ["me"] as const,
  demoListeners: ["demo-listeners"] as const,
  labels: ["editorial", "labels"] as const,
  releases: ["editorial", "releases"] as const,
};
