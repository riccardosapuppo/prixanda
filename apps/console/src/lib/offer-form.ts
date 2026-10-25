// The guided creation's form: what a person types for an offer (business
// book §6.1), how it becomes the gateway's OfferInput, and the checks the
// console makes before it asks the engine anything.
//
// The checks here only stop what cannot mean anything (an empty title, a
// price that is not a price, an end before its start, more hours of
// listening than a window has) or what the engine is certain to refuse (a
// local time the clocks skip, a window longer than 90 days). Everything that
// depends on the business (the floor, conflicts with other offers, who must
// sign, how many people are eligible, how many fans an artist has) is the
// engine's validation, shown in step 5.
//
// A saved version goes through the form and back without losing anything:
// what the form does not edit (a page's treatment) is carried as it was. If a version ever holds a field the form does not know,
// cannotCarry() names it and the wizard refuses to edit that version, rather
// than save one without it.
import { MINOR_UNITS, minorUnits, parseAmount } from "design";
import { localToInstant, parseLocal, zoneCity } from "./time.ts";

export type Segment = "NEVER_PAID" | "FREE_LISTENERS" | "SUBSCRIBERS_OF_PLAN" | "ANYONE";

export type MarketForm = {
  readonly market: string;
  readonly priceKind: "fixed" | "percent";
  /** As typed, in the currency's major unit: "2.99". */
  readonly fixed: string;
  /** As typed, in percent: "40" or "12.5". */
  readonly percent: string;
  readonly startsLocal: string;
  /** Empty: no end. */
  readonly endsLocal: string;
  readonly pageTitle: string;
  readonly pageText: string;
  readonly pageTerms: string;
  /** The editorial treatment of the page; kept as saved, "standard" for a new page. */
  readonly treatment: string;
};

/** People who played an artist for more than a time lately (§14.2): the fans of a campaign for an album release. */
export type ListeningRule = { readonly artistId: number; readonly minSeconds: number; readonly withinDays: number };

export type OfferForm = {
  readonly title: string;
  readonly plan: string;
  readonly segment: Segment | "";
  readonly currentPlan: string;
  readonly needsStudentCheck: boolean;
  readonly group: string;
  /** Empty: no cap. */
  readonly cap: string;
  readonly months: string;
  readonly markets: readonly MarketForm[];
  /** Only the fans of an artist (§14.2): those who played them for more than `hours` in the last `days` days. */
  readonly fans: boolean;
  /** The artist's id in the catalog, as text ("4"); empty until one is chosen. */
  readonly artist: string;
  /** As typed: "3" or "1.5". */
  readonly hours: string;
  /** As typed: "30", the book's window. */
  readonly days: string;
};

export type Money = { readonly amountMinor: string; readonly currency: string };

export type OfferInput = {
  readonly title: string;
  readonly plan: string;
  readonly audience: { readonly segment: Segment; readonly currentPlan?: string; readonly needsStudentCheck: boolean; readonly listening?: ListeningRule };
  readonly prices: readonly { readonly market: string; readonly fixed?: Money; readonly percentOffBasisPoints?: number }[];
  readonly monthsAtOfferPrice: number;
  readonly periods: readonly { readonly market: string; readonly startsLocal: string; readonly endsLocal?: string }[];
  readonly nonCombinabilityGroup: string;
  readonly redemptionCap?: number;
  readonly pages: readonly { readonly market: string; readonly title: string; readonly text: string; readonly terms: string; readonly treatment: string }[];
};

/** A saved version's offer, as the gateway sends it. */
export type OfferContent = {
  readonly title: string;
  readonly plan: string;
  readonly audience: { readonly segment: Segment; readonly currentPlan: string | null; readonly needsStudentCheck: boolean; readonly listening: ListeningRule | null };
  readonly prices: readonly { readonly market: string; readonly fixed: Money | null; readonly percentOffBasisPoints: number | null }[];
  readonly monthsAtOfferPrice: number;
  readonly periods: readonly { readonly market: string; readonly startsLocal: string; readonly endsLocal: string | null }[];
  readonly nonCombinabilityGroup: string;
  readonly redemptionCap: number | null;
  readonly pages: readonly { readonly market: string; readonly title: string; readonly text: string; readonly terms: string; readonly treatment: string }[];
};

