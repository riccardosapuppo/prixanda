// Names the console writes for markets and plans, from the engine's codes.
export const PLAN_ORDER = ["individual", "duo", "family", "student"] as const;

export function planName(code: string): string {
  return code ? `${code.charAt(0).toUpperCase()}${code.slice(1)}` : code;
}

export type MarketInfo = { readonly code: string; readonly name: string; readonly timeZone: string; readonly currency: string };

export function marketName(markets: readonly MarketInfo[], code: string): string {
  return markets.find((market) => market.code === code)?.name ?? code;
}

export function marketZone(markets: readonly MarketInfo[], code: string): string {
  return markets.find((market) => market.code === code)?.timeZone ?? "UTC";
}

/** The markets in the order the business book lists them. */
export const MARKET_ORDER = ["IT", "FR", "DE", "GB"] as const;

export function byMarketOrder<T extends { readonly code: string }>(markets: readonly T[]): T[] {
  return [...markets].sort((a, b) => MARKET_ORDER.indexOf(a.code as never) - MARKET_ORDER.indexOf(b.code as never));
}
