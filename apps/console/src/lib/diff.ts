// What changed between two versions of a change, field by field, in the words
// a reviewer reads (business book §6.5): "Italy, offer price: €2.49 → €2.99",
// "Who can take it: ... → ...". Only the fields that differ, in a fixed order.
import { formatMoney, formatPercent } from "design";
import { planName } from "./markets.ts";
import { formatLocal } from "./time.ts";

type Money = { readonly amountMinor: string; readonly currency: string };

type Offer = {
  readonly __typename: "OfferContent";
  readonly title: string;
  readonly plan: string;
  readonly audience: {
    readonly segment: string;
    readonly currentPlan: string | null;
    readonly needsStudentCheck: boolean;
    readonly listening: { readonly artistId: number; readonly minSeconds: number; readonly withinDays: number } | null;
  };
  readonly prices: readonly { readonly market: string; readonly fixed: Money | null; readonly percentOffBasisPoints: number | null }[];
  readonly monthsAtOfferPrice: number;
  readonly periods: readonly { readonly market: string; readonly startsLocal: string; readonly endsLocal: string | null }[];
  readonly nonCombinabilityGroup: string;
  readonly redemptionCap: number | null;
  readonly pages: readonly { readonly market: string; readonly title: string; readonly text: string; readonly terms: string }[];
};
type ListPrice = { readonly __typename: "ListPriceContent"; readonly title: string; readonly plan: string; readonly market: string; readonly amount: Money; readonly startsLocal: string };
type Migration = {
  readonly __typename: "PriceMigrationContent";
  readonly title: string;
  readonly plan: string;
  readonly market: string;
  readonly amount: Money;
  readonly noticesLocal: string;
  readonly startsLocal: string;
};
type Pass = {
  readonly __typename: "PrepaidPassContent";
  readonly title: string;
  readonly plan: string;
  readonly months: number;
  readonly prices: readonly { readonly market: string; readonly amount: Money }[];
  readonly periods: readonly { readonly market: string; readonly startsLocal: string; readonly endsLocal: string | null }[];
  readonly codeValidMonths: number;
  readonly pages: readonly { readonly market: string; readonly title: string; readonly text: string; readonly terms: string }[];
};
type Content = Offer | ListPrice | Migration | Pass | { readonly __typename: string };

export type Difference = { readonly field: string; readonly before: string; readonly after: string };

type Markets = readonly { readonly code: string; readonly name: string; readonly timeZone: string }[];

/** The catalog's artists the console could name, by id; an artist not among them is "artist #4". */
export type ArtistNames = ReadonlyMap<number, string>;

/** Who can take an offer, in words. */
export function audienceWords(audience: Offer["audience"], markets: readonly string[], names: Markets, artists: ArtistNames = new Map()): string {
  const base = segmentWords(audience, markets, names);
  return audience.listening ? `${base}, ${listeningWords(audience.listening, artists)}` : base;
}

