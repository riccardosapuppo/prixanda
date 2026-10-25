// The form of a prepaid pass (business book §9, §14.4): months of a plan
// paid once, in advance, sold as a single-use code that can be kept or
// given. Its price is fixed in each market where it is sold, VAT included;
// it is on sale for a period there, has its page there, and a code sold can
// wait a number of months to be activated. What the commercial lead types,
// how it becomes the gateway's PrepaidPassInput, and the checks the console
// makes before it asks the engine anything: only what cannot mean anything,
// as for a campaign (offer-form.ts). The floor, the dates to come and who
// signs are the engine's validation, shown in the last step.
import { minorUnits, parseAmount } from "design";
import { LIMITS, type MarketFacts, type Money, type Problem } from "./offer-form.ts";
import { formatLocalValue, localToInstant, nextWeekday, parseLocal, partsIn, zoneCity } from "./time.ts";

export type PassMarketForm = {
  readonly market: string;
  /** As typed, in the currency's major unit: "29.99". */
  readonly price: string;
  readonly startsLocal: string;
  /** Empty: on sale with no end announced. */
  readonly endsLocal: string;
  readonly pageTitle: string;
  readonly pageText: string;
  readonly pageTerms: string;
  /** Kept as saved, "standard" for a new page. */
  readonly treatment: string;
};

export type PassForm = {
  readonly title: string;
  readonly plan: string;
  readonly months: string;
  readonly codeValidMonths: string;
  readonly markets: readonly PassMarketForm[];
};

export type PassInput = {
  readonly title: string;
  readonly plan: string;
  readonly months: number;
  readonly prices: readonly { readonly market: string; readonly amount: Money }[];
  readonly periods: readonly { readonly market: string; readonly startsLocal: string; readonly endsLocal?: string }[];
  readonly codeValidMonths: number;
  readonly pages: readonly { readonly market: string; readonly title: string; readonly text: string; readonly terms: string; readonly treatment: string }[];
};

/** A saved version's pass, as the gateway sends it. */
export type PassContent = {
  readonly title: string;
  readonly plan: string;
  readonly months: number;
  readonly prices: readonly { readonly market: string; readonly amount: Money }[];
  readonly periods: readonly { readonly market: string; readonly startsLocal: string; readonly endsLocal: string | null }[];
  readonly codeValidMonths: number;
  readonly pages: readonly { readonly market: string; readonly title: string; readonly text: string; readonly terms: string; readonly treatment: string }[];
};

export const PASS_STEPS = ["The pass", "Price", "On sale", "Page", "Check and submit"] as const;
export type PassStep = 0 | 1 | 2 | 3 | 4;

// The engine's limits (services/commerce/src/commerce/domain/offers.py).
export const PASS_LIMITS = { monthsMax: 24, codeValidMonthsMax: 36 } as const;

/**
 * The plans a pass can give: a plan anyone can have. A gift code cannot
 * carry a student verification, so there is no Student pass (§9.3).
 */
export const PASS_PLANS = ["individual", "duo", "family"] as const;

/**
 * Every field of a saved pass the form carries back when it saves, by the
 * schema's names. test/pass-form.test.ts holds it against the gateway's
 * schema: a field added there and not here fails the test.
 */
export const PASS_CARRIED = {
  PrepaidPassContent: ["title", "plan", "months", "prices", "periods", "codeValidMonths", "pages"],
  PrepaidPassPrice: ["market", "amount"],
  OfferPeriod: ["market", "startsLocal", "endsLocal"],
  OfferPage: ["market", "title", "text", "terms", "treatment"],
} as const;

export const TREATMENT = "standard";

/** The field id of a market's field, as the form and its errors name it. */
export const passField = (market: string, name: keyof PassMarketForm) => `${market}-${name}`;

/** The step an engine's finding sends the author back to. */
export const PASS_STEP_OF_CHECK: Readonly<Record<string, PassStep>> = {
  audience: 0, price: 1, floor: 1, dates: 2, time_zone: 2, page_text: 3,
};

/** The step a field is typed in. */
export function passStepOf(field: string): PassStep {
  if (["title", "plan", "months", "codeValidMonths", "markets"].includes(field)) return 0;
  if (field.endsWith("-price")) return 1;
  if (field.endsWith("Local")) return 2;
  return 3;
}

export function emptyPassMarket(market: string, startsLocal = ""): PassMarketForm {
  return { market, price: "", startsLocal, endsLocal: "", pageTitle: "", pageText: "", pageTerms: "", treatment: TREATMENT };
}

export function emptyPass(): PassForm {
  return { title: "", plan: "", months: "3", codeValidMonths: "12", markets: [] };
}

