// Fixtures for the stories of the prices the commercial lead writes: the
// German Family rise of the business book (§8.7, §14.3) and the three-month
// gift pass (§9, §14.4), as the gateway would send them. The markets' rules
// are the engine's own words (db/migrations/V13__price_migrations.sql). The
// simulation's numbers follow the book's formulas for 8,412 existing
// subscribers, the count of the maquette (maquette/contenuti/content.json):
// €18.99 to €20.99 is €15.96 to €17.64 net and €9.58 to €10.58 for the
// artists per month; at the book's 90% acceptance revenue falls by €703.08
// a month, at 93% it rises by €3,742.20 (both break-evens: 90.48% and
// 90.42%).
import type { ChangeQuery, HomeQuery, PlansQuery, PriceChangePoliciesQuery, SimulateMigrationQuery } from "../graphql/generated.ts";

const eur = (amountMinor: string) => ({ amountMinor, currency: "EUR" });

export type Change = NonNullable<ChangeQuery["change"]>;
type Simulation = Extract<SimulateMigrationQuery["simulateMigration"], { readonly __typename: "MigrationSimulation" }>;

const LEAD = { id: "commercial-lead-1", label: "Commercial lead" };
const FINANCE = { id: "finance-1", label: "Finance" };

export const POLICIES: PriceChangePoliciesQuery = {
  markets: [
    {
      code: "IT", name: "Italy",
      priceChangePolicy: {
        law: {
          requirement: "NOTICE",
          basis: "A term letting the trader change the contract without a justified reason stated in it, or raise the price without the consumer being able to withdraw, is presumed unfair unless the trader proves otherwise. Sonequo states the reasons in its terms, gives advance notice, and lets the customer withdraw before the new price applies.",
          sources: ["Consumer Code (Legislative Decree 206/2005), art. 33(2)(m) and (o)"],
        },
        choice: { windowDays: 30, afterWindow: "NEW_PRICE", words: "Thirty days of notice, with the reason for the change; the subscriber may leave before the new price applies, with no exit fee.", alternatives: [], label: "The music service's choice, configurable per market; not a legal requirement." },
      },
    },
    {
      code: "FR", name: "France",
      priceChangePolicy: {
        law: {
          requirement: "NOTICE",
          basis: "A term reserving to the trader the right to change the price unilaterally is prohibited; in a contract of indefinite duration the price may change if the consumer is told within a reasonable time, so as to be able to terminate. Sonequo applies increases after advance notice, with the option to terminate before the new price applies.",
          sources: ["Consumer Code, art. R. 212-1, 3°", "Consumer Code, art. R. 212-4"],
        },
        choice: { windowDays: 30, afterWindow: "NEW_PRICE", words: "Thirty days of notice; the subscriber may terminate before the new price applies.", alternatives: [], label: "The music service's choice, configurable per market; not a legal requirement." },
      },
    },
    {
      code: "DE", name: "Germany",
      priceChangePolicy: {
        law: {
          requirement: "CONSENT",
          basis: "Terms letting a streaming service raise the price of a running subscription at its own discretion unreasonably disadvantage consumers (German Civil Code, § 307(1), first sentence): the service can ask for consent instead. Sonequo asks existing subscribers for their active consent before an increase applies, and silence is not consent.",
          sources: [
            "Kammergericht (Berlin), two judgments of 15 November 2023, press release 27/2023",
            "Bundesgerichtshof, decisions of 30 January 2025 and 27 February 2025: the judgments are final",
            "Bundesgerichtshof, 1 October 2026, press release 184/2026",
            "German Civil Code (BGB), § 307(1)",
          ],
        },
        choice: {
          windowDays: 45, afterWindow: "MOVE_TO_FREE",
          words: "When the period already paid at the consent deadline runs out, the account moves to the free plan, and keeps its playlists and library.",
          alternatives: ["End the paid subscription at the end of the billing period", "Keep the old price until a stated date"],
          label: "The music service's choice, configurable per market; not a legal requirement.",
        },
      },
    },
    {
      code: "GB", name: "United Kingdom",
      priceChangePolicy: {
        law: {
          requirement: "NOTICE",
          basis: "Terms letting the trader alter the contract without a valid reason, or raise the price without a right to cancel, may be regarded as unfair; advance notice and a genuine freedom to exit make a price-variation term more likely to be fair. This is not a legal safe harbour. Sonequo applies increases after advance notice, with the option to cancel before the new price applies.",
          sources: ["Consumer Rights Act 2015, Schedule 2, paras 11 and 15, and section 63", "CMA37, unfair contract terms guidance, 22 July 2026"],
        },
        choice: { windowDays: 30, afterWindow: "NEW_PRICE", words: "Thirty days of notice; the subscriber may cancel before the new price applies.", alternatives: [], label: "The music service's choice, configurable per market; not a legal requirement." },
      },
    },
  ],
};