/** What the checks need to know about each market: its currency and its time zone. */
export type MarketFacts = Readonly<Record<string, { readonly currency: string; readonly timeZone: string; readonly name: string }>>;

export const STEPS = ["Audience", "Price", "Dates", "Page", "Check and submit"] as const;
export type StepIndex = 0 | 1 | 2 | 3 | 4;

// The engine's limits (services/commerce/src/commerce/domain/offers.py).
export const LIMITS = { title: 200, pageTitle: 120, pageText: 2000, pageTerms: 4000, monthsMax: 36, listeningDaysMax: 90 } as const;
/** The window of a fans' campaign in the business book: the last 30 days (§14.2). */
export const FANS_WINDOW_DAYS = 30;
export const GROUP = /^[a-z][a-z0-9-]{0,39}$/;
export const TREATMENT = "standard";

export function emptyMarket(market: string, startsLocal = ""): MarketForm {
  return { market, priceKind: "fixed", fixed: "", percent: "", startsLocal, endsLocal: "", pageTitle: "", pageText: "", pageTerms: "", treatment: TREATMENT };
}

export function emptyForm(): OfferForm {
  return {
    title: "", plan: "", segment: "", currentPlan: "", needsStudentCheck: false, group: "", cap: "", months: "3", markets: [],
    fans: false, artist: "", hours: "", days: String(FANS_WINDOW_DAYS),
  };
}

/**
 * Every field of a saved offer the form carries back when it saves, by the
 * schema's names. test/offer-form.test.ts holds it against the gateway's
 * schema: a field added there and not here fails the test.
 */
export const CARRIED = {
  OfferContent: ["title", "plan", "audience", "prices", "monthsAtOfferPrice", "periods", "nonCombinabilityGroup", "redemptionCap", "pages"],
  Audience: ["segment", "currentPlan", "needsStudentCheck", "listening"],
  ListeningRule: ["artistId", "minSeconds", "withinDays"],
  OfferPrice: ["market", "fixed", "percentOffBasisPoints"],
  OfferPeriod: ["market", "startsLocal", "endsLocal"],
  OfferPage: ["market", "title", "text", "terms", "treatment"],
} as const;

/** Why the form cannot carry a saved version, or null when it can: a field it does not know would be lost on saving. */
export function cannotCarry(content: unknown): string | null {
  const unknown = (value: unknown, known: readonly string[], where: string): string | null => {
    if (value === null || typeof value !== "object") return null;
    const extra = Object.keys(value).filter((key) => key !== "__typename" && !known.includes(key));
    return extra.length ? where + " holds " + extra.join(", ") : null;
  };
  const offer = content as Partial<OfferContent> | null;
  if (offer === null || typeof offer !== "object") return null;
  const found = [
    unknown(offer, CARRIED.OfferContent, "the offer"),
    unknown(offer.audience, CARRIED.Audience, "the audience"),
    unknown(offer.audience?.listening, CARRIED.ListeningRule, "the listening rule"),
    ...(offer.prices ?? []).map((price) => unknown(price, CARRIED.OfferPrice, "a price")),
    ...(offer.periods ?? []).map((period) => unknown(period, CARRIED.OfferPeriod, "a period")),
    ...(offer.pages ?? []).map((page) => unknown(page, CARRIED.OfferPage, "a page")),
  ].filter((reason): reason is string => reason !== null);
  return found.length ? "This version: " + found.join("; ") + ". This console cannot carry that, so editing it here would lose it." : null;
}

/** Minor units as a person types them back: 299 EUR as "2.99", 1000 JPY as "1000". */
export function plainAmount(money: Money): string {
  const digits = MINOR_UNITS[money.currency] ?? 2;
  const amount = minorUnits(money.amountMinor);
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const scale = 10n ** BigInt(digits);
  const units = (magnitude / scale).toString();
  const minor = (magnitude % scale).toString().padStart(digits, "0");
  return `${negative ? "-" : ""}${units}${digits ? `.${minor}` : ""}`;
}

