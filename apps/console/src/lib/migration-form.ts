// The form of a price migration (business book §8, §14.3): a higher price
// for one plan in one market, which new subscribers pay from a date, and
// which the existing ones are asked to accept, or told about, from another,
// by the rules of their market. What the commercial lead types, how it
// becomes the gateway's PriceMigrationInput, and the checks the console
// makes before it asks the engine anything.
//
// As in the guided creation of a campaign (offer-form.ts), the checks here
// only stop what cannot mean anything: an empty name, a price that is not a
// price, a time the clocks skip, new subscribers paying before the existing
// ones are asked. Whether the price rises above the one in force, whether
// another change already moves this price, and who signs are the engine's
// validation (its findings price, dates and overlap), shown in the last step.
import { minorUnits, parseAmount } from "design";
import { LIMITS, type MarketFacts, type Money, type Problem } from "./offer-form.ts";
import { addLocalDays, contractLocal, formatLocalValue, localToInstant, nextWeekday, parseLocal, partsIn, zoneCity } from "./time.ts";

export type MigrationForm = {
  readonly title: string;
  readonly plan: string;
  readonly market: string;
  /** As typed, in the currency's major unit: "20.99". */
  readonly amount: string;
  /** When the existing subscribers are asked or told, local to the market. */
  readonly noticesLocal: string;
  /** When new subscribers start paying the new price, local to the market. */
  readonly startsLocal: string;
};

export type MigrationInput = {
  readonly title: string;
  readonly plan: string;
  readonly market: string;
  readonly amount: Money;
  readonly noticesLocal: string;
  readonly startsLocal: string;
};

/** A saved version's migration, as the gateway sends it. */
export type MigrationContent = MigrationInput;

export const MIGRATION_STEPS = ["New price", "Dates", "Check and submit"] as const;
export type MigrationStep = 0 | 1 | 2;

/**
 * Every field of a saved migration the form carries back when it saves, by
 * the schema's names. test/migration-form.test.ts holds it against the
 * gateway's schema: a field added there and not here fails the test.
 */
export const MIGRATION_CARRIED = {
  PriceMigrationContent: ["title", "plan", "market", "amount", "noticesLocal", "startsLocal"],
} as const;

/** The plans a price migration can raise: the paid ones. */
export const MIGRATION_PLANS = ["individual", "duo", "family", "student"] as const;

/** The field of each step, in order, for "go to step" links and for the focus after a failed Continue. */
export const MIGRATION_FIELDS: Readonly<Record<MigrationStep, readonly string[]>> = {
  0: ["title", "market", "plan", "amount"],
  1: ["noticesLocal", "startsLocal"],
  2: [],
};

/** The step a field is typed in. */
export function migrationStepOf(field: string): MigrationStep {
  return MIGRATION_FIELDS[1].includes(field) ? 1 : 0;
}

/** The step an engine's finding sends the author back to: the price and what clashes with it, or the dates. */
export const MIGRATION_STEP_OF_CHECK: Readonly<Record<string, MigrationStep>> = {
  price: 0, floor: 0, overlap: 0, dates: 1, time_zone: 1,
};

export function emptyMigration(): MigrationForm {
  return { title: "", plan: "", market: "", amount: "", noticesLocal: "", startsLocal: "" };
}

/** Minor units as a person types them back: 2099 EUR as "20.99". */
function plain(money: Money): string {
  const amount = minorUnits(money.amountMinor);
  const units = amount / 100n;
  const minor = (amount % 100n).toString().padStart(2, "0");
  return `${units}.${minor}`;
}

/** A saved migration, back into the form, so the next version starts from it. */
export function migrationFromContent(content: MigrationContent): MigrationForm {
  return {
    title: content.title,
    plan: content.plan,
    market: content.market,
    amount: plain(content.amount),
    noticesLocal: contractLocal(content.noticesLocal),
    startsLocal: contractLocal(content.startsLocal),
  };
}

/**
 * The example of the business book (§14.3): the Family plan in Germany from
 * €18.99 to €20.99. The existing subscribers are asked on the first Monday
 * at least a week ahead, at 09:00 in Berlin, and new subscribers pay it from
 * the first day of a month at least four weeks after that: on 24 October
 * 2026, 2 November and 1 December, the book's own dates.
 */
export function familyRiseExample(now: Date): MigrationForm {
  const today = partsIn(now, "Europe/Berlin");
  const notices = nextWeekday({ ...addLocalDays(today, 6), second: 0 }, 1, 9);
  const after = addLocalDays(notices, 28);
  const firstOfMonth = after.day === 1
    ? { ...after, hour: 0, minute: 0, second: 0 }
    : { ...after, year: after.month === 12 ? after.year + 1 : after.year, month: after.month === 12 ? 1 : after.month + 1, day: 1, hour: 0, minute: 0, second: 0 };
  return {
    title: "Family price rise, Germany",
    plan: "family",
    market: "DE",
    amount: "20.99",
    noticesLocal: formatLocalValue(notices),
    startsLocal: formatLocalValue(firstOfMonth),
  };
}