const lossless = { skipsPerHour: null, audio: "LOSSLESS" as const, offline: true, seats: 1, needsStudentCheck: false };
export const PLANS_DE: PlansQuery["plans"] = [
  { code: "free", name: "Free", paid: false, listPrice: null, breakdown: null, entitlements: { skipsPerHour: 6, audio: "STANDARD", offline: false, seats: 1, needsStudentCheck: false } },
  { code: "individual", name: "Individual", paid: true, listPrice: eur("1099"), breakdown: null, entitlements: lossless },
  { code: "duo", name: "Duo", paid: true, listPrice: eur("1499"), breakdown: null, entitlements: { ...lossless, seats: 2 } },
  { code: "family", name: "Family", paid: true, listPrice: eur("1899"), breakdown: null, entitlements: { ...lossless, seats: 5 } },
  { code: "student", name: "Student", paid: true, listPrice: eur("599"), breakdown: null, entitlements: { ...lossless, needsStudentCheck: true } },
];

const FAMILY_CONTENT = {
  __typename: "PriceMigrationContent" as const,
  title: "Family price rise, Germany",
  plan: "family",
  market: "DE",
  amount: eur("2099"),
  noticesLocal: "2026-11-02T09:00",
  startsLocal: "2026-12-01T00:00",
};

export const FAMILY_SENTENCE = "Germany, Family: from €18.99 to €20.99 for new subscribers from 1 December 2026, 00:00 (Europe/Berlin); 8,412 current subscribers asked for their consent from 2 November 2026, 09:00 (Europe/Berlin), within 45 days; without it: when the period already paid at the consent deadline runs out, the account moves to the free plan, and keeps its playlists and library (the music service's choice); overlaps: none.";
const FAMILY_FINGERPRINT = "5c3a0f17b8e2d4c6a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8";
const FINANCE_SIGNS = "Finance must sign: conditions 1 and 5 of §7.3.";

/** Where the existing subscribers stand: asked on 2 November, in the middle of the window. */
export const MID_WINDOW = {
  requirement: "CONSENT" as const,
  windowEnds: { market: "DE", local: "2026-12-17T23:59", utc: "2026-12-17T22:59:00Z" },
  asked: 8412, waiting: 3120, accepted: 4987, declined: 305, lapsed: 0, newPrice: 0, left: 0,
};

/** Blocking findings the engine writes for a migration that cannot go: price, dates, overlap. */
export const BLOCKING_FINDINGS = [
  { check: "price", severity: "BLOCKING", market: "DE", message: "Germany: a price migration raises the price, and €18.99 is not above the price in force, €18.99; a lower price is a new list price.", facts: [] },
  { check: "dates", severity: "BLOCKING", market: "DE", message: "Germany: new subscribers pay the new price from 1 November 2026, 00:00 (Europe/Berlin), before the existing ones are asked or told, 2 November 2026, 09:00 (Europe/Berlin).", facts: [] },
  { check: "overlap", severity: "BLOCKING", market: "DE", message: "Germany: Family list price 2027 (#31, scheduled) already changes this price.", facts: [] },
  { check: "signatures", severity: "NEEDS_SIGNATURE", market: null, message: FINANCE_SIGNS, facts: [] },
] as const;