/** Minor units as a person types them back: 2999 EUR as "29.99". */
function plain(money: Money): string {
  const amount = minorUnits(money.amountMinor);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`;
}

/** A saved pass, back into the form, so the next version starts from it. */
export function passFromContent(content: PassContent): PassForm {
  const markets = new Set<string>([...content.prices.map((p) => p.market), ...content.periods.map((p) => p.market), ...content.pages.map((p) => p.market)]);
  return {
    title: content.title,
    plan: content.plan,
    months: String(content.months),
    codeValidMonths: String(content.codeValidMonths),
    markets: [...markets].map((market) => {
      const price = content.prices.find((p) => p.market === market);
      const period = content.periods.find((p) => p.market === market);
      const page = content.pages.find((p) => p.market === market);
      return {
        market,
        price: price ? plain(price.amount) : "",
        startsLocal: period?.startsLocal.slice(0, 16) ?? "",
        endsLocal: period?.endsLocal?.slice(0, 16) ?? "",
        pageTitle: page?.title ?? "",
        pageText: page?.text ?? "",
        pageTerms: page?.terms ?? "",
        treatment: page?.treatment || TREATMENT,
      } satisfies PassMarketForm;
    }),
  };
}

/**
 * The example of the business book (§9.1): three months of Individual, paid
 * in advance, €29.99 in Italy, on sale from the next Monday at 09:00 in Rome;
 * a code sold waits up to 12 months to be activated.
 */
export function giftPassExample(now: Date): PassForm {
  const monday = nextWeekday({ ...partsIn(now, "Europe/Rome"), second: 0 }, 1, 9);
  return {
    title: "Three-month gift pass",
    plan: "individual",
    months: "3",
    codeValidMonths: "12",
    markets: [{
      ...emptyPassMarket("IT", formatLocalValue(monday)),
      price: "29.99",
      pageTitle: "Three months of Individual, as a gift",
      pageText: "Three months of Individual, paid once: 29,99 €. A code to keep or to give.",
      pageTerms: "A single-use code for Italy, to activate within 12 months of the purchase. It never renews, and price changes made after the purchase do not touch it.",
    }],
  };
}

const whole = (text: string, low: number, high: number) => /^\d{1,3}$/.test(text.trim()) && Number(text) >= low && Number(text) <= high;

function checkPass(form: PassForm): Problem[] {
  const problems: Problem[] = [];
  const title = form.title.trim();
  if (title === "") problems.push({ field: "title", message: "Give the pass a name: it is how the team finds it." });
  else if (title.length > LIMITS.title) problems.push({ field: "title", message: `The name is ${title.length} characters; keep it to ${LIMITS.title}.` });
  if (form.plan === "") problems.push({ field: "plan", message: "Choose the plan the pass gives." });
  if (!whole(form.months, 1, PASS_LIMITS.monthsMax)) problems.push({ field: "months", message: `Months of the plan: a whole number from 1 to ${PASS_LIMITS.monthsMax}.` });
  if (!whole(form.codeValidMonths, 1, PASS_LIMITS.codeValidMonthsMax)) {
    problems.push({ field: "codeValidMonths", message: `Months a code can wait: a whole number from 1 to ${PASS_LIMITS.codeValidMonthsMax}.` });
  }
  if (form.markets.length === 0) problems.push({ field: "markets", message: "Choose at least one market." });
  return problems;
}

function checkPrices(form: PassForm, facts: MarketFacts): Problem[] {
  const problems: Problem[] = [];
  for (const market of form.markets) {
    const currency = facts[market.market]?.currency ?? "EUR";
    const typed = market.price.trim();
    const amount = parseAmount(typed, currency);
    const field = passField(market.market, "price");
    if (typed === "") problems.push({ field, message: "Type the pass's price, VAT included." });
    else if (amount === null) problems.push({ field, message: `${typed} is not a price in ${currency}: write it like 29.99.` });
    else if (amount <= 0n) problems.push({ field, message: "The price is more than zero." });
  }
  return problems;
}

function checkPeriods(form: PassForm, facts: MarketFacts, now: Date): Problem[] {
  const problems: Problem[] = [];
  for (const market of form.markets) {
    const zone = facts[market.market]?.timeZone ?? "UTC";
    const city = zoneCity(zone);
    const field = passField(market.market, "startsLocal");
    const starts = parseLocal(market.startsLocal);
    if (market.startsLocal === "") {
      problems.push({ field, message: "Choose when it goes on sale." });
      continue;
    }
    if (starts === null) {
      problems.push({ field, message: "That is not a date and time." });
      continue;
    }
    const at = localToInstant(starts, zone);
    if (at.kind !== "single") problems.push({ field, message: `The clocks ${at.kind === "skipped" ? "skip" : "repeat"} that time in ${city} that night: choose another time.` });
    else if (at.instant.getTime() <= now.getTime()) problems.push({ field, message: `That time has passed in ${city}: a pass goes on sale in the future.` });
    if (market.endsLocal !== "") {
      const endField = passField(market.market, "endsLocal");
      const ends = parseLocal(market.endsLocal);
      if (ends === null) problems.push({ field: endField, message: "That is not a date and time." });
      else if (market.endsLocal.slice(0, 16) <= market.startsLocal.slice(0, 16)) problems.push({ field: endField, message: "The end of the sale comes after its start." });
      else {
        const end = localToInstant(ends, zone);
        if (end.kind !== "single") problems.push({ field: endField, message: `The clocks ${end.kind === "skipped" ? "skip" : "repeat"} that time in ${city} that night: choose another time.` });
      }
    }
  }
  return problems;
}

function checkPages(form: PassForm): Problem[] {
  const problems: Problem[] = [];
  for (const market of form.markets) {
    const rules: [keyof PassMarketForm, string, number, string][] = [
      ["pageTitle", market.pageTitle, LIMITS.pageTitle, "the page's title"],
      ["pageText", market.pageText, LIMITS.pageText, "the text"],
      ["pageTerms", market.pageTerms, LIMITS.pageTerms, "the terms"],
    ];
    for (const [name, value, limit, what] of rules) {
      const text = value.trim();
      if (text === "") problems.push({ field: passField(market.market, name), message: `Write ${what}: the page shows it.` });
      else if (text.length > limit) problems.push({ field: passField(market.market, name), message: `${text.length} characters; keep ${what} to ${limit}.` });
    }
  }
  return problems;
}

/** The problems that stop a step's Continue; the last step gathers them all. */
export function checkPassStep(form: PassForm, step: PassStep, facts: MarketFacts, now: Date): Problem[] {
  switch (step) {
    case 0:
      return checkPass(form);
    case 1:
      return checkPrices(form, facts);
    case 2:
      return checkPeriods(form, facts, now);
    case 3:
      return checkPages(form);
    case 4:
      return [...checkPass(form), ...checkPrices(form, facts), ...checkPeriods(form, facts, now), ...checkPages(form)];
  }
}

/**
 * The form as the gateway's PrepaidPassInput, for saving a draft: the engine
 * keeps an incomplete draft (its validation says what is missing), so only
 * what the input's shape demands is required here.
 */
export function toPassInput(form: PassForm, facts: MarketFacts): { input: PassInput } | { problems: Problem[] } {
  const problems = checkPass(form).filter((problem) => problem.field !== "markets");
  const prices: PassInput["prices"][number][] = [];
  const periods: PassInput["periods"][number][] = [];
  const pages: PassInput["pages"][number][] = [];
  for (const market of form.markets) {
    const currency = facts[market.market]?.currency ?? "EUR";
    if (market.price.trim() !== "") {
      const amount = parseAmount(market.price.trim(), currency);
      if (amount === null || amount <= 0n) problems.push({ field: passField(market.market, "price"), message: `${market.price.trim()} is not a price in ${currency}: write it like 29.99.` });
      else prices.push({ market: market.market, amount: { amountMinor: amount.toString(), currency } });
    }
    if (market.startsLocal !== "") {
      if (parseLocal(market.startsLocal) === null) problems.push({ field: passField(market.market, "startsLocal"), message: "That is not a date and time." });
      else if (market.endsLocal !== "" && parseLocal(market.endsLocal) === null) problems.push({ field: passField(market.market, "endsLocal"), message: "That is not a date and time." });
      else periods.push({ market: market.market, startsLocal: market.startsLocal.slice(0, 16), ...(market.endsLocal ? { endsLocal: market.endsLocal.slice(0, 16) } : {}) });
    }
    if (market.pageTitle.trim() || market.pageText.trim() || market.pageTerms.trim()) {
      pages.push({ market: market.market, title: market.pageTitle.trim(), text: market.pageText.trim(), terms: market.pageTerms.trim(), treatment: market.treatment || TREATMENT });
    }
  }
  if (problems.length) return { problems };
  return {
    input: {
      title: form.title.trim(),
      plan: form.plan,
      months: Number(form.months),
      prices,
      periods,
      codeValidMonths: Number(form.codeValidMonths),
      pages,
    },
  };
}

function inputOf(content: PassContent): PassInput {
  return {
    title: content.title,
    plan: content.plan,
    months: content.months,
    prices: content.prices.map((price) => ({ market: price.market, amount: price.amount })),
    periods: content.periods.map((period) => ({ market: period.market, startsLocal: period.startsLocal, ...(period.endsLocal ? { endsLocal: period.endsLocal } : {}) })),
    codeValidMonths: content.codeValidMonths,
    pages: content.pages.map((page) => ({ market: page.market, title: page.title, text: page.text, terms: page.terms, treatment: page.treatment })),
  };
}

function normalise(input: PassInput): string {
  const byMarket = <T extends { market: string }>(list: readonly T[]) => [...list].sort((a, b) => a.market.localeCompare(b.market));
  return JSON.stringify({
    ...input,
    prices: byMarket(input.prices).map((price) => ({ market: price.market, amount: { amountMinor: String(minorUnits(price.amount.amountMinor)), currency: price.amount.currency } })),
    periods: byMarket(input.periods).map((period) => ({ ...period, startsLocal: period.startsLocal.slice(0, 16), ...(period.endsLocal ? { endsLocal: period.endsLocal.slice(0, 16) } : {}) })),
    pages: byMarket(input.pages),
  });
}

/** Whether the form says something the saved version does not: then saving makes a new version. */
export function passDiffers(form: PassForm, content: PassContent | null, facts: MarketFacts): boolean {
  if (content === null) return true;
  const typed = toPassInput(form, facts);
  if ("problems" in typed) return true;
  return normalise(typed.input) !== normalise(inputOf(content));
}