/** 10800 seconds as "3 hours", 5400 as "90 minutes", 45 as "45 seconds": the engine's words for a time (sentence.py). */
export function durationWords(seconds: number): string {
  for (const [unit, size] of [["hour", 3600], ["minute", 60]] as const) {
    if (seconds % size === 0) {
      const count = seconds / size;
      return `${count.toLocaleString("en-GB")} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return `${seconds.toLocaleString("en-GB")} second${seconds === 1 ? "" : "s"}`;
}

/** "who played Doppelfenster for more than 3 hours in the last 30 days" (§14.2). */
export function listeningWords(rule: { readonly artistId: number; readonly minSeconds: number; readonly withinDays: number }, artists: ArtistNames = new Map()): string {
  const artist = artists.get(rule.artistId) ?? `artist #${rule.artistId}`;
  return `who played ${artist} for more than ${durationWords(rule.minSeconds)} in the last ${rule.withinDays} ${rule.withinDays === 1 ? "day" : "days"}`;
}

function segmentWords(audience: Offer["audience"], markets: readonly string[], names: Markets): string {
  const where = markets.map((code) => names.find((market) => market.code === code)?.name ?? code).join(", ") || "no market";
  const who = audience.needsStudentCheck ? "verified students" : "people";
  switch (audience.segment) {
    case "NEVER_PAID":
      return `${capital(who)} in ${where} who have never paid`;
    case "FREE_LISTENERS":
      return `${capital(who)} in ${where} on the Free plan`;
    case "SUBSCRIBERS_OF_PLAN":
      return `${capital(who)} in ${where} on ${planName(audience.currentPlan ?? "a plan")}`;
    case "ANYONE":
      return `Anyone in ${where}`;
    default:
      return "Audience not chosen";
  }
}

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function priceWords(price: Offer["prices"][number] | undefined): string {
  if (price === undefined) return "none";
  if (price.fixed) return formatMoney(price.fixed);
  if (price.percentOffBasisPoints !== null) return `${formatPercent(price.percentOffBasisPoints)} off the list price`;
  return "none";
}

function periodWords(period: Offer["periods"][number] | undefined, zone: string): string {
  if (period === undefined) return "none";
  return `from ${formatLocal(period.startsLocal, zone)}${period.endsLocal ? ` to ${formatLocal(period.endsLocal, zone)}` : ", no end"}`;
}

export function describeChanges(before: Content, after: Content, markets: Markets, artists: ArtistNames = new Map()): Difference[] {
  const found: Difference[] = [];
  const add = (field: string, a: string, b: string) => {
    if (a !== b) found.push({ field, before: a, after: b });
  };
  if (before.__typename === "OfferContent" && after.__typename === "OfferContent") {
    const a = before as Offer;
    const b = after as Offer;
    add("Name", a.title, b.title);
    add("Plan", planName(a.plan), planName(b.plan));
    const marketsA = a.prices.map((price) => price.market);
    const marketsB = b.prices.map((price) => price.market);
    add("Who can take it", audienceWords(a.audience, marketsA, markets, artists), audienceWords(b.audience, marketsB, markets, artists));
    const every = [...new Set([...marketsA, ...marketsB, ...a.periods.map((p) => p.market), ...b.periods.map((p) => p.market)])];
    for (const code of every) {
      const market = markets.find((candidate) => candidate.code === code);
      const name = market?.name ?? code;
      const zone = market?.timeZone ?? "UTC";
      add(`${name}, offer price`, priceWords(a.prices.find((p) => p.market === code)), priceWords(b.prices.find((p) => p.market === code)));
      add(`${name}, dates`, periodWords(a.periods.find((p) => p.market === code), zone), periodWords(b.periods.find((p) => p.market === code), zone));
      const pageA = a.pages.find((p) => p.market === code);
      const pageB = b.pages.find((p) => p.market === code);
      add(`${name}, page title`, pageA?.title ?? "none", pageB?.title ?? "none");
      add(`${name}, page text`, pageA?.text ?? "none", pageB?.text ?? "none");
      add(`${name}, terms`, pageA?.terms ?? "none", pageB?.terms ?? "none");
    }
    add("Months at the offer price", String(a.monthsAtOfferPrice), String(b.monthsAtOfferPrice));
    add("Group", a.nonCombinabilityGroup, b.nonCombinabilityGroup);
    add("Cap on redemptions", a.redemptionCap ? String(a.redemptionCap) : "no cap", b.redemptionCap ? String(b.redemptionCap) : "no cap");
    return found;
  }
  if (before.__typename === "ListPriceContent" && after.__typename === "ListPriceContent") {
    const a = before as ListPrice;
    const b = after as ListPrice;
    add("Name", a.title, b.title);
    add("Price", formatMoney(a.amount), formatMoney(b.amount));
    add("Starts", a.startsLocal, b.startsLocal);
  }
  if (before.__typename === "PriceMigrationContent" && after.__typename === "PriceMigrationContent") {
    const a = before as Migration;
    const b = after as Migration;
    const name = (code: string) => markets.find((market) => market.code === code)?.name ?? code;
    const zoneOf = (code: string) => markets.find((market) => market.code === code)?.timeZone ?? "UTC";
    add("Name", a.title, b.title);
    add("Plan", planName(a.plan), planName(b.plan));
    add("Market", name(a.market), name(b.market));
    add("New price", formatMoney(a.amount), formatMoney(b.amount));
    add("Existing subscribers asked or told from", formatLocal(a.noticesLocal, zoneOf(a.market)), formatLocal(b.noticesLocal, zoneOf(b.market)));
    add("New subscribers pay it from", formatLocal(a.startsLocal, zoneOf(a.market)), formatLocal(b.startsLocal, zoneOf(b.market)));
  }
  if (before.__typename === "PrepaidPassContent" && after.__typename === "PrepaidPassContent") {
    const a = before as Pass;
    const b = after as Pass;
    add("Name", a.title, b.title);
    add("Plan", planName(a.plan), planName(b.plan));
    add("Months of the plan", String(a.months), String(b.months));
    add("A code waits to be activated", `${a.codeValidMonths} months`, `${b.codeValidMonths} months`);
    const every = [...new Set([...a.prices.map((p) => p.market), ...b.prices.map((p) => p.market), ...a.periods.map((p) => p.market), ...b.periods.map((p) => p.market)])];
    for (const code of every) {
      const market = markets.find((candidate) => candidate.code === code);
      const name = market?.name ?? code;
      const zone = market?.timeZone ?? "UTC";
      const price = (pass: Pass) => {
        const found = pass.prices.find((p) => p.market === code);
        return found ? formatMoney(found.amount) : "not sold";
      };
      add(`${name}, price`, price(a), price(b));
      add(`${name}, on sale`, periodWords(a.periods.find((p) => p.market === code), zone), periodWords(b.periods.find((p) => p.market === code), zone));
      const pageA = a.pages.find((p) => p.market === code);
      const pageB = b.pages.find((p) => p.market === code);
      add(`${name}, page title`, pageA?.title ?? "none", pageB?.title ?? "none");
      add(`${name}, page text`, pageA?.text ?? "none", pageB?.text ?? "none");
      add(`${name}, terms`, pageA?.terms ?? "none", pageB?.terms ?? "none");
    }
  }
  return found;
}
