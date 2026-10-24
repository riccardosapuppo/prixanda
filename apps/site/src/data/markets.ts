// The markets the site writes prices for, and how a page learns which one the
// visitor is looking at. The list of markets itself comes from the API; a
// market the site has no way of writing prices for is not shown (design's
// formatSitePrice knows Italy, France, Germany and the United Kingdom).
import type { MarketCode } from "design";

export type SiteMarket = MarketCode;

export const SITE_MARKETS: readonly SiteMarket[] = ["IT", "FR", "DE", "GB"];
export const DEFAULT_MARKET: SiteMarket = "IT";

export function isSiteMarket(code: unknown): code is SiteMarket {
  return typeof code === "string" && (SITE_MARKETS as readonly string[]).includes(code);
}

/** The market a page was asked for (?market=FR), or null when it names none the site knows. */
export function marketFromQuery(search: URLSearchParams): SiteMarket | null {
  const asked = search.get("market")?.toUpperCase();
  return isSiteMarket(asked) ? asked : null;
}

/** The short form of a market's name where space is tight: the United Kingdom is UK. */
export function marketShort(code: SiteMarket): string {
  return code === "GB" ? "UK" : code;
}