function checkPrice(form: MigrationForm, facts: MarketFacts): Problem[] {
  const problems: Problem[] = [];
  const title = form.title.trim();
  if (title === "") problems.push({ field: "title", message: "Give the migration a name: it is how the team finds it." });
  else if (title.length > LIMITS.title) problems.push({ field: "title", message: `The name is ${title.length} characters; keep it to ${LIMITS.title}.` });
  if (form.market === "") problems.push({ field: "market", message: "Choose the market whose price rises." });
  if (form.plan === "") problems.push({ field: "plan", message: "Choose the plan whose price rises." });
  const currency = facts[form.market]?.currency ?? "EUR";
  const typed = form.amount.trim();
  const amount = parseAmount(typed, currency);
  if (typed === "") problems.push({ field: "amount", message: "Type the new price, VAT included." });
  else if (amount === null) problems.push({ field: "amount", message: `${typed} is not a price in ${currency}: write it like 20.99.` });
  else if (amount <= 0n) problems.push({ field: "amount", message: "The new price is more than zero." });
  return problems;
}

/** A local time a person typed: a problem when it is missing, not a time, or one the clocks skip or repeat. */
function checkTime(field: string, value: string, zone: string, what: string): Problem | null {
  const city = zoneCity(zone);
  if (value === "") return { field, message: `Choose ${what}.` };
  const parts = parseLocal(value);
  if (parts === null) return { field, message: "That is not a date and time." };
  const at = localToInstant(parts, zone);
  if (at.kind !== "single") return { field, message: `The clocks ${at.kind === "skipped" ? "skip" : "repeat"} that time in ${city} that night: choose another time.` };
  return null;
}

function checkDates(form: MigrationForm, facts: MarketFacts, now: Date): Problem[] {
  const problems: Problem[] = [];
  const zone = facts[form.market]?.timeZone ?? "UTC";
  const city = zoneCity(zone);
  const notices = checkTime("noticesLocal", form.noticesLocal, zone, "when the existing subscribers are asked or told");
  if (notices) problems.push(notices);
  else {
    const at = localToInstant(parseLocal(form.noticesLocal) as NonNullable<ReturnType<typeof parseLocal>>, zone);
    if (at.kind === "single" && at.instant.getTime() <= now.getTime()) {
      problems.push({ field: "noticesLocal", message: `That time has passed in ${city}: the existing subscribers are asked or told in the future.` });
    }
  }
  const starts = checkTime("startsLocal", form.startsLocal, zone, "from when new subscribers pay the new price");
  if (starts) problems.push(starts);
  else if (notices === null && contractLocal(form.startsLocal) < contractLocal(form.noticesLocal)) {
    problems.push({ field: "startsLocal", message: "New subscribers pay it from when the existing ones are asked or told, or later." });
  }
  return problems;
}

/** The problems that stop a step's Continue; the last step gathers them all. */
export function checkMigrationStep(form: MigrationForm, step: MigrationStep, facts: MarketFacts, now: Date): Problem[] {
  switch (step) {
    case 0:
      return checkPrice(form, facts);
    case 1:
      return form.market === "" ? [] : checkDates(form, facts, now);
    case 2:
      return [...checkPrice(form, facts), ...(form.market === "" ? [] : checkDates(form, facts, now))];
  }
}

/**
 * The form as the gateway's PriceMigrationInput, for saving a draft. Every
 * field of the input is required, so a draft is saved once each one holds
 * something that can be sent; whether it is in the future is the engine's
 * to say, in its validation.
 */
export function toMigrationInput(form: MigrationForm, facts: MarketFacts): { input: MigrationInput } | { problems: Problem[] } {
  const problems = checkPrice(form, facts);
  const zone = facts[form.market]?.timeZone ?? "UTC";
  for (const [field, value, what] of [
    ["noticesLocal", form.noticesLocal, "when the existing subscribers are asked or told"],
    ["startsLocal", form.startsLocal, "from when new subscribers pay the new price"],
  ] as const) {
    const problem = form.market === "" ? null : checkTime(field, value, zone, what);
    if (problem) problems.push(problem);
  }
  if (problems.length) return { problems };
  const currency = facts[form.market]?.currency ?? "EUR";
  return {
    input: {
      title: form.title.trim(),
      plan: form.plan,
      market: form.market,
      amount: { amountMinor: (parseAmount(form.amount.trim(), currency) ?? 0n).toString(), currency },
      noticesLocal: contractLocal(form.noticesLocal),
      startsLocal: contractLocal(form.startsLocal),
    },
  };
}

/** Whether the form says something the saved version does not: then saving makes a new version. */
export function migrationDiffers(form: MigrationForm, content: MigrationContent | null, facts: MarketFacts): boolean {
  if (content === null) return true;
  const typed = toMigrationInput(form, facts);
  if ("problems" in typed) return true;
  // Only the fields of the input: the gateway's content also carries its __typename.
  const same = (input: MigrationInput) => JSON.stringify({
    title: input.title,
    plan: input.plan,
    market: input.market,
    amount: { amountMinor: String(minorUnits(input.amount.amountMinor)), currency: input.amount.currency },
    noticesLocal: contractLocal(input.noticesLocal),
    startsLocal: contractLocal(input.startsLocal),
  });
  return same(typed.input) !== same(content);
}

/** "+€2.00 a month (+10.5%)": how much the new price adds to the one in force; null when either is missing. */
export function increaseWords(current: Money | null, typed: string): { readonly amountMinor: bigint; readonly basisPoints: number } | null {
  if (current === null) return null;
  const amount = parseAmount(typed.trim(), current.currency);
  if (amount === null || amount <= 0n) return null;
  const before = minorUnits(current.amountMinor);
  if (before <= 0n) return null;
  const difference = amount - before;
  return { amountMinor: difference, basisPoints: Number((difference * 10_000n * 10n / before + 5n) / 10n) };
}
