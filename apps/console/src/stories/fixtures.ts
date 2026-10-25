// Fixtures for the stories: the Student Autumn Pass of the business book
// (§6.7, §14.1) as the gateway would send it. The simulation's numbers are
// the book's worked example (E = 10,000, u = 12%, i = 60%, r = 55%), and the
// same campaign at r = 70% worked with the same formulas (§6.6).
import type { ChangeQuery, HomeQuery, MarketsQuery, PlansQuery, SimulateOfferQuery, WeekQuery } from "../graphql/generated.ts";

const eur = (amountMinor: string) => ({ amountMinor, currency: "EUR" });
const gbp = (amountMinor: string) => ({ amountMinor, currency: "GBP" });

export const MARKETS: MarketsQuery["markets"] = [
  { code: "IT", name: "Italy", currency: "EUR", minorUnits: 2, timeZone: "Europe/Rome", vatBasisPoints: 2200, artistsMinimum: eur("300"), floor: eur("610") },
  { code: "FR", name: "France", currency: "EUR", minorUnits: 2, timeZone: "Europe/Paris", vatBasisPoints: 2000, artistsMinimum: eur("300"), floor: eur("600") },
  { code: "DE", name: "Germany", currency: "EUR", minorUnits: 2, timeZone: "Europe/Berlin", vatBasisPoints: 1900, artistsMinimum: eur("300"), floor: eur("595") },
  { code: "GB", name: "United Kingdom", currency: "GBP", minorUnits: 2, timeZone: "Europe/London", vatBasisPoints: 2000, artistsMinimum: gbp("260"), floor: gbp("519") },
];

const lossless = { skipsPerHour: null, audio: "LOSSLESS" as const, offline: true, seats: 1, needsStudentCheck: false };
export const PLANS_IT: PlansQuery["plans"] = [
  { code: "free", name: "Free", paid: false, listPrice: null, breakdown: null, entitlements: { skipsPerHour: 6, audio: "STANDARD", offline: false, seats: 1, needsStudentCheck: false } },
  { code: "individual", name: "Individual", paid: true, listPrice: eur("1049"), breakdown: null, entitlements: lossless },
  { code: "duo", name: "Duo", paid: true, listPrice: eur("1449"), breakdown: null, entitlements: { ...lossless, seats: 2 } },
  { code: "family", name: "Family", paid: true, listPrice: eur("1799"), breakdown: null, entitlements: { ...lossless, seats: 5 } },
  { code: "student", name: "Student", paid: true, listPrice: eur("579"), breakdown: null, entitlements: { ...lossless, needsStudentCheck: true } },
];

const MARKETING = { id: "marketing-1", label: "Marketing" };
const FINANCE = { id: "finance-1", label: "Finance" };

const offer = (price: string, audienceNote: "never-paid" | "lapsed") => ({
  __typename: "OfferContent" as const,
  title: "Student Autumn Pass",
  plan: "student",
  audience: { segment: "NEVER_PAID" as const, currentPlan: null, needsStudentCheck: true, listening: null },
  prices: [{ market: "IT", fixed: eur(price), percentOffBasisPoints: null }],
  monthsAtOfferPrice: 3,
  periods: [{ market: "IT", startsLocal: "2026-10-26T09:00", endsLocal: "2026-11-30T00:00" }],
  nonCombinabilityGroup: "student-offers",
  redemptionCap: null,
  pages: [{
    market: "IT",
    title: "Student Autumn Pass",
    text: `Three months of Student for ${price === "299" ? "2,99" : "2,49"} € a month. Then 5,79 €, the usual Student price.`,
    terms: audienceNote === "never-paid" ? "For verified students in Italy who have never paid for a plan." : "For verified students in Italy.",
    treatment: "standard",
  }],
});

export const FINGERPRINT_V3 = "ff9a6c0c88e1b62334bb3c27f13f4dd89ac375a2c2c19a23b5c725200d7368c0";

export type Change = NonNullable<ChangeQuery["change"]>;