/** The German Family rise, written by the commercial lead, in a given state. */
export function germanFamily(state: Change["state"] = "IN_APPROVAL", options: { readonly signed?: boolean; readonly blocked?: boolean; readonly progress?: typeof MID_WINDOW | null; readonly checked?: boolean } = {}): Change {
  const version = { version: 1, author: LEAD, createdAt: "2026-10-23T16:05:00Z", fingerprint: FAMILY_FINGERPRINT, content: FAMILY_CONTENT };
  const checked = options.checked ?? true;
  return {
    id: "21",
    kind: "PRICE_MIGRATION",
    title: "Family price rise, Germany",
    state,
    stateReason: null,
    currentVersion: 1,
    createdBy: LEAD,
    createdAt: "2026-10-23T16:05:00Z",
    versions: [version],
    current: version,
    approvals: options.signed ? [{ version: 1, approver: FINANCE, role: "FINANCE", decidedAt: "2026-10-24T08:40:00Z", fingerprint: FAMILY_FINGERPRINT }] : [],
    validation: checked ? {
      version: 1,
      valid: !options.blocked,
      eligible: 8412,
      findings: options.blocked ? [...BLOCKING_FINDINGS] : [{ check: "signatures", severity: "NEEDS_SIGNATURE", market: null, message: FINANCE_SIGNS, facts: [] }],
    } : null,
    requiredSignatures: checked ? [{ role: "FINANCE", conditions: [1, 5], why: FINANCE_SIGNS, signed: options.signed ?? false }] : [],
    sentence: checked ? FAMILY_SENTENCE : null,
    // The reason comes with the submission: a draft or a checked version has none yet.
    authorReason: state === "DRAFT" || state === "VALIDATED" ? null : "Family costs us more per seat since the last catalogue deal; the new price keeps the artists' share above the minimum with room to spare.",
    migration: options.progress ?? null,
  };
}

const step = (price: string, net: string, artists: string, paymentCosts: string, contribution: string) => ({ price: eur(price), net: eur(net), artists: eur(artists), paymentCosts: eur(paymentCosts), contribution: eur(contribution) });

const CONDITIONS = [
  { number: 1, rule: "A list price is created or changed", met: true, detail: "This change sets a list price." },
  { number: 2, rule: "An offer price is below the floor of its market", met: false, detail: "Every offer price is at or above its market's floor." },
  { number: 3, rule: "The simulated discount cost plus top-up cost over the horizon is above €20,000.00", met: false, detail: "Nothing to simulate." },
  { number: 4, rule: "The simulated contribution over the horizon is negative", met: false, detail: "Nothing to simulate." },
  { number: 5, rule: "A price migration asks existing subscribers to accept a higher price", met: true, detail: "Existing subscribers are asked to accept a higher price." },
];

/** §8.7 for 8,412 existing subscribers: at the book's 90%, or at 93% typed by the commercial lead. */
export function familySimulation(acceptanceBp: 9000 | 9300): Simulation {
  const typed = acceptanceBp === 9300;
  return {
    __typename: "MigrationSimulation",
    before: step("1899", "1596", "958", "34", "604"),
    after: step("2099", "1764", "1058", "38", "668"),
    newSubscribersFrom: { market: "DE", local: "2026-12-01T00:00", utc: "2026-11-30T23:00:00Z" },
    noticesFrom: { market: "DE", local: "2026-11-02T09:00", utc: "2026-11-02T08:00:00Z" },
    windowEnds: { market: "DE", local: "2026-12-17T23:59", utc: "2026-12-17T22:59:00Z" },
    existingFrom: "from their first charge after they consent, and not before new subscribers pay it; they answer by 17 December 2026, 23:59 (Europe/Berlin)",
    existing: 8412,
    accepting: typed ? 7823 : 7571,
    notAccepting: typed ? 589 : 841,
    movingToFree: typed ? 589 : 841,
    monthlyRevenueChange: eur(typed ? "374220" : "-70308"),
    monthlyContributionChange: eur(typed ? "144916" : "-23420"),
    revenueAtRiskMonthly: eur(typed ? "940044" : "1342236"),
    breakEvenAcceptanceRevenueBasisPoints: 9048,
    breakEvenAcceptanceContributionBasisPoints: 9042,
    prepaidPassesUntouched: 0,
    assumptions: [
      { name: "EXISTING", value: 8412, source: "counted in the data at 2026-10-24T08:42:00Z" },
      { name: "ACCEPTANCE", value: acceptanceBp, source: typed ? "typed by the commercial lead at 2026-10-24T08:42:00Z" : "default: business book §16 (illustrative)" },
    ],
    financeConditions: CONDITIONS,
  };
}