/** 10800 seconds as "3", 5400 as "1.5", 5000 as "1.3889": what a person types back, and the same seconds again. */
export function plainHours(seconds: number): string {
  return (seconds / 3600).toFixed(4).replace(/\.?0+$/, "");
}

/** "3", "1.5" or "1,5" hours as whole seconds; null when it is not a number of hours above zero. */
export function parseHours(text: string): number | null {
  const match = /^\s*(\d{1,4})(?:[.,](\d{1,4}))?\s*$/.exec(text);
  if (match === null) return null;
  const seconds = Math.round(Number(`${match[1]}.${match[2] ?? "0"}`) * 3600);
  return seconds >= 1 ? seconds : null;
}

/** 4000 basis points as "40", 1250 as "12.5". */
export function plainPercent(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const rest = basisPoints % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, "0")}`.replace(/0+$/, "");
}

/** "40" or "12.5" as basis points; null when it is not a percentage the engine takes (0.01 to 99.99). */
export function parsePercent(text: string): number | null {
  const match = /^\s*(\d{1,2})(?:[.,](\d{1,2}))?\s*%?\s*$/.exec(text);
  if (match === null) return null;
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return basisPoints >= 1 && basisPoints <= 9999 ? basisPoints : null;
}

/** A saved offer, back into the form, so the next version starts from it. */
export function formFromContent(content: OfferContent): OfferForm {
  const markets = new Set<string>([...content.prices.map((p) => p.market), ...content.periods.map((p) => p.market), ...content.pages.map((p) => p.market)]);
  return {
    title: content.title,
    plan: content.plan,
    segment: content.audience.segment,
    currentPlan: content.audience.currentPlan ?? "",
    needsStudentCheck: content.audience.needsStudentCheck,
    group: content.nonCombinabilityGroup,
    cap: content.redemptionCap === null || content.redemptionCap === 0 ? "" : String(content.redemptionCap),
    months: String(content.monthsAtOfferPrice),
    fans: content.audience.listening !== null,
    artist: content.audience.listening ? String(content.audience.listening.artistId) : "",
    hours: content.audience.listening ? plainHours(content.audience.listening.minSeconds) : "",
    days: String(content.audience.listening?.withinDays ?? FANS_WINDOW_DAYS),
    markets: [...markets].map((market) => {
      const price = content.prices.find((p) => p.market === market);
      const period = content.periods.find((p) => p.market === market);
      const page = content.pages.find((p) => p.market === market);
      return {
        market,
        priceKind: price?.percentOffBasisPoints !== null && price?.percentOffBasisPoints !== undefined ? "percent" : "fixed",
        fixed: price?.fixed ? plainAmount(price.fixed) : "",
        percent: price?.percentOffBasisPoints ? plainPercent(price.percentOffBasisPoints) : "",
        startsLocal: period?.startsLocal ?? "",
        endsLocal: period?.endsLocal ?? "",
        pageTitle: page?.title ?? "",
        pageText: page?.text ?? "",
        pageTerms: page?.terms ?? "",
        treatment: page?.treatment || TREATMENT,
      } satisfies MarketForm;
    }),
  };
}

export type Problem = { readonly field: string; readonly message: string };

/** The field id of a market's field, as the form and its errors name it. */
export const marketField = (market: string, name: keyof MarketForm) => `${market}-${name}`;

const AUDIENCE_FIELDS = new Set(["title", "markets", "plan", "segment", "currentPlan", "fans", "artist", "hours", "days", "group", "cap"]);

/** The step a field of the form is in: where a problem with it sends the person back. */
export function stepOfField(field: string): StepIndex {
  if (AUDIENCE_FIELDS.has(field)) return 0;
  if (field === "months" || field.endsWith("-fixed") || field.endsWith("-percent")) return 1;
  if (field.includes("Local")) return 2;
  return 3;
}

function checkFans(form: OfferForm): Problem[] {
  if (!form.fans) return [];
  const problems: Problem[] = [];
  if (form.artist === "") problems.push({ field: "artist", message: "Choose the artist whose fans it is for." });
  const seconds = parseHours(form.hours);
  const days = Number(form.days);
  const daysOk = /^\d{1,2}$/.test(form.days.trim()) && days >= 1 && days <= LIMITS.listeningDaysMax;
  if (form.hours.trim() === "") problems.push({ field: "hours", message: "Type how many hours of their music a fan has played, like 3." });
  else if (seconds === null) problems.push({ field: "hours", message: `${form.hours.trim()} is not a number of hours: write it like 3 or 1.5.` });
  else if (daysOk && seconds >= days * 86_400) {
    problems.push({ field: "hours", message: `Nobody plays more than 24 hours a day: in ${days} ${days === 1 ? "day" : "days"}, fewer than ${days * 24} hours.` });
  }
  if (!daysOk) problems.push({ field: "days", message: `The window is a whole number of days, from 1 to ${LIMITS.listeningDaysMax}.` });
  return problems;
}

function checkAudience(form: OfferForm): Problem[] {
  const problems: Problem[] = [];
  const title = form.title.trim();
  if (title === "") problems.push({ field: "title", message: "Give the campaign a name: it is how the team finds it." });
  else if (title.length > LIMITS.title) problems.push({ field: "title", message: `The name is ${title.length} characters; keep it to ${LIMITS.title}.` });
  if (form.markets.length === 0) problems.push({ field: "markets", message: "Choose at least one market." });
  if (form.plan === "") problems.push({ field: "plan", message: "Choose the plan the offer is for." });
  if (form.segment === "") problems.push({ field: "segment", message: "Choose who can take it." });
  if (form.segment === "SUBSCRIBERS_OF_PLAN" && form.currentPlan === "") problems.push({ field: "currentPlan", message: "Choose the plan its subscribers are on now." });
  problems.push(...checkFans(form));
  if (!GROUP.test(form.group)) {
    problems.push({ field: "group", message: "Name the group in lower case, with letters, digits and dashes, like student-offers." });
  }
  if (form.cap.trim() !== "" && !/^\d{1,9}$/.test(form.cap.trim())) problems.push({ field: "cap", message: "A cap is a whole number of redemptions, or empty for no cap." });
  return problems;
}

function checkPrice(form: OfferForm, facts: MarketFacts): Problem[] {
  const problems: Problem[] = [];
  const months = Number(form.months);
  if (!/^\d{1,2}$/.test(form.months.trim()) || months < 1 || months > LIMITS.monthsMax) {
    problems.push({ field: "months", message: `Months at the offer price: a whole number from 1 to ${LIMITS.monthsMax}.` });
  }
  for (const market of form.markets) {
    const currency = facts[market.market]?.currency ?? "EUR";
    if (market.priceKind === "fixed") {
      const amount = parseAmount(market.fixed, currency);
      if (market.fixed.trim() === "") problems.push({ field: marketField(market.market, "fixed"), message: "Type the offer price, VAT included." });
      else if (amount === null) problems.push({ field: marketField(market.market, "fixed"), message: `${market.fixed.trim()} is not a price in ${currency}: write it like 2.99.` });
      else if (amount <= 0n) problems.push({ field: marketField(market.market, "fixed"), message: "The offer price is more than zero." });
    } else if (parsePercent(market.percent) === null) {
      problems.push({ field: marketField(market.market, "percent"), message: "A percentage off is between 0.01 and 99.99." });
    }
  }
  return problems;
}

function checkDates(form: OfferForm, facts: MarketFacts, now: Date): Problem[] {
  const problems: Problem[] = [];
  for (const market of form.markets) {
    const zone = facts[market.market]?.timeZone ?? "UTC";
    const city = zoneCity(zone);
    const starts = parseLocal(market.startsLocal);
    if (market.startsLocal === "") {
      problems.push({ field: marketField(market.market, "startsLocal"), message: "Choose when it starts." });
      continue;
    }
    if (starts === null) {
      problems.push({ field: marketField(market.market, "startsLocal"), message: "That is not a date and time." });
      continue;
    }
    const at = localToInstant(starts, zone);
    if (at.kind !== "single") {
      problems.push({
        field: marketField(market.market, "startsLocal"),
        message: `The clocks ${at.kind === "skipped" ? "skip" : "repeat"} that time in ${city} that night: choose another time.`,
      });
    } else if (at.instant.getTime() <= now.getTime()) {
      problems.push({ field: marketField(market.market, "startsLocal"), message: `That time has passed in ${city}: an offer starts in the future.` });
    }
    if (market.endsLocal !== "") {
      const ends = parseLocal(market.endsLocal);
      if (ends === null) problems.push({ field: marketField(market.market, "endsLocal"), message: "That is not a date and time." });
      else if (market.endsLocal <= market.startsLocal) problems.push({ field: marketField(market.market, "endsLocal"), message: "The end comes after the start." });
      else {
        const end = localToInstant(ends, zone);
        if (end.kind !== "single") {
          problems.push({
            field: marketField(market.market, "endsLocal"),
            message: `The clocks ${end.kind === "skipped" ? "skip" : "repeat"} that time in ${city} that night: choose another time.`,
          });
        }
      }
    }
  }
  return problems;
}

function checkPage(form: OfferForm): Problem[] {
  const problems: Problem[] = [];
  for (const market of form.markets) {
    const rules: [keyof MarketForm, string, number, string][] = [
      ["pageTitle", market.pageTitle, LIMITS.pageTitle, "the page's title"],
      ["pageText", market.pageText, LIMITS.pageText, "the text"],
      ["pageTerms", market.pageTerms, LIMITS.pageTerms, "the terms"],
    ];
    for (const [name, value, limit, what] of rules) {
      const text = value.trim();
      if (text === "") problems.push({ field: marketField(market.market, name), message: `Write ${what}: the page shows it.` });
      else if (text.length > limit) problems.push({ field: marketField(market.market, name), message: `${text.length} characters; keep ${what} to ${limit}.` });
    }
  }
  return problems;
}

/** The problems that stop a step's Continue. */
export function checkStep(form: OfferForm, step: StepIndex, facts: MarketFacts, now: Date): Problem[] {
  switch (step) {
    case 0:
      return checkAudience(form);
    case 1:
      return checkPrice(form, facts);
    case 2:
      return checkDates(form, facts, now);
    case 3:
      return checkPage(form);
    case 4:
      return [...checkAudience(form), ...checkPrice(form, facts), ...checkDates(form, facts, now), ...checkPage(form)];
  }
}

/** The first step with a problem, to send a person back there. */
export function firstStepWithProblems(form: OfferForm, facts: MarketFacts, now: Date): StepIndex | null {
  for (const step of [0, 1, 2, 3] as const) if (checkStep(form, step, facts, now).length) return step;
  return null;
}

/**
 * The form as the gateway's OfferInput, for saving a draft: the engine keeps
 * an incomplete draft (validation reports what is missing), so only what
 * the input's shape demands is required here.
 */
export function toInput(form: OfferForm, facts: MarketFacts): { input: OfferInput } | { problems: Problem[] } {
  const problems = checkAudience(form).filter((problem) => problem.field !== "markets");
  const months = Number(form.months);
  if (!/^\d{1,2}$/.test(form.months.trim()) || months < 0 || months > LIMITS.monthsMax) {
    problems.push({ field: "months", message: `Months at the offer price: a whole number from 1 to ${LIMITS.monthsMax}.` });
  }
  const prices: OfferInput["prices"][number][] = [];
  const periods: OfferInput["periods"][number][] = [];
  const pages: OfferInput["pages"][number][] = [];
  for (const market of form.markets) {
    const currency = facts[market.market]?.currency ?? "EUR";
    if (market.priceKind === "fixed" && market.fixed.trim() !== "") {
      const amount = parseAmount(market.fixed, currency);
      if (amount === null || amount <= 0n) problems.push({ field: marketField(market.market, "fixed"), message: `${market.fixed.trim()} is not a price in ${currency}: write it like 2.99.` });
      else prices.push({ market: market.market, fixed: { amountMinor: amount.toString(), currency } });
    } else if (market.priceKind === "percent" && market.percent.trim() !== "") {
      const basisPoints = parsePercent(market.percent);
      if (basisPoints === null) problems.push({ field: marketField(market.market, "percent"), message: "A percentage off is between 0.01 and 99.99." });
      else prices.push({ market: market.market, percentOffBasisPoints: basisPoints });
    }
    if (market.startsLocal !== "") {
      if (parseLocal(market.startsLocal) === null) problems.push({ field: marketField(market.market, "startsLocal"), message: "That is not a date and time." });
      else if (market.endsLocal !== "" && parseLocal(market.endsLocal) === null) problems.push({ field: marketField(market.market, "endsLocal"), message: "That is not a date and time." });
      else periods.push({ market: market.market, startsLocal: market.startsLocal, ...(market.endsLocal ? { endsLocal: market.endsLocal } : {}) });
    }
    if (market.pageTitle.trim() || market.pageText.trim() || market.pageTerms.trim()) {
      pages.push({ market: market.market, title: market.pageTitle.trim(), text: market.pageText.trim(), terms: market.pageTerms.trim(), treatment: market.treatment || TREATMENT });
    }
  }
  if (problems.length) return { problems };
  const segment = form.segment as Segment;
  return {
    input: {
      title: form.title.trim(),
      plan: form.plan,
      audience: {
        segment,
        ...(segment === "SUBSCRIBERS_OF_PLAN" && form.currentPlan ? { currentPlan: form.currentPlan } : {}),
        needsStudentCheck: form.needsStudentCheck,
        ...(form.fans ? { listening: { artistId: Number(form.artist), minSeconds: parseHours(form.hours) ?? 0, withinDays: Number(form.days) } } : {}),
      },
      prices,
      monthsAtOfferPrice: months,
      periods,
      nonCombinabilityGroup: form.group,
      ...(form.cap.trim() !== "" ? { redemptionCap: Number(form.cap.trim()) } : {}),
      pages,
    },
  };
}

/** Whether the form says something the saved version does not: then saving makes a new version. */
export function differsFrom(form: OfferForm, content: OfferContent | null, facts: MarketFacts): boolean {
  if (content === null) return true;
  const typed = toInput(form, facts);
  if ("problems" in typed) return true;
  return JSON.stringify(normalise(typed.input)) !== JSON.stringify(normalise(inputOf(content)));
}

function inputOf(content: OfferContent): OfferInput {
  return {
    title: content.title,
    plan: content.plan,
    audience: {
      segment: content.audience.segment,
      ...(content.audience.currentPlan ? { currentPlan: content.audience.currentPlan } : {}),
      needsStudentCheck: content.audience.needsStudentCheck,
      ...(content.audience.listening ? { listening: { ...content.audience.listening } } : {}),
    },
    prices: content.prices.map((price) => ({
      market: price.market,
      ...(price.fixed ? { fixed: price.fixed } : {}),
      ...(price.percentOffBasisPoints !== null ? { percentOffBasisPoints: price.percentOffBasisPoints } : {}),
    })),
    monthsAtOfferPrice: content.monthsAtOfferPrice,
    periods: content.periods.map((period) => ({ market: period.market, startsLocal: period.startsLocal, ...(period.endsLocal ? { endsLocal: period.endsLocal } : {}) })),
    nonCombinabilityGroup: content.nonCombinabilityGroup,
    ...(content.redemptionCap ? { redemptionCap: content.redemptionCap } : {}),
    pages: content.pages.map((page) => ({ market: page.market, title: page.title, text: page.text, terms: page.terms, treatment: page.treatment })),
  };
}

function normalise(input: OfferInput): unknown {
  const byMarket = <T extends { market: string }>(list: readonly T[]) => [...list].sort((a, b) => a.market.localeCompare(b.market));
  return {
    ...input,
    prices: byMarket(input.prices).map((price) => ({ ...price, ...(price.fixed ? { fixed: { amountMinor: String(minorUnits(price.fixed.amountMinor)), currency: price.fixed.currency } } : {}) })),
    periods: byMarket(input.periods).map((period) => ({ ...period, startsLocal: period.startsLocal.replace(/:00$/, "").slice(0, 16), ...(period.endsLocal ? { endsLocal: period.endsLocal.slice(0, 16) } : {}) })),
    pages: byMarket(input.pages),
  };
}