/** The pass in approval as v3, written by Marketing, Finance to sign for conditions 2 and 4. */
export function studentPass(state: Change["state"] = "IN_APPROVAL", signed = false): Change {
  return {
    id: "7",
    kind: "OFFER",
    title: "Student Autumn Pass",
    state,
    stateReason: null,
    currentVersion: 3,
    createdBy: MARKETING,
    createdAt: "2026-10-21T09:14:00Z",
    versions: [
      { version: 1, author: MARKETING, createdAt: "2026-10-21T09:14:00Z", fingerprint: "1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff0011", content: offer("249", "lapsed") },
      { version: 2, author: MARKETING, createdAt: "2026-10-22T11:03:00Z", fingerprint: "720e5be3e4f81d1a3d99c1f0f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d4a48", content: offer("299", "lapsed") },
      { version: 3, author: MARKETING, createdAt: "2026-10-23T15:20:00Z", fingerprint: FINGERPRINT_V3, content: offer("299", "never-paid") },
    ],
    current: { version: 3, author: MARKETING, createdAt: "2026-10-23T15:20:00Z", fingerprint: FINGERPRINT_V3, content: offer("299", "never-paid") },
    approvals: signed ? [{ version: 3, approver: FINANCE, role: "FINANCE", decidedAt: "2026-10-24T08:42:00Z", fingerprint: FINGERPRINT_V3 }] : [],
    validation: {
      version: 3,
      valid: true,
      eligible: 10_000,
      findings: [
        { check: "floor", severity: "NEEDS_SIGNATURE", market: "IT", message: "Italy: €2.99 is below the floor of €6.10; the artists' minimum costs €1.53 a month per subscription.", facts: [] },
        { check: "signatures", severity: "NEEDS_SIGNATURE", market: null, message: "Finance must sign: conditions 2 and 4 of §7.3.", facts: [] },
      ],
    },
    requiredSignatures: [{ role: "FINANCE", conditions: [2, 4], why: "Finance must sign: conditions 2 and 4 of §7.3.", signed }],
    sentence: "Italy, Student: from €5.79 to €2.99 for 3 months, new subscribers only; 10,000 eligible; conflicts: none.",
    authorReason: "We are buying students now. At 55% retention after month 3 the pass pays for itself in the second year.",
    migration: null,
  };
}

const totals = (revenue: string, artists: string, paymentCosts: string, contribution: string) => ({ revenue: eur(revenue), artists: eur(artists), paymentCosts: eur(paymentCosts), contribution: eur(contribution) });

const CONDITIONS = (negative: boolean) => [
  { number: 1, rule: "A list price is created or changed", met: false, detail: "No list price is created or changed." },
  { number: 2, rule: "An offer price is below the floor of its market", met: true, detail: "Italy: €2.99 against a floor of €6.10" },
  { number: 3, rule: "The simulated discount cost plus top-up cost over the horizon is above €20,000.00", met: false, detail: "€8,820.00 over 12 months, against €20,000.00." },
  { number: 4, rule: "The simulated contribution over the horizon is negative", met: negative, detail: negative ? "−€1,877.51 over 12 months." : "€788.65 over 12 months." },
  { number: 5, rule: "A price migration asks existing subscribers to accept a higher price", met: false, detail: "No price migration." },
];

type Simulation = Extract<SimulateOfferQuery["simulateOffer"], { readonly __typename: "Simulation" }>;

/** §6.7: retention 55%, the default; or 70%, typed by Marketing. */
export function simulation(retentionBp: 5500 | 7000): Simulation {
  const typed = retentionBp !== 5500;
  const assumption = (name: "ELIGIBLE" | "TAKE_UP" | "INCREMENTAL" | "RETENTION" | "HORIZON_MONTHS", value: number, source: string) => ({ name, value, source });
  return {
    __typename: "Simulation",
    eligible: 10_000,
    takers: 1_200,
    stayers: typed ? 840 : 660,
    cannibalized: 480,
    withOffer: typed ? totals("4473000", "3348000", "98166", "1026834") : totals("3703500", "2862000", "81282", "760218"),
    withoutOffer: totals("2736000", "1728000", "60031", "947969"),
    difference: typed ? totals("1737000", "1620000", "38135", "78865") : totals("967500", "1134000", "21251", "-187751"),
    discountCost: eur("331200"),
    topUpCost: eur("550800"),
    financeConditions: CONDITIONS(!typed),
    breakEvenRetentionBasisPoints: 6555,
    assumptions: [
      assumption("ELIGIBLE", 10_000, "counted in the data at 2026-10-24T08:42:00Z"),
      assumption("TAKE_UP", 1200, "default: business book §6.7 (illustrative)"),
      assumption("INCREMENTAL", 6000, "default: business book §6.7 (illustrative)"),
      assumption("RETENTION", retentionBp, typed ? "typed by marketing at 2026-10-24T08:42:00Z" : "default: business book §6.7 (illustrative)"),
      assumption("HORIZON_MONTHS", 12, "default: business book §6.6"),
    ],
    horizonMonths: 12,
  };
}