const GIFT_CONTENT = {
  __typename: "PrepaidPassContent" as const,
  title: "Three-month gift pass",
  plan: "individual",
  months: 3,
  prices: [{ market: "IT", amount: eur("2999") }],
  periods: [{ market: "IT", startsLocal: "2026-10-26T09:00", endsLocal: null }],
  codeValidMonths: 12,
  pages: [{
    market: "IT",
    title: "Three months of Individual, as a gift",
    text: "Three months of Individual, paid once: 29,99 €. A code to keep or to give.",
    terms: "A single-use code for Italy, to activate within 12 months of the purchase. It never renews, and price changes made after the purchase do not touch it.",
    treatment: "standard",
  }],
};

export const GIFT_SENTENCE = "Three-month gift pass: Individual for 3 months, paid in advance and never renewed; Italy: €29.99 (€10.49 a month at the list price), on sale from 26 October 2026, 09:00 (Europe/Rome); a code waits up to 12 months to be activated.";
const GIFT_FINGERPRINT = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d";
const FINANCE_SIGNS_PRICE = "Finance must sign: condition 1 of §7.3.";

/** The three-month gift pass, written by the commercial lead, in a given state. */
export function giftPass(state: Change["state"] = "IN_APPROVAL", options: { readonly signed?: boolean; readonly checked?: boolean } = {}): Change {
  const version = { version: 1, author: LEAD, createdAt: "2026-10-23T17:20:00Z", fingerprint: GIFT_FINGERPRINT, content: GIFT_CONTENT };
  const checked = options.checked ?? true;
  return {
    id: "24",
    kind: "PREPAID",
    title: "Three-month gift pass",
    state,
    stateReason: null,
    currentVersion: 1,
    createdBy: LEAD,
    createdAt: "2026-10-23T17:20:00Z",
    versions: [version],
    current: version,
    approvals: options.signed ? [{ version: 1, approver: FINANCE, role: "FINANCE", decidedAt: "2026-10-24T08:40:00Z", fingerprint: GIFT_FINGERPRINT }] : [],
    validation: checked ? { version: 1, valid: true, eligible: 0, findings: [{ check: "signatures", severity: "NEEDS_SIGNATURE", market: null, message: FINANCE_SIGNS_PRICE, facts: [] }] } : null,
    requiredSignatures: checked ? [{ role: "FINANCE", conditions: [1], why: FINANCE_SIGNS_PRICE, signed: options.signed ?? false }] : [],
    sentence: checked ? GIFT_SENTENCE : null,
    authorReason: null,
    migration: null,
  };
}

/**
 * The value of prepaid passes not yet earned, as the home gives it to
 * Finance: Italy's 1,240 codes of the maquette, 860 activated, €23,435.80
 * not yet earned; and a few in the United Kingdom, converted at the
 * declared rate.
 */
export const PREPAID_VALUE: Pick<HomeQuery["overview"], "prepaid" | "prepaidUnearnedEur"> = {
  prepaid: [
    { market: "IT", sold: 1240, activated: 860, expired: 0, unearned: eur("2343580"), unearnedEur: eur("2343580") },
    { market: "GB", sold: 12, activated: 5, expired: 1, unearned: { amountMinor: "17040", currency: "GBP" }, unearnedEur: eur("20352") },
  ],
  prepaidUnearnedEur: eur("2363932"),
};