/** The home's overview: the pass waiting for Finance and launching Monday, counts of the small generated data. */
export function overview(readsRevenue: boolean): HomeQuery["overview"] {
  const pass = studentPass();
  const counts = { IT: [208, 43, 52, 60], FR: [225, 53, 54, 67], DE: [275, 53, 66, 92], GB: [302, 71, 87, 94] } as const;
  const plans = ["individual", "duo", "family", "student"] as const;
  return {
    waitingForApproval: [{
      id: pass.id, kind: pass.kind, title: pass.title, state: pass.state, currentVersion: pass.currentVersion, createdBy: pass.createdBy,
      markets: ["IT"], requiredSignatures: pass.requiredSignatures, updatedAt: "2026-10-23T15:20:05Z",
      details: {
        id: pass.id,
        sentence: pass.sentence,
        versions: pass.versions.map((version) => ({ version: version.version, author: { id: version.author.id } })),
        current: { version: 3, author: { id: "marketing-1" }, content: { __typename: "OfferContent", plan: "student" } },
        approvals: [],
      },
    }],
    launchesNext7Days: [{
      title: "Student Autumn Pass", state: "IN_APPROVAL", atRisk: true, risk: "Not approved yet: it will not start until the missing signatures arrive.",
      starts: { market: "IT", local: "2026-10-26T09:00", utc: "2026-10-26T08:00:00Z" }, change: { id: "7", kind: "OFFER", currentVersion: 3 },
    }],
    incidentsToday: [],
    payingSubscribers: Object.entries(counts).flatMap(([market, values]) => values.map((count, index) => ({ market, plan: plans[index] ?? "individual", count }))),
    freeListeners: [{ market: "IT", plan: "free", count: 633 }, { market: "FR", plan: "free", count: 694 }, { market: "DE", plan: "free", count: 881 }, { market: "GB", plan: "free", count: 994 }],
    ...(readsRevenue ? {
      monthlyRevenue: [
        { market: "IT", revenue: eur("372823"), revenueEur: eur("372823") },
        { market: "FR", revenue: eur("440428"), revenueEur: eur("440428") },
        { market: "DE", revenue: eur("549597"), revenueEur: eur("549597") },
        { market: "GB", revenue: gbp("541608"), revenueEur: eur("646866") },
      ],
      monthlyRevenueEur: eur("2009714"),
      monthlyTopUps: eur("1479"),
    } : {}),
    exchangeRateNote: "1 EUR = 0.83728 GBP (ECB reference rate, 23 October 2026).",
  };
}

export const WEEK: WeekQuery = {
  priceList: MARKETS.flatMap((market) => (["individual", "duo", "family", "student"] as const).map((plan, index) => ({
    id: `${market.code}-${plan}`, plan, market: market.code,
    amount: market.code === "GB" ? gbp(["949", "1299", "1649", "529"][index] ?? "949") : eur(["1049", "1449", "1799", "579"][index] ?? "1049"),
    validFrom: "2026-01-01T00:00", validUntil: null,
  }))),
  changes: {
    nodes: [{
      id: "7", title: "Student Autumn Pass", state: "IN_APPROVAL", currentVersion: 3,
      details: { id: "7", current: { version: 3, content: { __typename: "OfferContent", plan: "student", periods: [{ market: "IT", startsLocal: "2026-10-26T09:00", endsLocal: "2026-11-30T00:00" }] } } },
    }],
  },
};
