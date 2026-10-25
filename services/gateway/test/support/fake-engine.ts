// A fake commerce engine for the gateway's tests: every service of the gRPC
// contract, in memory, served over real gRPC (HTTP/2) on 127.0.0.1:4613
// (CHECK_FAKE_ENGINE_PORT moves it).
//
// It mirrors the engine's behaviours as the coordinator fixed them on 24
// October (BRIEF-TAPPE-2-3.md, §4): the gRPC codes, the metadata rules, the
// idempotency store, the refusals, the role matrix. That matrix is written
// here again from the brief's table, not imported from the gateway's
// roles.ts: a test that checked the gateway against its own copy would agree
// with itself whatever it said. Its business rules are a small subset, enough
// to drive the gateway; the real engine replaces it when the branches merge.
import { createHash } from "node:crypto";
import { createServer, type Http2Server, type ServerHttp2Session } from "node:http2";
import { setTimeout as sleep } from "node:timers/promises";
import { create, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext, type Interceptor, type UnaryResponse } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { AuditEventSchema, AuditService, ChainHeadSchema, type AuditEvent } from "contracts/commerce/v1/audit";
import {
  CatalogService, MarketSchema, PlanSchema, PriceBreakdownSchema, PriceListEntrySchema, PublishedOfferSchema, type Market, type Plan,
  type PriceListEntry, type PublishedOffer,
} from "contracts/commerce/v1/catalog";
import {
  type Approval, ApprovalSchema, type Change, ChangeKind, ChangeSchema, ChangeService, ChangeState, ChangeSummarySchema, ChangeVersionSchema,
  type ListPriceContent, ListPriceContentSchema, MigrationProgressSchema, type OfferContent, OfferContentSchema, type PrepaidPassContent,
  PrepaidPassContentSchema, type PriceMigrationContent, PriceMigrationContentSchema, type CreateChangeRequest, type RequiredSignature,
  RequiredSignatureSchema, type SaveVersionRequest, Severity, ValidationReportSchema, type ValidationReport,
} from "contracts/commerce/v1/changes";
import { type Money, MoneySchema, type Refusal, RefusalCode, RefusalSchema, Role } from "contracts/commerce/v1/common";
import { LaunchService, LaunchState, LaunchStepState, type LaunchRun, LaunchRunSchema } from "contracts/commerce/v1/launches";
import { IncidentSchema, OverviewService, PeopleService, PersonSchema, type Person } from "contracts/commerce/v1/overview";
import { QuoteSchema, QuoteService } from "contracts/commerce/v1/quotes";
import { SimulationService } from "contracts/commerce/v1/simulation";
import {
  AccountSchema, DemoListenerSchema, type Payment, PaymentSchema, PaymentState, type PrepaidCode, PrepaidCodeSchema, type PriceChange,
  PriceChangeSchema, ReceiptSchema, StudentVerificationSchema,
  SubscriberService,
  type Subscription, SubscriptionSchema,
} from "contracts/commerce/v1/subscriptions";
import { Health, HealthCheckResponse_ServingStatus } from "contracts/grpc/health/v1/health";
import { PORTS as REPO_PORTS } from "../../../../tools/lib/paths.ts";

/** 4613 unless CHECK_FAKE_ENGINE_PORT says otherwise (tools/lib/paths.ts). */
export const FAKE_ENGINE_PORT = REPO_PORTS.fakeEngineCheck;
export const FAKE_TOKEN = "fake-engine-token-for-the-gateway-tests";

const SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;
/** Served without a person of the team: the site's catalog, quotes and subscriber calls, and the list of people. */
const PUBLIC = new Set([
  "ListPeople", "ListMarkets", "ListPlans", "GetPriceList", "ListOffers", "GetQuote",
  "ListDemoListeners", "VerifyStudent", "ConfirmQuote", "GetAccount", "AnswerPriceChange", "ListPrepaidPasses", "BuyPrepaidPass",
  "ActivatePrepaidPass",
]);
const IDEMPOTENT = new Set([
  "CreateChange", "SaveVersion", "ValidateChange", "SubmitChange", "ApproveChange", "RejectChange", "ScheduleChange",
  "CancelChange", "SuspendChange", "GetQuote", "ExportHead", "VerifyStudent", "ConfirmQuote", "RetryLaunch", "CancelLaunch", "AnswerPriceChange",
  "BuyPrepaidPass", "ActivatePrepaidPass",
]);
/** Reads without an outcome: a role that may not call them gets PERMISSION_DENIED instead of a refusal. */
const READS = new Set(["GetChange", "BatchGetChanges", "ListChanges", "GetOverview", "ListEvents", "VerifyChain", "ListLaunches", "GetLaunch"]);

type Kind = "offer" | "listPrice" | "priceMigration" | "prepaid";

/** The contract's number of each kind of change the fake engine keeps. */
const KIND_NUMBER: Record<Kind, ChangeKind> = {
  offer: ChangeKind.OFFER, listPrice: ChangeKind.LIST_PRICE, priceMigration: ChangeKind.PRICE_MIGRATION, prepaid: ChangeKind.PREPAID,
};

/** What a version of a change holds. */
type Content = OfferContent | ListPriceContent | PriceMigrationContent | PrepaidPassContent;
/** The coordinator's table (§4 of the brief), transcribed here on its own. */
const MAY: Record<string, (role: string, kind: Kind | null) => boolean> = {
  // An offer is marketing's; a list price, a price migration and a prepaid pass are the commercial lead's (§12, §14.3, §14.4).
  CreateChange: (role, kind) => (kind === "offer" ? role === "marketing" : role === "commercial_lead"),
  SaveVersion: (role, kind) => (kind === "offer" ? role === "marketing" : role === "commercial_lead"),
  ValidateChange: (role, kind) => (kind === "offer" ? role === "marketing" : role === "commercial_lead"),
  SubmitChange: (role, kind) => (kind === "offer" ? role === "marketing" : role === "commercial_lead"),
  SimulateOffer: (role) => ["marketing", "commercial_lead", "finance"].includes(role),
  SimulateMigration: (role) => ["marketing", "commercial_lead", "finance"].includes(role),
  ApproveChange: (role) => ["commercial_lead", "finance"].includes(role),
  RejectChange: (role) => ["commercial_lead", "finance"].includes(role),
  ScheduleChange: (role, kind) => role === "commercial_lead" || (kind === "offer" && role === "marketing"),
  CancelChange: (role, kind) => role === "commercial_lead" || role === "on_call" || (kind === "offer" && role === "marketing"),
  SuspendChange: (role) => role === "on_call",
  GetChange: () => true,
  BatchGetChanges: () => true,
  ListChanges: () => true,
  GetOverview: () => true,
  ListEvents: () => true,
  VerifyChain: (role) => ["auditor", "on_call"].includes(role),
  ExportHead: (role) => role === "auditor",
  // Stage 6 (launches.proto): every role reads the launches; only on_call retries or cancels one.
  ListLaunches: () => true,
  GetLaunch: () => true,
  RetryLaunch: (role) => role === "on_call",
  CancelLaunch: (role) => role === "on_call",
};

const ROLE_NUMBER: Record<string, Role> = {
  marketing: Role.MARKETING, commercial_lead: Role.COMMERCIAL_LEAD, finance: Role.FINANCE,
  catalog_manager: Role.CATALOG_MANAGER, on_call: Role.ON_CALL, auditor: Role.AUDITOR,
};

export const DEMO_PEOPLE: Record<string, { label: string; roles: string[] }> = {
  "marketing-1": { label: "Marketing", roles: ["marketing"] },
  "marketing-2": { label: "Marketing, second", roles: ["marketing"] },
  "commercial-lead-1": { label: "Commercial lead", roles: ["commercial_lead"] },
  "finance-1": { label: "Finance", roles: ["finance"] },
  "catalog-manager-1": { label: "Catalog manager", roles: ["catalog_manager"] },
  "on-call-1": { label: "On-call engineer", roles: ["on_call"] },
  "auditor-1": { label: "Auditor", roles: ["auditor"] },
};

/** Values planted in fields the public schema must never show; their digits are looked for in every public answer. */
export const SENTINEL = { amount: 987_654_321n, text: "SENTINEL-INTERNAL", changeId: "777000777" } as const;

const MARKETS = [
  { code: "IT", name: "Italy", currency: "EUR", timeZone: "Europe/Rome", vatBp: 2200, minimum: 300n, floor: 610n },
  { code: "FR", name: "France", currency: "EUR", timeZone: "Europe/Paris", vatBp: 2000, minimum: 300n, floor: 600n },
  { code: "DE", name: "Germany", currency: "EUR", timeZone: "Europe/Berlin", vatBp: 1900, minimum: 300n, floor: 595n },
  { code: "GB", name: "United Kingdom", currency: "GBP", timeZone: "Europe/London", vatBp: 2000, minimum: 260n, floor: 519n },
] as const;

// Business book §4.4, in minor units.
const PRICES: Record<string, Record<string, bigint>> = {
  IT: { individual: 1049n, duo: 1449n, family: 1799n, student: 579n },
  FR: { individual: 1099n, duo: 1499n, family: 1849n, student: 649n },
  DE: { individual: 1099n, duo: 1499n, family: 1899n, student: 599n },
  GB: { individual: 949n, duo: 1299n, family: 1649n, student: 529n },
};

const PLANS = [
  { id: "free", name: "Free", paid: false, skips: 6, audio: "standard", offline: false, seats: 1, student: false },
  { id: "individual", name: "Individual", paid: true, skips: 0, audio: "lossless", offline: true, seats: 1, student: false },
  { id: "duo", name: "Duo", paid: true, skips: 0, audio: "lossless", offline: true, seats: 2, student: false },
  { id: "family", name: "Family", paid: true, skips: 0, audio: "lossless", offline: true, seats: 5, student: false },
  { id: "student", name: "Student", paid: true, skips: 0, audio: "lossless", offline: true, seats: 1, student: true },
] as const;

type StoredChange = {
  id: string;
  kind: Kind;
  state: ChangeState;
  stateReason: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  versions: Array<{ version: number; author: string; createdAt: string; content: Content; hash: Uint8Array }>;
  approvals: Approval[];
  validation: ValidationReport | undefined;
  required: RequiredSignature[];
  authorReason: string;
};

// ----- the launches (stage 6), as the engine keeps them -----

const LAUNCH_STEPS = ["check", "prepare", "publish", "notify", "verify"] as const;
const LAUNCH_PURPOSES: Record<(typeof LAUNCH_STEPS)[number], string> = {
  check: "The change is still scheduled at its approved version, and nothing clashes with it.",
  prepare: "The new catalog snapshot is written, not yet live.",
  publish: "In one transaction: the change becomes active, the snapshot goes live, and the audit events and the site's notice are written.",
  notify: "The outbox delivers the notice to the site's inbox.",
  verify: "The live catalog, or the price list, shows the change as approved.",
};

export type StoredLaunch = {
  id: string;
  changeId: string;
  state: "running" | "done" | "failed" | "refused" | "cancelled";
  dueAt: string;
  startedAt: string;
  finishedAt: string;
  cause: string;
  retryAt: string;
  snapshotBefore: string;
  snapshotAfter: string;
  resolution: string;
  steps: Array<{
    name: (typeof LAUNCH_STEPS)[number]; state: "pending" | "running" | "done" | "failed"; startedAt: string; finishedAt: string;
    attempts: number; error: string; facts: Record<string, string>;
  }>;
  /** The audit events it wrote, by sequence number. */
  auditEvents: string[];
  incidents: Array<{ id: string; kind: "late" | "failed" | "refused"; state: "open" | "recovered" | "resolved"; summary: string; openedAt: string; closedAt: string; resolution: string }>;
};

// ----- the subscriber's side (stage 5), as the engine keeps it -----

/** A subscription, from startedOn until endedOn excluded (null: still running). Days are the market's, ISO 8601. */
export type StoredSubscription = {
  id: string;
  plan: string;
  paid: boolean;
  priceMinor: bigint;
  startedOn: string;
  endedOn: string | null;
  /** 0 on the free plan. */
  billingDay: number;
  quoteId: string | null;
  offerId: string | null;
  offerMonths: number;
  /** The first month's payment, asked after the confirmation; null when charged at it, on the free plan, and for the data's own. */
  payment?: StoredPayment | null;
  /** A prepaid pass's subscription (§9): the code it was activated with and what the pass cost; never charged. */
  prepaid?: { code: string; priceMinor: bigint } | null;
};

/** The first month's payment as the engine of stage 6 keeps it, settled by the provider's events. */
export type StoredPayment = {
  id: string;
  state: "pending" | "succeeded" | "failed";
  amountMinor: bigint;
  requestedAt: string;
  settledAt: string;
  failureReason: string;
  receipt: { id: string; issuedAt: string; reference: string } | null;
};

/** Codes are written for people: no 0 or O, no 1, I or L; three groups of four (commerce/domain/prepaid.py). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_SHAPE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

/** A code as people type it, in the form it is kept in: upper case, groups of four joined by dashes. */
function normalCode(text: string): string {
  const letters = [...text.toUpperCase()].filter((character) => /[A-Z0-9]/.test(character)).join("");
  return (letters.match(/.{1,4}/g) ?? []).join("-");
}

/** A prepaid pass's single-use code (§9.1), as the engine keeps it: bought by one listener, activated by any of its market. */
export type StoredCode = {
  id: string;
  code: string;
  passId: string;
  buyerId: string;
  market: string;
  plan: string;
  title: string;
  months: number;
  priceMinor: bigint;
  soldAt: string;
  soldOn: string;
  /** The last day it can be activated. */
  validUntil: string;
  payment: StoredPayment;
  activatedBy: string;
  activatedOn: string;
  subscriptionId: string;
};

export type StoredListener = {
  id: string;
  market: string;
  title: string;
  label: string;
  /** What the demo says: the simulated verifier finds no student record when false. */
  student: boolean;
  verifications: Array<{ verifiedOn: string; validUntil: string; provider: string; reference: string }>;
  subscriptions: StoredSubscription[];
};

export type StoredQuote = {
  id: string;
  market: string;
  plan: string;
  priceMinor: bigint;
  listMinor: bigint;
  months: number;
  offerId: string | null;
  /** Null for a quote asked without a listener, which any listener may confirm. */
  subscriberId: string | null;
  expiresAt: string;
};

/** What the engine knows of a published offer beyond its page: who may take it, its non-combinability group, its cap (0: none). */
/**
 * The rules of a published offer. An offer whose audience asks for listening
 * (§14.2) names the listeners in it: the fake engine counts no listening.
 */
export type OfferRules = { neverPaid: boolean; group: string; cap: number; listeners?: readonly string[] };

/** The demo's listeners by what they show, as the engine's generator labels them. */
export const LISTENERS = {
  verified: "5001", unverified: "5002", paidBefore: "5003", freeInFrance: "5004", familyInGermany: "5005", individualInItaly: "5006",
} as const;

const RECEIPT_NOTE = "Demonstration receipt from a simulated payment provider: no payment was taken, no money moved, "
  + "and no subscription contract was made.";

/**
 * The engine's six demo listeners (its generator's DEMO_LISTENERS), with
 * their days fixed around the tests' 24 October 2026 instead of counted back
 * from the data's last day: four on the free plan, and two who pay, whom a
 * price rise asks for consent (Germany) or tells in advance (Italy).
 */
function demoListeners(): StoredListener[] {
  const free = (id: string, startedOn: string, endedOn: string | null = null): StoredSubscription => ({
    id, plan: "free", paid: false, priceMinor: 0n, startedOn, endedOn, billingDay: 0, quoteId: null, offerId: null, offerMonths: 0,
  });
  return [
    {
      id: LISTENERS.verified, market: "IT", title: "Student in Italy, verified", student: true,
      label: "Simulated listener. A verified student in Italy who has never paid: the Student Autumn Pass is for them.",
      verifications: [{ verifiedOn: "2026-09-04", validUntil: "2027-09-04", provider: "simulated", reference: "" }],
      subscriptions: [free("1", "2026-04-07")],
    },
    {
      id: LISTENERS.unverified, market: "IT", title: "Student in Italy, not verified yet", student: true,
      label: "Simulated listener. A student in Italy who has never paid and has not verified yet: verifying opens the student offers.",
      verifications: [],
      subscriptions: [free("2", "2026-05-27")],
    },
    {
      id: LISTENERS.paidBefore, market: "IT", title: "Student in Italy who paid before", student: true,
      label: "Simulated listener. A verified student in Italy who paid for Student before: offers for people who have never paid are not for them.",
      verifications: [
        { verifiedOn: "2025-10-14", validUntil: "2026-10-14", provider: "simulated", reference: "" },
        { verifiedOn: "2026-09-24", validUntil: "2027-09-24", provider: "simulated", reference: "" },
      ],
      subscriptions: [
        free("3", "2025-09-19", "2025-10-19"),
        { id: "4", plan: "student", paid: true, priceMinor: 579n, startedOn: "2025-10-19", endedOn: "2026-06-26", billingDay: 19, quoteId: null, offerId: null, offerMonths: 0 },
        free("5", "2026-06-26"),
      ],
    },
    {
      id: LISTENERS.freeInFrance, market: "FR", title: "Free listener in France", student: false,
      label: "Simulated listener. On Free in France and not a student: list prices, and no offer for them.",
      verifications: [],
      subscriptions: [free("6", "2025-12-28")],
    },
    // Stage 7 (§14.3): who a Family price rise in Germany asks for consent, and a rise in Italy tells in advance.
    {
      id: LISTENERS.familyInGermany, market: "DE", title: "Family subscriber in Germany", student: false,
      label: "Simulated listener. Pays for Family in Germany since June 2025, billed on the 15th: a price rise there "
        + "asks for their consent first (§8.2).",
      verifications: [],
      subscriptions: [
        free("7", "2025-03-03", "2025-06-15"),
        { id: "8", plan: "family", paid: true, priceMinor: 1899n, startedOn: "2025-06-15", endedOn: null, billingDay: 15, quoteId: null, offerId: null, offerMonths: 0 },
      ],
    },
    {
      id: LISTENERS.individualInItaly, market: "IT", title: "Individual subscriber in Italy", student: false,
      label: "Simulated listener. Pays for Individual in Italy since May 2026, billed on the 8th: a price rise there "
        + "comes with notice, and they may leave before it applies (§8.3).",
      verifications: [],
      subscriptions: [
        free("9", "2026-02-06", "2026-05-08"),
        { id: "10", plan: "individual", paid: true, priceMinor: 1049n, startedOn: "2026-05-08", endedOn: null, billingDay: 8, quoteId: null, offerId: null, offerMonths: 0 },
      ],
    },
  ];
}

/** A day of the calendar moved by whole months, the end of a month kept as PostgreSQL's date + interval does. */
function addMonths(day: string, months: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const index = month - 1 + months;
  const y = year + Math.floor(index / 12);
  const m = (index % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(date, last)).padStart(2, "0")}`;
}

/** a / b rounded half up, for amounts that are not negative (the business book's round_half_up). */
const halfUp = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);

/**
 * Where a price goes, by the business book's formulas (§3.5, §5): the net
 * amount without VAT, the artists' pool at 60% of it but never less than the
 * market's minimum (the difference is the top-up), payment costs at 1.8% of
 * the price, and what is left.
 */
function breakdownOf(price: bigint, market: (typeof MARKETS)[number]) {
  const net = halfUp(price * 10_000n, 10_000n + BigInt(market.vatBp));
  const pool = halfUp(net * 60n, 100n);
  const artists = pool > market.minimum ? pool : market.minimum;
  const paymentCosts = halfUp(price * 18n, 1_000n);
  const amount = (value: bigint) => money(value, market.currency);
  return create(PriceBreakdownSchema, {
    price: amount(price), vat: amount(price - net), net: amount(net), artists: amount(artists), topUp: amount(artists - pool),
    paymentCosts: amount(paymentCosts), encoreKeeps: amount(net - artists - paymentCosts),
  });
}

/** A version's content and its fingerprint, from what CreateChange or SaveVersion carried. */
function contentOf(given: CreateChangeRequest["content"] | SaveVersionRequest["content"]): { content: Content; hash: Uint8Array } {
  switch (given.case) {
    case "offer":
      return { content: given.value, hash: sha256(toBinary(OfferContentSchema, given.value)) };
    case "listPrice":
      return { content: given.value, hash: sha256(toBinary(ListPriceContentSchema, given.value)) };
    case "priceMigration":
      return { content: given.value, hash: sha256(toBinary(PriceMigrationContentSchema, given.value)) };
    case "prepaid":
      return { content: given.value, hash: sha256(toBinary(PrepaidPassContentSchema, given.value)) };
    default:
      throw new ConnectError("a change needs its content: an offer, a list price, a price migration or a prepaid pass", Code.InvalidArgument);
  }
}

/** A version's content as the oneof of ChangeVersion carries it. */
function contentCase(content: Content) {
  switch (content.$typeName) {
    case "commerce.v1.OfferContent":
      return { case: "offer" as const, value: content };
    case "commerce.v1.ListPriceContent":
      return { case: "listPrice" as const, value: content };
    case "commerce.v1.PriceMigrationContent":
      return { case: "priceMigration" as const, value: content };
    case "commerce.v1.PrepaidPassContent":
      return { case: "prepaid" as const, value: content };
  }
}



// ----- price changes for existing subscribers (stage 7, §8, §14.3) -----

/** A price change of one subscription, as the engine keeps it; its state and dates are worked out when it is read. */
export type StoredPriceChange = {
  id: string;
  changeId: string;
  listenerId: string;
  subscriptionId: string;
  plan: string;
  market: string;
  oldMinor: bigint;
  newMinor: bigint;
  kind: "consent" | "notice";
  sentAt: string;
  /** The market's day the window ends, at 23:59. */
  windowEndsDay: string;
  startsLocal: string;
  answer: boolean | null;
  answeredOn: string;
};

const NOT_LAW = "The music service's choice, configurable per market; not a legal requirement.";

/** The roles as the engine's sentences name them (commerce/domain/policy.py). */
const ROLE_WORDS: Record<string, string> = {
  marketing: "marketing", commercial_lead: "the commercial lead", finance: "finance", catalog_manager: "the catalog manager",
  on_call: "the on-call engineer", auditor: "the auditor",
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A local time for sentences, as the engine writes it: 17 December 2026, 23:59 (Europe/Berlin). */
function describeLocal(local: string, timeZone: string): string {
  const [day = "", time = "00:00"] = local.split("T");
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return `${date} ${MONTH_NAMES[month - 1]} ${year}, ${time.slice(0, 5)} (${timeZone})`;
}

/** The markets' policies as the engine's ListMarkets gives them: the law and the music service's choice, never mixed (§8.1). */
const POLICIES: Record<string, { legalRequirement: "consent" | "notice"; legalBasis: string; legalSources: string[]; windowDays: number; afterWindow: string; commercialChoice: string; alternatives: string[] }> = {
  DE: {
    legalRequirement: "consent",
    legalBasis: "Germany: a price rise on a running subscription needs the subscriber's consent (Kammergericht, 15 November 2023, final after the Bundesgerichtshof's decisions of 30 January and 27 February 2025). Silence is not consent.",
    legalSources: ["German Civil Code, § 307", "Kammergericht, press release 27/2023 of 15 November 2023"],
    windowDays: 45, afterWindow: "move_to_free",
    commercialChoice: "Move the account to Free at the consent deadline, keeping playlists and library.",
    alternatives: ["End the paid subscription at the end of the billing period", "Keep the old price until a stated date"],
  },
  IT: {
    legalRequirement: "notice",
    legalBasis: "Italy: a price rise needs a justified reason stated in the contract, and the right to withdraw before it applies (Consumer Code, art. 33(2)(m) and (o)).",
    legalSources: ["Consumer Code, art. 33"], windowDays: 30, afterWindow: "new_price",
    commercialChoice: "Tell 30 days in advance; the new price applies to those who stay.", alternatives: [],
  },
  FR: {
    legalRequirement: "notice",
    legalBasis: "France: a rolling subscription's price may change after notice within a reasonable time, with the option to terminate before it applies (Consumer Code, art. R. 212-4).",
    legalSources: ["Consumer Code, art. R. 212-1 and R. 212-4"], windowDays: 30, afterWindow: "new_price",
    commercialChoice: "Tell 30 days in advance; the new price applies to those who stay.", alternatives: [],
  },
  GB: {
    legalRequirement: "notice",
    legalBasis: "United Kingdom: a price-variation term is more likely to be fair with sufficient advance notice and a genuine freedom to exit (Consumer Rights Act 2015, Schedule 2, paras 11 and 15; CMA37).",
    legalSources: ["Consumer Rights Act 2015, Schedule 2", "CMA37, 22 July 2026"], windowDays: 30, afterWindow: "new_price",
    commercialChoice: "Tell 30 days in advance; the new price applies to those who stay.", alternatives: [],
  },
};

/** A wall-clock time of a time zone as an instant in UTC: 2026-12-17T23:59 in Berlin is 2026-12-17T22:59:00Z. */
function utcOf(local: string, timeZone: string): string {
  const [day = "", time = "00:00"] = local.split("T");
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const [hh = 0, mm = 0] = time.split(":").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(guess));
    const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)?.value);
    guess += wanted - Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  }
  return new Date(guess).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** An instant as a wall-clock time of a time zone, to the minute: 2026-11-02T09:00. */
function localOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(instant);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** The day after, or before, in the calendar. */
function addDays(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** The engine's billing schedule (commerce/domain/billing.py): charged on the first day, then on the billing day each month. */
const LAST_BILLING_DAY = 28;
const billingDayFor = (start: string) => Math.min(Number(start.slice(8, 10)), LAST_BILLING_DAY);

function billingDate(start: string, billingDay: number, charge: number): string {
  if (charge === 0) return start;
  const [year = 0, month = 1] = start.split("-").map(Number);
  const index = month - 1 + charge;
  return `${year + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-${String(billingDay).padStart(2, "0")}`;
}

function chargesBy(start: string, billingDay: number, day: string): number {
  if (day < start) return 0;
  const [sy = 0, sm = 0] = start.split("-").map(Number);
  const [dy = 0, dm = 0] = day.split("-").map(Number);
  let count = Math.max(1, (dy - sy) * 12 + dm - sm - 1);
  while (billingDate(start, billingDay, count) <= day) count += 1;
  while (count > 1 && billingDate(start, billingDay, count - 1) > day) count -= 1;
  return count;
}

function schedule(start: string, billingDay: number, offerMonths: number, day: string) {
  const made = chargesBy(start, billingDay, day);
  const next = billingDate(start, billingDay, made);
  if (offerMonths <= 0) return { next, nextAtOfferPrice: false, offerMonthsLeft: 0, fullPriceFrom: null };
  const left = made >= 1 ? Math.max(0, offerMonths - made + 1) : offerMonths;
  return { next, nextAtOfferPrice: made < offerMonths, offerMonthsLeft: left, fullPriceFrom: billingDate(start, billingDay, offerMonths) };
}

export type Call = {
  readonly method: string;
  readonly requestId: string | null;
  readonly actor: string | null;
  readonly role: string | null;
  readonly idempotencyKey: string | null;
  readonly authorization: string | null;
  readonly message: unknown;
};

export type FakeEngineOptions = {
  readonly clock: () => Date;
  readonly port?: number;
  readonly token?: string;
  /** How many offers to seed, created by marketing-1, oldest first. */
  readonly offers?: number;
  readonly extraPeople?: Record<string, { label: string; roles: string[] }>;
  /** Plant SENTINEL values in every internal field the catalog's messages carry. */
  readonly sentinels?: boolean;
  /**
   * When the first month is charged: after the confirmation (the default),
   * through the engine's outbox as in stage 6, the payment PENDING until a
   * test settles it as the provider's events would; or at the confirmation,
   * as the engine of stage 5 did, the receipt in the answer itself.
   */
  readonly payments?: "after-confirmation" | "at-confirmation";
};

const money = (amountMinor: bigint, currency: string): Money => create(MoneySchema, { amountMinor, currency });
const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export class FakeEngine {
  readonly calls: Call[] = [];
  readonly people = new Map<string, { label: string; roles: string[] }>();
  readonly changes = new Map<string, StoredChange>();
  readonly audit: AuditEvent[] = [];
  readonly published: PublishedOffer[] = [];
  /** The rules of each published offer; an offer the tests publish needs its entry here. */
  readonly offerRules = new Map<string, OfferRules>([["9001", { neverPaid: true, group: "student", cap: 0 }]]);
  readonly listeners = new Map<string, StoredListener>(demoListeners().map((listener) => [listener.id, listener]));
  readonly quotes = new Map<string, StoredQuote>();
  /** The home's incidents of today, as GetOverview answers them; none unless a test adds them. */
  readonly incidents: MessageInitShape<typeof IncidentSchema>[] = [];
  /** The launches, by id; none unless a test seeds them (the fake engine runs no jobs). */
  readonly launches = new Map<string, StoredLaunch>();
  #nextLaunch = 1;
  /** The price changes of existing subscriptions, by id: a migration's start makes them (startMigration). */
  readonly priceChanges = new Map<string, StoredPriceChange>();
  /** The list prices migrations set for new subscribers, from their start. */
  readonly migratedPrices: Array<{ plan: string; market: string; amountMinor: bigint; fromLocal: string; changeId: string }> = [];
  #nextPriceChange = 1;
  readonly receipts: Array<{ id: string; subscriptionId: string; quoteId: string; subscriberId: string }> = [];
  /** The prepaid passes' codes sold, by code (§9). */
  readonly prepaidCodes = new Map<string, StoredCode>();
  #nextCode = 1;
  /** Idempotency keys and what they answered (the engine's behaviour 2). */
  readonly #idempotency = new Map<string, { method: string; actor: string; role: string; fingerprint: string; response: UnaryResponse }>();
  readonly #faults = new Map<string, { code: Code; message: string }>();
  readonly #delays = new Map<string, number>();
  readonly #options: FakeEngineOptions;
  #server: Http2Server | null = null;
  #nextId = 1;
  #quotes = 0;
  #nextSubscription = 100;
  #declineNext: string | null = null;
  replays = 0;

  constructor(options: FakeEngineOptions) {
    this.#options = options;
    for (const [id, person] of Object.entries({ ...DEMO_PEOPLE, ...options.extraPeople })) this.people.set(id, person);
    this.published.push(create(PublishedOfferSchema, {
      offerId: "9001",
      version: 3,
      market: "IT",
      plan: "student",
      title: "Student Autumn Pass",
      text: "Three months at a student price.",
      terms: "Verified students, new subscribers only. Then the Student price in force.",
      price: money(299n, "EUR"),
      listPrice: money(579n, "EUR"),
      monthsAtOfferPrice: 3,
      takeableUntil: { market: "IT", local: "2026-11-30T23:59", utc: "2026-11-30T22:59:00Z" },
      audience: "Verified students in Italy who have never had a paid plan",
      needsStudentCheck: true,
      // §14.1: €1.47 of the artists' €3.00 comes from the subscriber, and the music service adds €1.53.
      breakdown: breakdownOf(299n, MARKETS[0]),
    }));
    for (let index = 0; index < (options.offers ?? 0); index += 1) {
      this.seedOffer(`Seeded offer ${index + 1}`, "marketing-1", ChangeState.DRAFT);
    }
  }

  get port(): number {
    return this.#options.port ?? FAKE_ENGINE_PORT;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get token(): string {
    return this.#options.token ?? FAKE_TOKEN;
  }

  #now(): string {
    return this.#options.clock().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** How many calls of a method (or of all methods) reached the engine. */
  count(method?: string): number {
    return method === undefined ? this.calls.length : this.calls.filter((call) => call.method === method).length;
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  /** The next call of `method` fails with this gRPC code, before any business rule. */
  failNext(method: string, code: Code, message = "injected fault"): void {
    this.#faults.set(method, { code, message });
  }

  /** The next call of `method` answers after this many milliseconds. */
  delayNext(method: string, ms: number): void {
    this.#delays.set(method, ms);
  }

  /**
   * With payments at the confirmation (the engine of stage 5): the simulated
   * provider declines the next charge with this reason, as a real provider
   * may, and the confirmation is refused with PAYMENT_DECLINED.
   */
  declineNextCharge(reason: string): void {
    this.#declineNext = reason;
  }

  /**
   * With payments after the confirmation (stage 6): the provider's answer to
   * every pending payment, as its events settle them. Succeeded issues the
   * receipt; failed ends the paid subscription at the end of that day, with
   * the free plan from the day after. Returns how many it settled.
   */
  settlePayments(outcome: "succeeded" | "failed" = "succeeded", reason = "The simulated provider declined the charge."): number {
    let settled = 0;
    for (const listener of this.listeners.values()) {
      for (const subscription of [...listener.subscriptions]) {
        const payment = subscription.payment;
        if (payment?.state !== "pending") continue;
        payment.settledAt = this.#now();
        if (outcome === "succeeded") {
          payment.state = "succeeded";
          payment.receipt = {
            id: `r_${hex(sha256(`receipt-${payment.id}`)).slice(0, 32)}`, issuedAt: this.#now(),
            reference: `sim-pay-${hex(sha256(payment.id)).slice(0, 24)}`,
          };
          this.receipts.push({ id: payment.receipt.id, subscriptionId: subscription.id, quoteId: subscription.quoteId ?? "", subscriberId: listener.id });
        } else {
          payment.state = "failed";
          payment.failureReason = reason;
          const tomorrow = addDays(this.#today(listener.market), 1);
          subscription.endedOn = tomorrow;
          listener.subscriptions.push({
            id: String(this.#nextSubscription++), plan: "free", paid: false, priceMinor: 0n, startedOn: tomorrow, endedOn: null,
            billingDay: 0, quoteId: null, offerId: null, offerMonths: 0,
          });
        }
        settled += 1;
      }
    }
    // A prepaid pass's payment: succeeded, its code is ready; failed, the code is too.
    for (const code of this.prepaidCodes.values()) {
      const payment = code.payment;
      if (payment.state !== "pending") continue;
      payment.settledAt = this.#now();
      if (outcome === "succeeded") {
        payment.state = "succeeded";
        payment.receipt = {
          id: `r_${hex(sha256(`receipt-${payment.id}`)).slice(0, 32)}`, issuedAt: this.#now(),
          reference: `sim-pay-${hex(sha256(payment.id)).slice(0, 24)}`,
        };
      } else {
        payment.state = "failed";
        payment.failureReason = reason;
      }
      settled += 1;
    }
    return settled;
  }

  /**
   * Ends a listener's paid subscription today, back to the free plan from
   * today: a cancellation, which the engine does not model yet, to set up a
   * listener who took an offer before.
   */
  endPaidSubscription(listenerId: string): void {
    const listener = this.#listener(listenerId);
    const today = this.#today(listener.market);
    const current = this.#current(listener, today);
    if (!current?.paid) throw new Error(`listener ${listenerId} has no paid subscription to end`);
    current.endedOn = today;
    listener.subscriptions.push({
      id: String(this.#nextSubscription++), plan: "free", paid: false, priceMinor: 0n, startedOn: today, endedOn: null,
      billingDay: 0, quoteId: null, offerId: null, offerMonths: 0,
    });
  }

  /**
   * A launch of an offer of its own, as the engine leaves one: done (five
   * steps, published), failed at its publish step after 5 attempts, refused
   * at its check by a clash, or waiting to try its publish step again. A
   * failed or refused launch has its incident open, and its change stays
   * scheduled; a done one has its change active.
   */
  seedLaunch(shape: "done" | "failed" | "refused" | "waiting", title = `Launched offer ${this.#nextLaunch}`): StoredLaunch {
    const change = this.seedOffer(title, "marketing-1", shape === "done" ? ChangeState.ACTIVE : ChangeState.SCHEDULED);
    const id = String(this.#nextLaunch++);
    // Due at 07:59 UTC, a minute before a start at 09:00 in Rome; each step ten seconds after the one before.
    const at = (step: number) => `2026-11-02T07:59:${String(step * 10).padStart(2, "0")}Z`;
    const stopAt: Record<typeof shape, number> = { done: LAUNCH_STEPS.length, failed: 2, refused: 0, waiting: 2 };
    const steps = LAUNCH_STEPS.map((name, index) => {
      const stopped = index === stopAt[shape];
      const done = index < stopAt[shape];
      return {
        name, state: done ? "done" as const : stopped ? "failed" as const : "pending" as const,
        startedAt: done || stopped ? at(index) : "", finishedAt: done || stopped ? at(index) : "",
        attempts: done ? 1 : stopped ? (shape === "failed" ? 5 : shape === "waiting" ? 2 : 1) : 0,
        error: stopped ? (shape === "refused" ? "Another offer of the group student is live for the same people (§6.4)." : "the connection to the database was cut") : "",
        facts: name === "prepare" && done ? { snapshot: "42", offers: "3" } : name === "publish" && done ? { snapshot: "42", change: change.id } : {},
      };
    });
    const launch: StoredLaunch = {
      id, changeId: change.id, state: shape === "waiting" ? "running" : shape, dueAt: "2026-11-02T07:59:00Z", startedAt: at(0),
      finishedAt: shape === "waiting" ? "" : at(stopAt[shape]), cause: shape === "done" ? "" : steps[stopAt[shape]]?.error ?? "",
      retryAt: shape === "waiting" ? "2026-11-02T08:03:15Z" : "", snapshotBefore: shape === "refused" ? "" : "41",
      snapshotAfter: shape === "done" ? "42" : "", resolution: shape === "done" ? `published at ${at(2)}` : "", steps,
      auditEvents: [], incidents: [],
    };
    if (shape === "failed" || shape === "refused") {
      launch.incidents.push({
        id: String(100 + Number(id)), kind: shape, state: "open", summary: `launch-${id} ${shape === "failed" ? "failed at its publish step" : "was refused at its check"}.`,
        openedAt: at(stopAt[shape]), closedAt: "", resolution: "",
      });
    }
    if (shape === "done") launch.auditEvents.push(...this.#seedEvents(launch, ["change.activated", "catalog.published"]));
    this.launches.set(id, launch);
    return launch;
  }

  /** A price migration of the commercial lead's (§14.3: Family in Germany, from €18.99 to €20.99), in the state a test needs. */
  seedMigration(state: ChangeState, content: Partial<{ title: string; plan: string; market: string; amountMinor: bigint; noticesLocal: string; startsLocal: string }> = {}): StoredChange {
    const id = String(this.#nextId++);
    const market = content.market ?? "DE";
    const migration = create(PriceMigrationContentSchema, {
      title: content.title ?? "Family price in Germany", plan: content.plan ?? "family", market,
      amount: money(content.amountMinor ?? 2099n, this.#market(market).currency),
      noticesLocal: content.noticesLocal ?? "2026-11-02T09:00", startsLocal: content.startsLocal ?? "2026-12-01T00:00",
    });
    const now = this.#now();
    const stored: StoredChange = {
      id, kind: "priceMigration", state, stateReason: "", createdBy: "commercial-lead-1", createdAt: now, updatedAt: now,
      versions: [{ version: 1, author: "commercial-lead-1", createdAt: now, content: migration, hash: sha256(toBinary(PriceMigrationContentSchema, migration)) }],
      approvals: [], validation: undefined, required: [], authorReason: "",
    };
    stored.required = this.#required(stored);
    this.changes.set(id, stored);
    return stored;
  }

  /**
   * A price migration starts, as the engine's launch does at noticesLocal:
   * the change is active, new subscribers pay the new price from
   * startsLocal, and every paid subscription of the plan in the market gets
   * its price change, by the rules of the market (§8): a request for consent
   * in Germany, a notice elsewhere. Prepaid passes are never touched (the
   * fake engine sells none).
   */
  startMigration(changeId: string): StoredPriceChange[] {
    const stored = this.#stored(changeId);
    const content = stored.versions.at(-1)?.content;
    if (content?.$typeName !== "commerce.v1.PriceMigrationContent") throw new Error(`change ${changeId} is no price migration`);
    const policy = POLICIES[content.market];
    if (policy === undefined) throw new Error(`no policy for ${content.market}`);
    stored.state = ChangeState.ACTIVE;
    const amountMinor = content.amount?.amountMinor ?? 0n;
    this.migratedPrices.push({ plan: content.plan, market: content.market, amountMinor, fromLocal: content.startsLocal, changeId });
    const windowEndsDay = addDays(content.noticesLocal.slice(0, 10), policy.windowDays);
    const made: StoredPriceChange[] = [];
    for (const listener of this.listeners.values()) {
      if (listener.market !== content.market) continue;
      const current = this.#current(listener, this.#today(listener.market));
      if (!current?.paid || current.plan !== content.plan || current.prepaid) continue;
      const change: StoredPriceChange = {
        id: String(this.#nextPriceChange++), changeId, listenerId: listener.id, subscriptionId: current.id, plan: content.plan, market: content.market,
        oldMinor: current.priceMinor, newMinor: amountMinor, kind: policy.legalRequirement, sentAt: this.#now(), windowEndsDay,
        startsLocal: content.startsLocal, answer: null, answeredOn: "",
      };
      this.priceChanges.set(change.id, change);
      made.push(change);
    }
    return made;
  }

  /** The listeners on a paid subscription of a plan in a market today; a prepaid pass is no subscription a price change touches (§9.1). */
  #paidOf(plan: string, market: string): StoredListener[] {
    return [...this.listeners.values()].filter((listener) => {
      if (listener.market !== market) return false;
      const current = this.#current(listener, this.#today(market));
      return current?.paid === true && current.plan === plan && !current.prepaid;
    });
  }

  /**
   * A prepaid pass of the commercial lead's (§9, §14.4: three months of
   * Individual in Italy, €29.99, on sale from 1 October 2026), in the state a
   * test needs: ACTIVE puts it on sale, as its launch would.
   */
  seedPrepaidPass(state: ChangeState, content: Partial<{
    title: string; plan: string; months: number; prices: Array<{ market: string; amountMinor: bigint }>;
    periods: Array<{ market: string; startsLocal: string; endsLocal?: string }>; codeValidMonths: number;
  }> = {}): StoredChange {
    const id = String(this.#nextId++);
    const title = content.title ?? "Three-month gift pass";
    const prices = content.prices ?? [{ market: "IT", amountMinor: 2999n }];
    const pass = create(PrepaidPassContentSchema, {
      title, plan: content.plan ?? "individual", months: content.months ?? 3,
      prices: prices.map((price) => ({ market: price.market, price: { case: "fixed" as const, value: money(price.amountMinor, this.#market(price.market).currency) } })),
      periods: (content.periods ?? [{ market: "IT", startsLocal: "2026-10-01T00:00" }]).map((period) => ({ ...period, endsLocal: period.endsLocal ?? "" })),
      codeValidMonths: content.codeValidMonths ?? 12,
      pages: prices.map((price) => ({
        market: price.market, title, text: "Three months of Individual, paid once: a code to keep, or to give.",
        terms: "A single-use code. It never renews, and price changes made after it was sold do not touch it.", treatment: "standard",
      })),
    });
    const now = this.#now();
    const stored: StoredChange = {
      id, kind: "prepaid", state, stateReason: "", createdBy: "commercial-lead-1", createdAt: now, updatedAt: now,
      versions: [{ version: 1, author: "commercial-lead-1", createdAt: now, content: pass, hash: sha256(toBinary(PrepaidPassContentSchema, pass)) }],
      approvals: [], validation: undefined, required: [], authorReason: "",
    };
    stored.required = this.#required(stored);
    this.changes.set(id, stored);
    return stored;
  }

  /** The prepaid passes on sale in a market now (§9): active, with a price there and a period that holds the instant. */
  #passesOnSale(code: string) {
    const market = this.#market(code);
    const local = localOf(this.#options.clock(), market.timeZone);
    return [...this.changes.values()].flatMap((stored) => {
      const pass = stored.versions.at(-1)?.content;
      if (stored.kind !== "prepaid" || stored.state !== ChangeState.ACTIVE || pass?.$typeName !== "commerce.v1.PrepaidPassContent") return [];
      const price = pass.prices.find((candidate) => candidate.market === code);
      const open = pass.periods.some((period) => period.market === code && period.startsLocal <= local && (period.endsLocal === "" || local < period.endsLocal));
      if (price?.price.case !== "fixed" || !open) return [];
      const page = pass.pages.find((candidate) => candidate.market === code);
      return [{
        passId: stored.id, market: code, title: page?.title || pass.title, plan: pass.plan, months: pass.months, price: price.price.value,
        codeValidMonths: pass.codeValidMonths, text: page?.text ?? "", terms: page?.terms ?? "",
      }];
    });
  }

  /** The prepaid passes of a plan in a market that a price change never touches (§9.1): running, or paid for and not used yet. */
  #untouchedPasses(plan: string, market: string): bigint {
    const today = this.#today(market);
    return BigInt([...this.prepaidCodes.values()].filter((code) => {
      if (code.plan !== plan || code.market !== market) return false;
      const state = this.#codeState(code);
      if (state === "ready") return true;
      if (state !== "activated") return false;
      const running = [...this.listeners.values()].flatMap((listener) => listener.subscriptions).find((subscription) => subscription.id === code.subscriptionId);
      return running !== undefined && running.endedOn !== null && today < running.endedOn;
    }).length);
  }

  /** Where a code stands on its market's day: activated, its payment failed, past its last day, its payment pending, or ready. */
  #codeState(code: StoredCode): "pending" | "ready" | "activated" | "expired" | "failed" {
    if (code.activatedOn !== "") return "activated";
    if (code.payment.state === "failed") return "failed";
    if (this.#today(code.market) > code.validUntil) return "expired";
    return code.payment.state === "pending" ? "pending" : "ready";
  }

  #codeMessage(code: StoredCode): PrepaidCode {
    const currency = this.#market(code.market).currency;
    return create(PrepaidCodeSchema, {
      code: code.code, passId: code.passId, title: code.title, plan: code.plan, market: code.market, months: code.months,
      price: money(code.priceMinor, currency), soldAt: code.soldAt, validUntil: code.validUntil, state: this.#codeState(code),
      payment: this.#payment(code.payment, currency),
      activatedBy: this.#options.sentinels ? SENTINEL.changeId : code.activatedBy || "0", activatedOn: code.activatedOn,
    });
  }

  /**
   * The value of the prepaid passes sold and not yet earned, by market, on
   * the market's day (§9.2): a pass's net amount is earned in equal monthly
   * parts from its activation, the first on that day and the last taking the
   * remainder; a code not activated stays unearned until it expires.
   */
  #prepaidValues() {
    const rows = new Map<string, { sold: bigint; activated: bigint; expired: bigint; unearned: bigint }>();
    for (const code of this.prepaidCodes.values()) {
      if (code.payment.state !== "succeeded") continue;
      const row = rows.get(code.market) ?? { sold: 0n, activated: 0n, expired: 0n, unearned: 0n };
      rows.set(code.market, row);
      const market = this.#market(code.market);
      const net = halfUp(code.priceMinor * 10_000n, 10_000n + BigInt(market.vatBp));
      row.sold += 1n;
      const state = this.#codeState(code);
      if (state === "expired") {
        row.expired += 1n;
      } else if (state === "activated") {
        row.activated += 1n;
        const billingDay = billingDayFor(code.activatedOn);
        const today = this.#today(code.market);
        const parts = Array.from({ length: code.months }, (_, charge) => billingDate(code.activatedOn, billingDay, charge)).filter((day) => day <= today).length;
        const earned = parts >= code.months ? net : (net / BigInt(code.months)) * BigInt(parts);
        row.unearned += net - earned;
      } else {
        row.unearned += net;
      }
    }
    // Euros at the declared rate: 1 EUR = 0.83728 GBP.
    const inEuros = (amount: bigint, currency: string) => (currency === "GBP" ? halfUp(amount * 100_000n, 83_728n) : amount);
    return [...rows.entries()].map(([code, row]) => {
      const currency = this.#market(code).currency;
      return {
        market: code, sold: row.sold, activated: row.activated, expired: row.expired,
        unearned: money(row.unearned, currency), unearnedEur: money(inEuros(row.unearned, currency), "EUR"),
      };
    });
  }

  /**
   * The blocking checks of a price migration, as the engine's validation has
   * them: its price above the list price in force (price), its dates still to
   * come and in order (dates), and no other change of the plan's price in the
   * market in progress (overlap).
   */
  #migrationFindings(stored: StoredChange, content: PriceMigrationContent) {
    const findings: Array<{ check: string; market: string; message: string; facts: Record<string, string> }> = [];
    const market = content.market;
    const list = this.#listPriceNow(content.plan, market);
    const amount = content.amount?.amountMinor ?? 0n;
    if (amount <= list) {
      findings.push({ check: "price", market, message: "A price migration raises the price: the new one must be above the list price in force.", facts: { list_price: String(list), amount: String(amount) } });
    }
    const now = localOf(this.#options.clock(), this.#market(market).timeZone);
    if (content.noticesLocal <= now) {
      findings.push({ check: "dates", market, message: "Existing subscribers can only be asked or told from a time still to come.", facts: { notices_local: content.noticesLocal } });
    } else if (content.startsLocal < content.noticesLocal) {
      findings.push({ check: "dates", market, message: "New subscribers cannot pay the new price before existing ones are asked or told.", facts: { starts_local: content.startsLocal } });
    }
    const inProgress = [ChangeState.VALIDATED, ChangeState.IN_APPROVAL, ChangeState.APPROVED, ChangeState.SCHEDULED];
    const other = [...this.changes.values()].find((candidate) => {
      if (candidate.id === stored.id || (candidate.kind !== "listPrice" && candidate.kind !== "priceMigration")) return false;
      const theirs = candidate.versions.at(-1)?.content;
      if (theirs === undefined || theirs.$typeName === "commerce.v1.OfferContent" || theirs.$typeName === "commerce.v1.PrepaidPassContent") return false;
      if (theirs.plan !== content.plan || theirs.market !== market) return false;
      return inProgress.includes(candidate.state) || (candidate.kind === "priceMigration" && candidate.state === ChangeState.ACTIVE);
    });
    if (other !== undefined) {
      findings.push({ check: "overlap", market, message: `Change #${other.id} already changes this plan's price in this market.`, facts: { change: other.id } });
    }
    return findings;
  }

  /** The list price of a plan in a market now: the book's, or a migration's from its start. */
  #listPriceNow(plan: string, market: string): bigint {
    const local = localOf(this.#options.clock(), this.#market(market).timeZone);
    const migrated = this.migratedPrices.filter((entry) => entry.plan === plan && entry.market === market && entry.fromLocal <= local).at(-1);
    return migrated?.amountMinor ?? PRICES[market]?.[plan] ?? 0n;
  }

  /**
   * Where a price change stands on the market's day of the read (§8, the
   * contract's PriceChange): its state, and the dates only the engine can
   * work out on the subscription's own billing days. A paid month is never
   * cut short; an offer's months are never charged at the new price.
   */
  #priceChangeView(change: StoredPriceChange) {
    const listener = this.#listener(change.listenerId);
    const subscription = listener.subscriptions.find((candidate) => candidate.id === change.subscriptionId);
    if (subscription === undefined) throw new Error(`price change ${change.id} has no subscription`);
    const today = this.#today(change.market);
    const timeZone = this.#market(change.market).timeZone;
    const closed = this.#options.clock().getTime() >= Date.parse(utcOf(`${change.windowEndsDay}T23:59`, timeZone));
    const onOrAfter = (day: string) => {
      for (let charge = 0; charge < 600; charge += 1) {
        const date = billingDate(subscription.startedOn, subscription.billingDay, charge);
        if (date >= day) return date;
      }
      throw new Error("no billing date");
    };
    const outsideOffer = (day: string) => {
      if (subscription.offerMonths <= 0) return day;
      const fullFrom = billingDate(subscription.startedOn, subscription.billingDay, subscription.offerMonths);
      return fullFrom > day ? fullFrom : day;
    };
    const later = (a: string, b: string) => (a > b ? a : b);
    const startsDay = change.startsLocal.slice(0, 10);
    const view = { state: "waiting", newPriceFrom: "", appliesFrom: "", ifNoLeavesOn: "", leavesOn: "", endsOn: "" };
    if (change.kind === "consent") {
      // Without a yes, the first charge on or after the deadline's day, not before new subscribers pay the new price
      // and outside an offer's months: a paid month is never cut short. A no decides it at once.
      const leaving = onOrAfter(outsideOffer(later(change.windowEndsDay, startsDay)));
      if (change.answer === true) {
        view.state = "accepted";
        view.newPriceFrom = onOrAfter(outsideOffer(later(addDays(change.answeredOn, 1), startsDay)));
      } else if (change.answer === false) {
        view.state = "declined";
        view.leavesOn = leaving;
        view.endsOn = leaving;
      } else if (closed) {
        view.state = "lapsed";
        view.leavesOn = leaving;
        view.endsOn = leaving;
      } else {
        view.appliesFrom = onOrAfter(outsideOffer(later(addDays(today, 1), startsDay)));
        view.ifNoLeavesOn = leaving;
        view.endsOn = leaving;
      }
    } else {
      // The first charge after the notice ends.
      const after = onOrAfter(outsideOffer(addDays(change.windowEndsDay, 1)));
      if (change.answer === false) {
        view.state = "declined";
        view.leavesOn = after;
        view.endsOn = after;
      } else if (closed) {
        view.state = "new_price";
        view.newPriceFrom = after;
      } else {
        view.appliesFrom = after;
        view.ifNoLeavesOn = after;
      }
    }
    return view;
  }

  #priceChangeMessage(change: StoredPriceChange): PriceChange {
    const market = this.#market(change.market);
    const policy = POLICIES[change.market];
    const view = this.#priceChangeView(change);
    const windowEnds = `${change.windowEndsDay}T23:59`;
    return create(PriceChangeSchema, {
      priceChangeId: change.id, changeId: this.#options.sentinels ? SENTINEL.changeId : change.changeId, plan: change.plan,
      oldPrice: money(change.oldMinor, market.currency), newPrice: money(change.newMinor, market.currency), kind: change.kind, sentAt: change.sentAt,
      windowEnds: { market: change.market, local: windowEnds, utc: utcOf(windowEnds, market.timeZone) },
      newSubscribersFrom: { market: change.market, local: change.startsLocal, utc: utcOf(change.startsLocal, market.timeZone) },
      state: view.state, newPriceFrom: view.newPriceFrom, appliesFrom: view.appliesFrom, ifNoLeavesOn: view.ifNoLeavesOn, leavesOn: view.leavesOn,
      ifNoAnswer: `${policy?.commercialChoice ?? ""} This is the music service's choice for the market, not a legal requirement.`,
      legalBasis: `${policy?.legalBasis ?? ""} Sources: ${(policy?.legalSources ?? []).join("; ")}.`,
    });
  }

  /** Where a started migration's existing subscribers stand; undefined before it started. */
  #migrationProgress(stored: StoredChange) {
    const content = stored.versions.at(-1)?.content;
    if (content?.$typeName !== "commerce.v1.PriceMigrationContent") return undefined;
    const changes = [...this.priceChanges.values()].filter((change) => change.changeId === stored.id);
    if (stored.state !== ChangeState.ACTIVE && changes.length === 0) return undefined;
    const policy = POLICIES[content.market];
    const market = this.#market(content.market);
    const windowEnds = `${addDays(content.noticesLocal.slice(0, 10), policy?.windowDays ?? 0)}T23:59`;
    const views = changes.map((change) => this.#priceChangeView(change));
    const counted = (state: string) => BigInt(views.filter((view) => view.state === state).length);
    // Left: on the free plan, or ended, from the day their paid subscription ended because of the migration.
    const today = this.#today(content.market);
    const left = BigInt(views.filter((view) => view.leavesOn !== "" && view.leavesOn <= today).length);
    return create(MigrationProgressSchema, {
      requirement: policy?.legalRequirement ?? "", windowEnds: { market: content.market, local: windowEnds, utc: utcOf(windowEnds, market.timeZone) },
      asked: BigInt(changes.length), waiting: counted("waiting"), accepted: counted("accepted"), declined: counted("declined"),
      lapsed: counted("lapsed"), newPrice: counted("new_price"), left,
    });
  }

  /** Audit events written by a launch's own job, as the engine writes them: actor activation, its run as the request id. */
  #seedEvents(launch: StoredLaunch, actions: string[]): string[] {
    return actions.map((action) => {
      const previous = this.audit.at(-1);
      const seq = String(this.audit.length + 1);
      const prevHash = previous?.hash ?? new Uint8Array(32);
      const fields = {
        seq, at: this.#now(), actor: "activation", actorRole: "system", action,
        subject: action.startsWith("change.") ? `change:${launch.changeId}` : "catalog", requestId: `launch-${launch.id}`, reason: "", bodyJson: "{}",
      };
      this.audit.push(create(AuditEventSchema, { ...fields, prevHash, hash: sha256(Buffer.concat([prevHash, Buffer.from(JSON.stringify(fields))])) }));
      return seq;
    });
  }

  /** An offer in Italy at `price` cents, with its page unless `withPage` is false (validation then refuses it). */
  seedOffer(title: string, author: string, state: ChangeState, options: { price?: bigint; withPage?: boolean } = {}): StoredChange {
    const id = String(this.#nextId++);
    const offer = create(OfferContentSchema, {
      title,
      plan: "student",
      audience: { segment: 1, needsStudentCheck: true },
      prices: [{ market: "IT", price: { case: "fixed", value: money(options.price ?? 299n, "EUR") } }],
      monthsAtOfferPrice: 3,
      periods: [{ market: "IT", startsLocal: "2026-11-02T09:00", endsLocal: "2026-11-30T23:59" }],
      nonCombinabilityGroup: "student",
      redemptionCap: 0,
      pages: options.withPage === false
        ? []
        : [{ market: "IT", title, text: "Three months at a student price.", terms: "New subscribers only.", treatment: "standard" }],
    });
    const now = this.#now();
    const stored: StoredChange = {
      id, kind: "offer", state, stateReason: "", createdBy: author, createdAt: now, updatedAt: now,
      versions: [{ version: 1, author, createdAt: now, content: offer, hash: sha256(toBinary(OfferContentSchema, offer)) }],
      approvals: [], validation: undefined, required: [], authorReason: "",
    };
    stored.required = this.#required(stored);
    this.changes.set(id, stored);
    return stored;
  }

  // ----- what the engine answers -----

  #person(id: string): Person {
    const person = this.people.get(id);
    return create(PersonSchema, { id, label: person?.label ?? id, roles: (person?.roles ?? []).map((role) => ROLE_NUMBER[role] ?? Role.UNSPECIFIED) });
  }

  #market(code: string) {
    const market = MARKETS.find((candidate) => candidate.code === code);
    if (market === undefined) throw new ConnectError(`no market ${code}`, Code.NotFound);
    return market;
  }

  /** A quote's breakdown, which the site never shows: with sentinels, every amount is the mark. */
  #quoteBreakdown(price: bigint, market: (typeof MARKETS)[number]) {
    if (!this.#options.sentinels) return breakdownOf(price, market);
    const mark = money(SENTINEL.amount, market.currency);
    return create(PriceBreakdownSchema, { price: mark, vat: mark, net: mark, artists: mark, topUp: mark, paymentCosts: mark, encoreKeeps: mark });
  }

  // The artists' minimum and the VAT rate are public (§1.2); the floor is the console's alone, and carries the mark.
  #marketMessage(market: (typeof MARKETS)[number]): Market {
    const planted = this.#options.sentinels;
    const policy = POLICIES[market.code];
    return create(MarketSchema, {
      code: market.code, name: market.name, currency: market.currency, minorUnits: 2, timeZone: market.timeZone, vatBp: market.vatBp,
      artistsMinimum: money(market.minimum, market.currency),
      floor: money(planted ? SENTINEL.amount : market.floor, market.currency),
      // Stage 7 (§8): the law and the music service's choice, in fields apart.
      ...(policy ? { priceChangePolicy: { market: market.code, ...policy, label: NOT_LAW } } : {}),
    });
  }

  #plans(code: string): Plan[] {
    const market = this.#market(code);
    return PLANS.map((plan) => {
      const price = PRICES[code]?.[plan.id];
      return create(PlanSchema, {
        id: plan.id, name: plan.name, paid: plan.paid,
        entitlements: { skipsPerHour: plan.skips, audio: plan.audio, offline: plan.offline, seats: plan.seats, needsStudentCheck: plan.student },
        ...(price === undefined ? {} : { listPrice: money(price, market.currency), breakdown: breakdownOf(price, market) }),
      });
    });
  }

  #priceList(code: string, plan: string): PriceListEntry[] {
    const planted = this.#options.sentinels;
    const entries: PriceListEntry[] = [];
    let id = 100;
    for (const market of MARKETS) {
      for (const [planId, price] of Object.entries(PRICES[market.code] ?? {})) {
        id += 1;
        if ((code && code !== market.code) || (plan && plan !== planId)) continue;
        // A migration's new price follows the book's, from its start for new subscribers (§8).
        const migrated = this.migratedPrices.filter((entry) => entry.plan === planId && entry.market === market.code);
        entries.push(create(PriceListEntrySchema, {
          id: String(id), plan: planId, market: market.code, amount: money(price, market.currency),
          validFromLocal: "2026-01-01T00:00", validUntilLocal: migrated[0]?.fromLocal ?? "",
          changeId: planted ? SENTINEL.changeId : "0",
          belowFloor: planted ? true : price < market.floor,
          topUp: money(planted ? SENTINEL.amount : 0n, market.currency),
        }));
        for (const entry of migrated) {
          entries.push(create(PriceListEntrySchema, {
            id: `9${entry.changeId}`, plan: planId, market: market.code, amount: money(entry.amountMinor, market.currency),
            validFromLocal: entry.fromLocal, validUntilLocal: "", changeId: planted ? SENTINEL.changeId : entry.changeId,
            belowFloor: planted ? true : entry.amountMinor < market.floor, topUp: money(planted ? SENTINEL.amount : 0n, market.currency),
          }));
        }
      }
    }
    return entries;
  }

  #change(stored: StoredChange): Change {
    const current = stored.versions.at(-1);
    const migration = this.#migrationProgress(stored);
    return create(ChangeSchema, {
      id: stored.id,
      kind: KIND_NUMBER[stored.kind],
      title: current?.content.title ?? "",
      state: stored.state,
      stateReason: stored.stateReason,
      currentVersion: current?.version ?? 0,
      createdBy: stored.createdBy,
      createdAt: stored.createdAt,
      versions: stored.versions.map((version) => create(ChangeVersionSchema, {
        version: version.version, author: version.author, createdAt: version.createdAt, contentHash: version.hash,
        content: contentCase(version.content),
      })),
      approvals: stored.approvals,
      ...(stored.validation ? { validation: stored.validation } : {}),
      requiredSignatures: stored.required,
      sentence: `${current?.content.title ?? ""}: a sentence the engine writes.`,
      authorReason: stored.authorReason,
      ...(migration ? { migration } : {}),
    });
  }

  #summary(stored: StoredChange) {
    const change = this.#change(stored);
    const content = stored.versions.at(-1)?.content;
    const markets = content?.$typeName === "commerce.v1.OfferContent" || content?.$typeName === "commerce.v1.PrepaidPassContent"
      ? content.prices.map((price) => price.market)
      : content ? [content.market] : [];
    return create(ChangeSummarySchema, {
      id: change.id, kind: change.kind, title: change.title, state: change.state, currentVersion: change.currentVersion,
      createdBy: change.createdBy, markets, requiredSignatures: change.requiredSignatures, updatedAt: stored.updatedAt,
    });
  }

  #required(stored: StoredChange): RequiredSignature[] {
    const content = stored.versions.at(-1)?.content;
    if (content?.$typeName === "commerce.v1.ListPriceContent") {
      return [create(RequiredSignatureSchema, { role: Role.FINANCE, conditions: [1], why: "a list price changes", signed: false })];
    }
    if (content?.$typeName === "commerce.v1.PriceMigrationContent") {
      return [create(RequiredSignatureSchema, {
        role: Role.FINANCE, conditions: [1, 5], why: "a list price changes, and existing subscribers are asked to accept a higher price", signed: false,
      })];
    }
    if (content?.$typeName === "commerce.v1.PrepaidPassContent") {
      return [create(RequiredSignatureSchema, { role: Role.FINANCE, conditions: [1], why: "a prepaid pass is a price", signed: false })];
    }
    const below = (content?.prices ?? []).some((price) => {
      const floor = MARKETS.find((market) => market.code === price.market)?.floor ?? 0n;
      return price.price.case === "fixed" && price.price.value.amountMinor < floor;
    });
    return below
      ? [create(RequiredSignatureSchema, { role: Role.FINANCE, conditions: [2], why: "an offer price is below the floor", signed: false })]
      : [create(RequiredSignatureSchema, { role: Role.COMMERCIAL_LEAD, conditions: [], why: "commercial lead or finance", signed: false })];
  }

  /** An audit event; its author is the call's person, or `by` for the subscriber's calls, which carry none. */
  #log(context: HandlerContext, action: string, subject: string, reason = "", body: Record<string, unknown> = {}, by?: { actor: string; role: string }): void {
    const previous = this.audit.at(-1);
    const seq = BigInt(this.audit.length + 1);
    const prevHash = previous?.hash ?? new Uint8Array(32);
    const fields = {
      seq: String(seq), at: this.#now(), actor: by?.actor ?? context.requestHeader.get("x-actor") ?? "system",
      actorRole: by?.role ?? context.requestHeader.get("x-actor-role") ?? "system", action, subject,
      requestId: context.requestHeader.get("x-request-id") ?? "", reason, bodyJson: JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)),
    };
    this.audit.push(create(AuditEventSchema, { ...fields, prevHash, hash: sha256(Buffer.concat([prevHash, Buffer.from(JSON.stringify(fields))])) }));
  }

  #refuse(code: RefusalCode, reason: string, facts: Record<string, string> = {}) {
    return { outcome: { case: "refusal" as const, value: create(RefusalSchema, { code, reason, facts }) } };
  }

  #answer(stored: StoredChange) {
    stored.updatedAt = this.#now();
    return { outcome: { case: "change" as const, value: this.#change(stored) } };
  }

  #stored(id: string): StoredChange {
    const stored = this.changes.get(id);
    if (stored === undefined) throw new ConnectError(`no change ${id}`, Code.NotFound);
    return stored;
  }

  // ----- the subscriber's side -----

  /** The listener a subscriber call names: 0 is no one (INVALID_ARGUMENT), an unknown one NOT_FOUND, as the engine says. */
  #listener(subscriberId: string): StoredListener {
    if (subscriberId === "" || subscriberId === "0") throw new ConnectError("subscriber_id names the listener of the site's session", Code.InvalidArgument);
    const listener = this.listeners.get(subscriberId);
    if (listener === undefined) throw new ConnectError(`no subscriber #${subscriberId}`, Code.NotFound);
    return listener;
  }

  /** The market's day of the engine's clock. */
  #today(market: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.#market(market).timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(this.#options.clock());
  }

  #current(listener: StoredListener, today: string): StoredSubscription | undefined {
    return listener.subscriptions.find((subscription) => subscription.startedOn <= today && (subscription.endedOn === null || subscription.endedOn > today));
  }

  #latestVerification(listener: StoredListener, today: string) {
    const latest = [...listener.verifications].sort((a, b) => b.verifiedOn.localeCompare(a.verifiedOn))[0];
    if (latest === undefined) return undefined;
    return create(StudentVerificationSchema, {
      ...latest,
      reference: this.#options.sentinels ? SENTINEL.text : latest.reference,
      valid: latest.verifiedOn <= today && today < latest.validUntil,
    });
  }

  #verifiedOn(listener: StoredListener, today: string): boolean {
    return listener.verifications.some((verification) => verification.verifiedOn <= today && today < verification.validUntil);
  }

  /** The audience of every offer here asks for people who have never paid, when its rules say so. */
  #inAudience(listener: StoredListener, offerId: string): boolean {
    const rules = this.offerRules.get(offerId);
    if (rules?.listeners !== undefined && !rules.listeners.includes(listener.id)) return false;
    return !rules?.neverPaid || !listener.subscriptions.some((subscription) => subscription.paid);
  }

  /** A subscription as the engine answers it on a day: its price, its offer's months, its next charge (§4.3, §6.1). */
  #subscription(listener: StoredListener, stored: StoredSubscription, today: string): Subscription {
    const currency = this.#market(listener.market).currency;
    const message = create(SubscriptionSchema, {
      subscriptionId: this.#options.sentinels ? SENTINEL.changeId : stored.id, plan: stored.plan, market: listener.market, paid: stored.paid,
      price: money(stored.priceMinor, currency), startedOn: stored.startedOn, offerId: stored.offerId ?? "0",
    });
    if (!stored.paid) return message;
    if (stored.prepaid) {
      // §9: its months were paid with the pass; no charge, no renewal, then the free plan.
      message.price = money(0n, currency);
      message.prepaidCode = stored.prepaid.code;
      message.prepaidPrice = money(stored.prepaid.priceMinor, currency);
      message.billingDay = stored.billingDay;
      message.endsOn = stored.endedOn ?? "";
      return message;
    }
    const at = schedule(stored.startedOn, stored.billingDay, stored.offerMonths, today);
    message.billingDay = stored.billingDay;
    message.nextBillingOn = at.next;
    let nextCharge = money(stored.priceMinor, currency);
    if (stored.offerMonths > 0 && at.fullPriceFrom !== null) {
      const full = money(PRICES[listener.market]?.[stored.plan] ?? 0n, currency);
      message.offerTitle = this.published.find((offer) => offer.offerId === stored.offerId)?.title ?? "";
      message.offerMonths = stored.offerMonths;
      message.offerMonthsLeft = at.offerMonthsLeft;
      message.fullPriceFrom = at.fullPriceFrom;
      message.fullPrice = full;
      if (at.offerMonthsLeft === 0) message.price = full;
      if (!at.nextAtOfferPrice) nextCharge = full;
    }
    message.nextCharge = nextCharge;
    // Its price changes (§8): the day it ends if the listener does nothing more, and the new price once accepted or noticed:
    // in the next charge from the first one at the new price, and in the price itself from that day.
    for (const change of [...this.priceChanges.values()].filter((candidate) => candidate.subscriptionId === stored.id)) {
      const view = this.#priceChangeView(change);
      if (view.endsOn !== "" && (message.endsOn === "" || view.endsOn < message.endsOn)) message.endsOn = view.endsOn;
      if (view.newPriceFrom !== "" && message.nextBillingOn >= view.newPriceFrom) message.nextCharge = money(change.newMinor, currency);
      if (view.newPriceFrom !== "" && today >= view.newPriceFrom) message.price = money(change.newMinor, currency);
    }
    // No next charge when the subscription ends by then.
    if (message.endsOn !== "" && message.endsOn <= message.nextBillingOn) {
      message.nextBillingOn = "";
      delete message.nextCharge;
    }
    return message;
  }

  /** A launch as the engine answers it: its steps and audit events only in GetLaunch (detail), its incidents always. */
  #launchMessage(launch: StoredLaunch, detail: boolean): LaunchRun {
    const change = this.#stored(launch.changeId);
    const current = change.versions.at(-1);
    const states = { running: LaunchState.RUNNING, done: LaunchState.DONE, failed: LaunchState.FAILED, refused: LaunchState.REFUSED, cancelled: LaunchState.CANCELLED };
    const stepStates = { pending: LaunchStepState.PENDING, running: LaunchStepState.RUNNING, done: LaunchStepState.DONE, failed: LaunchStepState.FAILED };
    return create(LaunchRunSchema, {
      launchId: launch.id, changeId: launch.changeId, title: current?.content.title ?? "",
      kind: KIND_NUMBER[change.kind], version: current?.version ?? 0, state: states[launch.state],
      starts: { market: "IT", local: "2026-11-02T09:00", utc: "2026-11-02T08:00:00Z" },
      dueAt: launch.dueAt, startedAt: launch.startedAt, finishedAt: launch.finishedAt,
      currentStep: launch.state === "done" ? "" : launch.steps.find((step) => step.state !== "done")?.name ?? "",
      attempts: launch.steps.reduce((sum, step) => sum + step.attempts, 0), cause: launch.cause, retryAt: launch.retryAt,
      snapshotBefore: launch.snapshotBefore || "0", snapshotAfter: launch.snapshotAfter || "0", resolution: launch.resolution, run: `launch-${launch.id}`,
      steps: detail
        ? launch.steps.map((step) => ({
          name: step.name, purpose: LAUNCH_PURPOSES[step.name], state: stepStates[step.state], startedAt: step.startedAt,
          finishedAt: step.finishedAt, attempts: step.attempts, error: step.error, facts: step.facts,
        }))
        : [],
      auditEvents: detail ? launch.auditEvents : [],
      incidents: launch.incidents.map((incident) => ({
        incidentId: incident.id, kind: incident.kind, state: incident.state, summary: incident.summary, openedAt: incident.openedAt,
        closedAt: incident.closedAt, resolution: incident.resolution,
      })),
    });
  }

  /** A payment as the engine of stage 6 answers it, with its receipt once it succeeded. */
  #payment(stored: StoredPayment, currency: string): Payment {
    const planted = this.#options.sentinels;
    const state = { pending: PaymentState.PENDING, succeeded: PaymentState.SUCCEEDED, failed: PaymentState.FAILED }[stored.state];
    return create(PaymentSchema, {
      paymentId: planted ? SENTINEL.text : stored.id, state, amount: money(stored.amountMinor, currency), provider: "simulated",
      requestedAt: stored.requestedAt, settledAt: stored.settledAt, failureReason: planted ? SENTINEL.text : stored.failureReason,
      ...(stored.receipt
        ? {
          receipt: create(ReceiptSchema, {
            receiptId: stored.receipt.id, amount: money(stored.amountMinor, currency), issuedAt: stored.receipt.issuedAt, provider: "simulated",
            providerReference: stored.receipt.reference, demonstration: true, note: RECEIPT_NOTE,
          }),
        }
        : {}),
    });
  }

  /** A role check on a method with an outcome: a refusal, never an error (the engine's behaviour 6). */
  #mayNot(method: string, context: HandlerContext, kind: Kind | null): { outcome: { case: "refusal"; value: Refusal } } | null {
    const role = context.requestHeader.get("x-actor-role") ?? "";
    return MAY[method]?.(role, kind) ? null : this.#refuse(RefusalCode.ROLE_NOT_ALLOWED, `The ${role} role may not do this.`, { role });
  }

  // ----- the gRPC server -----

  #interceptor(): Interceptor {
    return (next) => async (request) => {
      const name = request.method.name;
      if (request.service.typeName === "grpc.health.v1.Health") return next(request);
      const header = (key: string) => request.header.get(key);
      const requestId = header("x-request-id");
      const echo = (headers: Headers) => {
        if (requestId !== null) headers.set("x-request-id", requestId);
      };
      this.calls.push({
        method: name, requestId, actor: header("x-actor"), role: header("x-actor-role"), idempotencyKey: header("idempotency-key"),
        authorization: header("authorization"), message: request.message,
      });
      try {
        if (header("authorization") !== `Bearer ${this.token}`) throw new ConnectError("missing or wrong internal token", Code.Unauthenticated);
        if (requestId === null || !SHAPE.test(requestId)) throw new ConnectError("x-request-id is missing or malformed", Code.InvalidArgument);
        const key = header("idempotency-key");
        if (IDEMPOTENT.has(name) && key === null) throw new ConnectError("idempotency-key is required", Code.InvalidArgument);
        if (key !== null && !SHAPE.test(key)) throw new ConnectError("idempotency-key is malformed", Code.InvalidArgument);
        const actor = header("x-actor");
        const role = header("x-actor-role");
        if (!PUBLIC.has(name) && (actor === null || role === null)) throw new ConnectError("this method needs an actor", Code.PermissionDenied);
        if (actor !== null || role !== null) {
          const person = actor === null ? undefined : this.people.get(actor);
          if (person === undefined || role === null || !person.roles.includes(role)) {
            throw new ConnectError("the actor is unknown or does not hold the declared role", Code.PermissionDenied);
          }
        }
        if (READS.has(name) && !MAY[name]?.(role ?? "", null)) throw new ConnectError(`the ${role} role may not read this`, Code.PermissionDenied);
        const fault = this.#faults.get(name);
        if (fault) {
          this.#faults.delete(name);
          throw new ConnectError(fault.message, fault.code);
        }
        const delay = this.#delays.get(name);
        if (delay !== undefined) {
          this.#delays.delete(name);
          // The wait ends when the caller gives up, so no timer outlives the test.
          await sleep(delay, undefined, { signal: request.signal }).catch(() => {});
        }
        if (key !== null && IDEMPOTENT.has(name)) {
          const fingerprint = hex(sha256(toBinary(request.method.input, request.message as never)));
          const kept = this.#idempotency.get(key);
          if (kept) {
            if (kept.method !== name || kept.actor !== (actor ?? "") || kept.role !== (role ?? "") || kept.fingerprint !== fingerprint) {
              throw new ConnectError("this idempotency-key was used for another request", Code.InvalidArgument);
            }
            this.replays += 1;
            // The stored answer, with its protocol headers, under this request's id.
            const replay = { ...kept.response, header: new Headers(kept.response.header), trailer: new Headers(kept.response.trailer) };
            echo(replay.header);
            echo(replay.trailer);
            return replay;
          }
          const response = await next(request);
          if (!response.stream) this.#idempotency.set(key, { method: name, actor: actor ?? "", role: role ?? "", fingerprint, response });
          echo(response.header);
          echo(response.trailer);
          return response;
        }
        const response = await next(request);
        echo(response.header);
        echo(response.trailer);
        return response;
      } catch (error) {
        const failure = ConnectError.from(error);
        echo(failure.metadata);
        throw failure;
      }
    };
  }

  #routes(router: ConnectRouter): void {
    router.service(Health, {
      check: () => ({ status: HealthCheckResponse_ServingStatus.SERVING }),
    });
    router.service(PeopleService, {
      listPeople: () => ({ people: [...this.people.keys()].map((id) => this.#person(id)) }),
    });
    router.service(CatalogService, {
      listMarkets: () => ({ markets: MARKETS.map((market) => this.#marketMessage(market)) }),
      listPlans: (request) => ({ plans: this.#plans(request.market) }),
      getPriceList: (request) => ({ entries: this.#priceList(request.market, request.plan) }),
      // The prepaid passes on sale now (§9); no market, or one that cannot be a code, is INVALID_ARGUMENT; an unknown one has none.
      listPrepaidPasses: (request) => {
        if (request.market === "") throw new ConnectError("name the market: IT, FR, DE or GB", Code.InvalidArgument);
        if (!/^[A-Z]{2}$/.test(request.market)) throw new ConnectError(`'${request.market}' is not a market code`, Code.InvalidArgument);
        if (!MARKETS.some((market) => market.code === request.market)) return { passes: [] };
        return { passes: this.#passesOnSale(request.market) };
      },
      listOffers: (request) => {
        this.#market(request.market);
        const planted = this.#options.sentinels;
        // An offer for an artist's listeners goes only to a listener in its audience, never to nobody (§6.8).
        const reaches = (offer: PublishedOffer) =>
          offer.listening === undefined || (this.offerRules.get(offer.offerId)?.listeners ?? []).includes(request.subscriberId);
        return {
          offers: this.published.filter((offer) => offer.market === request.market && reaches(offer)).map((offer) =>
            planted ? create(PublishedOfferSchema, { ...offer, version: 987_654 }) : offer),
        };
      },
    });
    router.service(QuoteService, {
      getQuote: (request) => {
        const market = this.#market(request.market);
        const list = PRICES[market.code]?.[request.plan];
        if (list === undefined) throw new ConnectError(`no paid plan ${request.plan}`, Code.NotFound);
        // With a listener, eligibility is checked now and again when they subscribe; without one, only then.
        const subscriber = request.subscriberId === "0" || request.subscriberId === "" ? null : request.subscriberId;
        const listener = subscriber === null ? null : this.listeners.get(subscriber);
        if (listener === undefined) throw new ConnectError(`no subscriber #${subscriber}`, Code.NotFound);
        if (listener !== null) {
          if (listener.market !== market.code) {
            return this.#refuse(RefusalCode.NOT_ELIGIBLE, `Subscriber #${listener.id} is in ${this.#market(listener.market).name}, and this quote is for ${market.name}.`, { market: listener.market });
          }
          if (request.plan === "student" && !this.#verifiedOn(listener, this.#today(market.code))) {
            return this.#refuse(RefusalCode.NOT_ELIGIBLE, "Student needs a valid student verification (§10).", { check: "student" });
          }
        }
        let price = list;
        let months = 0;
        if (request.offerId !== "0") {
          const offer = this.published.find((candidate) => candidate.offerId === request.offerId && candidate.market === market.code && candidate.plan === request.plan);
          if (offer === undefined) return this.#refuse(RefusalCode.QUOTE_EXPIRED, "This offer is no longer on sale.", { offer_id: request.offerId });
          if (listener !== null && !this.#inAudience(listener, offer.offerId)) {
            return this.#refuse(RefusalCode.NOT_ELIGIBLE, `Subscriber #${listener.id} is not among ${offer.audience.toLowerCase()}.`, { offer_id: offer.offerId, audience: offer.audience });
          }
          price = offer.price?.amountMinor ?? list;
          months = offer.monthsAtOfferPrice;
        }
        this.#quotes += 1;
        const quoteId = `q_${hex(sha256(`quote-${this.#quotes}`)).slice(0, 32)}`;
        const expires = new Date(this.#options.clock().getTime() + 15 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
        this.quotes.set(quoteId, {
          id: quoteId, market: market.code, plan: request.plan, priceMinor: price, listMinor: list, months,
          offerId: request.offerId === "0" ? null : request.offerId, subscriberId: subscriber, expiresAt: expires,
        });
        return {
          outcome: {
            case: "quote" as const,
            value: create(QuoteSchema, {
              quoteId, plan: request.plan, market: market.code, price: money(price, market.currency),
              listPrice: money(list, market.currency), monthsAtPrice: months, thenPrice: money(list, market.currency), expiresAt: expires,
              offerId: request.offerId, breakdown: this.#quoteBreakdown(price, market),
            }),
          },
        };
      },
    });
    router.service(SubscriberService, {
      listDemoListeners: () => ({
        listeners: [...this.listeners.values()].map((listener) => {
          const today = this.#today(listener.market);
          return create(DemoListenerSchema, {
            subscriberId: listener.id, market: listener.market, title: listener.title, label: listener.label,
            plan: this.#current(listener, today)?.plan ?? "", studentVerified: this.#verifiedOn(listener, today),
          });
        }),
      }),
      // A verification still valid comes back as it is, and nothing is written.
      verifyStudent: (request, context) => {
        const listener = this.#listener(request.subscriberId);
        const today = this.#today(listener.market);
        const latest = this.#latestVerification(listener, today);
        if (latest?.valid) return { outcome: { case: "verification" as const, value: latest } };
        const reference = `sim-student-${hex(sha256(`${listener.id}/${today}`)).slice(0, 24)}`;
        if (!listener.student) {
          return this.#refuse(RefusalCode.NOT_ELIGIBLE, "The simulated provider found no student record for this listener.", { provider: "simulated" });
        }
        const verification = { verifiedOn: today, validUntil: addMonths(today, 12), provider: "simulated", reference };
        listener.verifications.push(verification);
        this.#log(context, "student.verified", `subscriber:${listener.id}`, "", { subscriber: listener.id, ...verification }, {
          actor: `subscriber-${listener.id}`, role: "subscriber",
        });
        return { outcome: { case: "verification" as const, value: create(StudentVerificationSchema, { ...verification, valid: true }) } };
      },
      // The engine's order of checks (commerce/engine/subscribers.py), each at the moment of confirming.
      confirmQuote: (request, context) => {
        const listener = this.#listener(request.subscriberId);
        if (!/^q_[0-9a-f]{32}$/.test(request.quoteId)) throw new ConnectError("quote_id is the identifier GetQuote returned", Code.InvalidArgument);
        const quote = this.quotes.get(request.quoteId);
        if (quote === undefined || (quote.subscriberId !== null && quote.subscriberId !== listener.id)) {
          throw new ConnectError(`no quote ${request.quoteId} for this listener`, Code.NotFound);
        }
        const now = this.#options.clock();
        const market = this.#market(quote.market);
        const today = this.#today(market.code);
        if (now.getTime() >= Date.parse(quote.expiresAt)) {
          return this.#refuse(RefusalCode.QUOTE_EXPIRED, `The quote expired at ${quote.expiresAt}: ask for a new one.`, { expired_at: quote.expiresAt });
        }
        const current = this.#current(listener, today);
        if (current === undefined) throw new ConnectError(`subscriber #${listener.id} is on no plan on ${today}`, Code.FailedPrecondition);
        if (current.paid) {
          const plan = PLANS.find((candidate) => candidate.id === current.plan)?.name ?? current.plan;
          return this.#refuse(RefusalCode.ALREADY_SUBSCRIBED, `A ${plan} subscription is already running for this listener.`, { plan: current.plan });
        }
        const offer = quote.offerId === null ? undefined : this.published.find((candidate) => candidate.offerId === quote.offerId && candidate.market === market.code);
        if (quote.offerId !== null && offer === undefined) {
          return this.#refuse(RefusalCode.QUOTE_EXPIRED, `Offer #${quote.offerId} is no longer on sale in ${market.name}.`, { offer_id: quote.offerId });
        }
        if (listener.market !== market.code) {
          return this.#refuse(RefusalCode.NOT_ELIGIBLE, `This listener is in ${this.#market(listener.market).name}, and the quote is for ${market.name}.`, { market: listener.market });
        }
        if (quote.plan === "student" && !this.#verifiedOn(listener, today)) {
          return this.#refuse(RefusalCode.NOT_ELIGIBLE, "Student needs a valid student verification (§10).", { check: "student" });
        }
        if (offer !== undefined) {
          const rules = this.offerRules.get(offer.offerId) ?? { neverPaid: false, group: "", cap: 0 };
          if (!this.#inAudience(listener, offer.offerId)) {
            return this.#refuse(RefusalCode.NOT_ELIGIBLE, `The offer is for ${offer.audience.toLowerCase()}.`, { offer_id: offer.offerId, audience: offer.audience });
          }
          const taken = listener.subscriptions.find((subscription) => subscription.offerId !== null && this.offerRules.get(subscription.offerId)?.group === rules.group);
          if (taken !== undefined) {
            const title = this.published.find((candidate) => candidate.offerId === taken.offerId)?.title ?? `offer #${taken.offerId}`;
            return this.#refuse(RefusalCode.NOT_COMBINABLE, `This listener already took ${title}, of the same group ${rules.group}: offers of a group never stack (§10.3).`, { group: rules.group, taken: title });
          }
          if (rules.cap > 0) {
            const redeemed = [...this.listeners.values()].flatMap((other) => other.subscriptions).filter((subscription) => subscription.offerId === offer.offerId).length;
            if (redeemed >= rules.cap) {
              return this.#refuse(RefusalCode.CAP_REACHED, `Offer #${offer.offerId} has had its ${rules.cap} redemptions.`, { offer_id: offer.offerId, cap: String(rules.cap) });
            }
          }
        }
        if (current.startedOn >= today) throw new ConnectError("the free plan started today and cannot end today: subscribe again tomorrow", Code.FailedPrecondition);
        const atConfirmation = this.#options.payments === "at-confirmation";
        if (atConfirmation) {
          const declined = this.#declineNext;
          this.#declineNext = null;
          if (declined !== null) return this.#refuse(RefusalCode.PAYMENT_DECLINED, declined, { provider: "simulated" });
        }
        current.endedOn = today;
        const stored: StoredSubscription = {
          id: String(this.#nextSubscription++), plan: quote.plan, paid: true, priceMinor: quote.priceMinor, startedOn: today, endedOn: null,
          billingDay: billingDayFor(today), quoteId: quote.id, offerId: quote.offerId, offerMonths: quote.months, payment: null,
        };
        listener.subscriptions.push(stored);
        const subscription = this.#subscription(listener, stored, today);
        const confirmed = {
          subscriber: listener.id, quote: quote.id, offer: quote.offerId, plan: quote.plan, market: market.code, price: quote.priceMinor,
          offer_months: quote.months, full_price_from: subscription.fullPriceFrom || null, from: current.plan,
        };
        const by = { actor: `subscriber-${listener.id}`, role: "subscriber" };
        if (atConfirmation) {
          // The engine of stage 5: the provider charged inside the confirmation, and the receipt came back with it.
          const reference = `sim-pay-${hex(sha256(quote.id)).slice(0, 24)}`;
          const receiptId = `r_${hex(sha256(`receipt-${stored.id}`)).slice(0, 32)}`;
          this.receipts.push({ id: receiptId, subscriptionId: stored.id, quoteId: quote.id, subscriberId: listener.id });
          this.#log(context, "subscription.confirmed", `subscription:${stored.id}`, "", { ...confirmed, receipt: receiptId, provider: "simulated", provider_reference: reference }, by);
          const receipt = create(ReceiptSchema, {
            receiptId, amount: money(quote.priceMinor, market.currency), issuedAt: this.#now(), provider: "simulated",
            providerReference: reference, demonstration: true, note: RECEIPT_NOTE,
          });
          return { outcome: { case: "confirmation" as const, value: { subscription, receipt } } };
        }
        // Stage 6: the payment is asked for after the confirmation commits, through the outbox, and comes back PENDING.
        stored.payment = {
          id: `pay_${hex(sha256(`payment-${stored.id}`)).slice(0, 32)}`, state: "pending", amountMinor: quote.priceMinor, requestedAt: this.#now(),
          settledAt: "", failureReason: "", receipt: null,
        };
        this.#log(context, "subscription.confirmed", `subscription:${stored.id}`, "", { ...confirmed, payment: stored.payment.id }, by);
        return { outcome: { case: "confirmation" as const, value: { subscription, payment: this.#payment(stored.payment, market.currency) } } };
      },
      getAccount: (request) => {
        const listener = this.#listener(request.subscriberId);
        const today = this.#today(listener.market);
        const current = this.#current(listener, today);
        if (current === undefined) throw new ConnectError(`subscriber #${listener.id} is on no plan on ${today}`, Code.FailedPrecondition);
        const verification = this.#latestVerification(listener, today);
        const currency = this.#market(listener.market).currency;
        return {
          account: create(AccountSchema, {
            subscriberId: this.#options.sentinels ? SENTINEL.changeId : listener.id, market: listener.market,
            subscription: this.#subscription(listener, current, today),
            ...(verification ? { studentVerification: verification } : {}),
            ...(current.payment ? { payment: this.#payment(current.payment, currency) } : {}),
            priceChanges: [...this.priceChanges.values()].filter((change) => change.subscriptionId === current.id).reverse()
              .map((change) => this.#priceChangeMessage(change)),
            prepaidCodes: [...this.prepaidCodes.values()].filter((code) => code.buyerId === listener.id).reverse()
              .map((code) => this.#codeMessage(code)),
          }),
        };
      },
      // §9: the listener, the pass (not found), on sale in the buyer's market (NOT_ELIGIBLE); then the code, its payment PENDING.
      buyPrepaidPass: (request, context) => {
        const listener = this.#listener(request.subscriberId);
        if (request.passId === "" || request.passId === "0") throw new ConnectError("pass_id names a prepaid pass", Code.InvalidArgument);
        const pass = this.changes.get(request.passId);
        if (pass === undefined || pass.kind !== "prepaid") throw new ConnectError(`no prepaid pass #${request.passId}`, Code.NotFound);
        const market = this.#market(listener.market);
        const onSale = this.#passesOnSale(market.code).find((candidate) => candidate.passId === pass.id);
        if (onSale === undefined) {
          const title = pass.versions.at(-1)?.content.title ?? "";
          return this.#refuse(RefusalCode.NOT_ELIGIBLE, `${title} is not on sale in ${market.name}.`, { pass_id: pass.id, market: market.code });
        }
        const content = pass.versions.at(-1)?.content;
        const id = String(this.#nextCode++);
        const digest = [...sha256(`prepaid-code-${id}`).subarray(0, 12)].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
        const soldOn = this.#today(market.code);
        const priceMinor = onSale.price.amountMinor;
        const code: StoredCode = {
          id, code: `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`, passId: pass.id, buyerId: listener.id,
          market: market.code, plan: onSale.plan, title: onSale.title, months: onSale.months, priceMinor, soldAt: this.#now(), soldOn,
          validUntil: addDays(addMonths(soldOn, content?.$typeName === "commerce.v1.PrepaidPassContent" ? content.codeValidMonths : 12), -1),
          payment: {
            id: `pay_${hex(sha256(`prepaid-payment-${id}`)).slice(0, 32)}`, state: "pending", amountMinor: priceMinor, requestedAt: this.#now(),
            settledAt: "", failureReason: "", receipt: null,
          },
          activatedBy: "", activatedOn: "", subscriptionId: "",
        };
        this.prepaidCodes.set(code.code, code);
        this.#log(context, "prepaid.sold", `prepaid:${id}`, "", { subscriber: listener.id, pass: pass.id, price: priceMinor, payment: code.payment.id }, {
          actor: `subscriber-${listener.id}`, role: "subscriber",
        });
        return { outcome: { case: "code" as const, value: this.#codeMessage(code) } };
      },
      // §9, the engine's order: the code's shape, the code (not found); a code used (the same listener's again: the same
      // answer); a code not ready or past its last day; then the market, the plan running, a free plan started today.
      activatePrepaidPass: (request, context) => {
        const listener = this.#listener(request.subscriberId);
        const typed = normalCode(request.code);
        if (!CODE_SHAPE.test(typed)) throw new ConnectError("a code is three groups of four letters and digits, like K7QM-3XTP-9WAD", Code.InvalidArgument);
        const code = this.prepaidCodes.get(typed);
        if (code === undefined) throw new ConnectError("no such code", Code.NotFound);
        const today = this.#today(listener.market);
        const current = this.#current(listener, today);
        if (code.activatedOn !== "") {
          if (code.activatedBy === listener.id && current?.prepaid?.code === code.code) {
            return { outcome: { case: "subscription" as const, value: this.#subscription(listener, current, today) } };
          }
          return this.#refuse(RefusalCode.WRONG_STATE, "This code was used already: a code works once.", { state: "activated" });
        }
        const state = this.#codeState(code);
        if (state !== "ready") {
          const why = { pending: "Its payment is not settled yet: try again in a moment.", failed: "Its payment was declined: this code never works." }[state as "pending" | "failed"]
            ?? `It could be activated until ${code.validUntil}.`;
          return this.#refuse(RefusalCode.WRONG_STATE, why, { state });
        }
        if (code.market !== listener.market) {
          return this.#refuse(RefusalCode.NOT_ELIGIBLE, `This code is for ${this.#market(code.market).name}, and this listener is in ${this.#market(listener.market).name}.`, {
            subscriber: listener.id, market: listener.market,
          });
        }
        if (current === undefined) throw new ConnectError(`subscriber #${listener.id} is on no plan on ${today}`, Code.FailedPrecondition);
        if (current.paid) {
          return this.#refuse(RefusalCode.ALREADY_SUBSCRIBED, `A ${current.plan} subscription is already running for this listener: activate the code when it ends.`, { plan: current.plan });
        }
        if (current.startedOn >= today) throw new ConnectError("the free plan started today and cannot end today: activate the code tomorrow", Code.FailedPrecondition);
        current.endedOn = today;
        // Its months end as a subscription's charges fall: on the billing day, 28 at the latest (domain/billing.py).
        const billingDay = billingDayFor(today);
        const endsOn = billingDate(today, billingDay, code.months);
        const stored: StoredSubscription = {
          id: String(this.#nextSubscription++), plan: code.plan, paid: true, priceMinor: 0n, startedOn: today, endedOn: endsOn,
          billingDay, quoteId: null, offerId: null, offerMonths: 0, payment: null, prepaid: { code: code.code, priceMinor: code.priceMinor },
        };
        listener.subscriptions.push(stored, {
          id: String(this.#nextSubscription++), plan: "free", paid: false, priceMinor: 0n, startedOn: endsOn, endedOn: null,
          billingDay: 0, quoteId: null, offerId: null, offerMonths: 0,
        });
        code.activatedBy = listener.id;
        code.activatedOn = today;
        code.subscriptionId = stored.id;
        this.#log(context, "prepaid.activated", `prepaid:${code.id}`, "", { subscriber: listener.id, plan: code.plan, months: code.months, ends: endsOn }, {
          actor: `subscriber-${listener.id}`, role: "subscriber",
        });
        return { outcome: { case: "subscription" as const, value: this.#subscription(listener, stored, today) } };
      },
      // The engine's order: the listener, the price change (theirs, or not found), the window, then the answer (§8).
      answerPriceChange: (request, context) => {
        const listener = this.#listener(request.subscriberId);
        if (request.priceChangeId === "" || request.priceChangeId === "0") throw new ConnectError("price_change_id names a price change of the listener", Code.InvalidArgument);
        const change = this.priceChanges.get(request.priceChangeId);
        if (change === undefined || change.listenerId !== listener.id) throw new ConnectError(`no price change #${request.priceChangeId} for this listener`, Code.NotFound);
        const said = (answer: boolean) => (answer ? "yes" : "no");
        const before = this.#priceChangeView(change).state;
        // An answer given stays: the same one comes back the same, at any time; another is refused.
        if (change.answer !== null) {
          if (change.answer === request.accept) return { outcome: { case: "priceChange" as const, value: this.#priceChangeMessage(change) } };
          return this.#refuse(RefusalCode.WRONG_STATE, "This price change was answered already, and the answer stays.", { state: before, answer: said(change.answer) });
        }
        const windowEnds = `${change.windowEndsDay}T23:59`;
        const timeZone = this.#market(change.market).timeZone;
        if (this.#options.clock().getTime() >= Date.parse(utcOf(windowEnds, timeZone))) {
          return this.#refuse(RefusalCode.WRONG_STATE, `The time to answer ended on ${describeLocal(windowEnds, timeZone)}.`, { state: before });
        }
        change.answer = request.accept;
        change.answeredOn = this.#today(change.market);
        const after = this.#priceChangeView(change);
        this.#log(context, "price_change.answered", `subscription:${change.subscriptionId}`, "", {
          subscriber: listener.id, price_change: change.id, change: change.changeId, kind: change.kind, answer: said(request.accept), from: before, to: after.state,
          ...(after.newPriceFrom ? { new_price_from: after.newPriceFrom } : {}), ...(after.leavesOn ? { leaves_on: after.leavesOn } : {}),
        }, { actor: `subscriber-${listener.id}`, role: "subscriber" });
        return { outcome: { case: "priceChange" as const, value: this.#priceChangeMessage(change) } };
      },
    });
    router.service(ChangeService, {
      createChange: (request, context) => {
        const kinds: Record<string, Kind> = { offer: "offer", listPrice: "listPrice", priceMigration: "priceMigration", prepaid: "prepaid" };
        const kind: Kind = kinds[request.content.case ?? ""] ?? "offer";
        const refused = this.#mayNot("CreateChange", context, kind);
        if (refused) return refused;
        if (request.content.case === undefined || !Object.hasOwn(kinds, request.content.case)) {
          throw new ConnectError("a change needs its content", Code.InvalidArgument);
        }
        const id = String(this.#nextId++);
        const author = context.requestHeader.get("x-actor") ?? "";
        const now = this.#now();
        const { content, hash } = contentOf(request.content);
        const stored: StoredChange = {
          id, kind, state: ChangeState.DRAFT, stateReason: "", createdBy: author, createdAt: now, updatedAt: now,
          versions: [{ version: 1, author, createdAt: now, content, hash }], approvals: [], validation: undefined, required: [], authorReason: "",
        };
        stored.required = this.#required(stored);
        this.changes.set(id, stored);
        this.#log(context, "change.created", `change:${id}`);
        return this.#answer(stored);
      },
      saveVersion: (request, context) => {
        const stored = this.#stored(request.changeId);
        const refused = this.#mayNot("SaveVersion", context, stored.kind);
        if (refused) return refused;
        const current = stored.versions.at(-1)?.version ?? 0;
        if (request.baseVersion !== current) {
          return this.#refuse(RefusalCode.STALE_VERSION, `Version ${current} is newer than the one you started from.`, { newer_version: String(current) });
        }
        if (![ChangeState.DRAFT, ChangeState.VALIDATED, ChangeState.IN_APPROVAL, ChangeState.APPROVED].includes(stored.state)) {
          return this.#refuse(RefusalCode.WRONG_STATE, "This change takes no new versions.");
        }
        if (request.content.case === undefined) throw new ConnectError("a version needs its content", Code.InvalidArgument);
        const { content, hash } = contentOf(request.content);
        stored.versions.push({ version: current + 1, author: context.requestHeader.get("x-actor") ?? "", createdAt: this.#now(), content, hash });
        stored.state = ChangeState.DRAFT;
        stored.validation = undefined;
        stored.required = this.#required(stored);
        this.#log(context, "change.version_saved", `change:${stored.id}`);
        return this.#answer(stored);
      },
      getChange: (request) => ({ change: this.#change(this.#stored(request.changeId)) }),
      batchGetChanges: (request) => ({
        changes: request.changeIds.flatMap((id) => {
          const stored = this.changes.get(id);
          return stored ? [this.#change(stored)] : [];
        }),
      }),
      listChanges: (request) => {
        const size = request.page?.size || 20;
        const after = request.page?.after ? Number(request.page.after) : Number.POSITIVE_INFINITY;
        const matching = [...this.changes.values()]
          .filter((stored) => Number(stored.id) < after)
          .filter((stored) => request.states.length === 0 || request.states.includes(stored.state))
          .filter((stored) => request.kind === 0 || request.kind === KIND_NUMBER[stored.kind])
          .sort((a, b) => Number(b.id) - Number(a.id));
        const page = matching.slice(0, size);
        return { changes: page.map((stored) => this.#summary(stored)), page: { next: matching.length > size ? (page.at(-1)?.id ?? "") : "" } };
      },
      validateChange: (request, context) => {
        const stored = this.#stored(request.changeId);
        const refused = this.#mayNot("ValidateChange", context, stored.kind);
        if (refused) return refused;
        const current = stored.versions.at(-1);
        if (request.version !== current?.version) {
          return this.#refuse(RefusalCode.STALE_VERSION, "That is not the current version.", { newer_version: String(current?.version ?? 0) });
        }
        if (stored.state !== ChangeState.DRAFT) return this.#refuse(RefusalCode.WRONG_STATE, "Only a draft is validated.");
        const content = current.content;
        const findings: Array<{ check: string; market: string; message: string; facts: Record<string, string> }> = [];
        if (content.$typeName === "commerce.v1.OfferContent") {
          for (const price of content.prices.filter((candidate) => !content.pages.some((page) => page.market === candidate.market))) {
            findings.push({ check: "page_text", market: price.market, message: `No page text for ${price.market}.`, facts: { market: price.market } });
          }
        } else if (content.$typeName === "commerce.v1.PriceMigrationContent") {
          findings.push(...this.#migrationFindings(stored, content));
        }
        stored.validation = create(ValidationReportSchema, {
          version: current.version,
          valid: findings.length === 0,
          eligible: content.$typeName === "commerce.v1.PriceMigrationContent" ? BigInt(this.#paidOf(content.plan, content.market).length) : 10_000n,
          findings: findings.map((finding) => ({ ...finding, severity: Severity.BLOCKING })),
        });
        if (findings.length) {
          return this.#refuse(RefusalCode.INVALID, "Validation found blocking problems.", {
            blocking: String(findings.length), checks: [...new Set(findings.map((finding) => finding.check))].join(","),
          });
        }
        stored.state = ChangeState.VALIDATED;
        this.#log(context, "change.validated", `change:${stored.id}`);
        return this.#answer(stored);
      },
      submitChange: (request, context) => {
        const stored = this.#stored(request.changeId);
        const refused = this.#mayNot("SubmitChange", context, stored.kind);
        if (refused) return refused;
        if (request.version !== stored.versions.at(-1)?.version) return this.#refuse(RefusalCode.STALE_VERSION, "That is not the current version.");
        if (stored.state !== ChangeState.VALIDATED) return this.#refuse(RefusalCode.WRONG_STATE, "Only a validated change is submitted.");
        stored.state = ChangeState.IN_APPROVAL;
        stored.authorReason = request.authorReason;
        this.#log(context, "change.submitted", `change:${stored.id}`);
        return this.#answer(stored);
      },
      approveChange: (request, context) => {
        const stored = this.#stored(request.changeId);
        const refused = this.#mayNot("ApproveChange", context, stored.kind);
        if (refused) return refused;
        const actor = context.requestHeader.get("x-actor") ?? "";
        const role = context.requestHeader.get("x-actor-role") ?? "";
        const current = stored.versions.at(-1);
        if (stored.state !== ChangeState.IN_APPROVAL) return this.#refuse(RefusalCode.WRONG_STATE, "Only a change in approval is approved.");
        if (current === undefined || request.version !== current.version || hex(request.contentHash) !== hex(current.hash)) {
          return this.#refuse(RefusalCode.FINGERPRINT_MISMATCH, "You approved a version or fingerprint that is not the current one.", {
            current_version: String(current?.version ?? 0),
          });
        }
        if (actor === current.author) return this.#refuse(RefusalCode.OWN_VERSION, "The author of a version cannot approve it.", { author: actor });
        if (stored.approvals.some((approval) => approval.version === current.version && (approval.approver === actor || approval.role === ROLE_NUMBER[role]))) {
          return this.#refuse(RefusalCode.ALREADY_SIGNED, "This person or this role has already signed this version.");
        }
        const requirement = stored.required.find((required) => !required.signed
          && (required.role === ROLE_NUMBER[role] || (required.role === Role.COMMERCIAL_LEAD && role === "finance")));
        if (requirement === undefined) {
          return this.#refuse(RefusalCode.ROLE_NOT_ALLOWED, "This version needs another role's signature.", { needs: stored.required.map((r) => String(r.role)).join(",") });
        }
        requirement.signed = true;
        stored.approvals.push(create(ApprovalSchema, {
          version: current.version, approver: actor, role: ROLE_NUMBER[role] ?? Role.UNSPECIFIED, decidedAt: this.#now(), contentHash: current.hash,
        }));
        if (stored.required.every((required) => required.signed)) stored.state = ChangeState.APPROVED;
        this.#log(context, "change.approved", `change:${stored.id}`);
        return this.#answer(stored);
      },
      rejectChange: (request, context) => {
        const stored = this.#stored(request.changeId);
        const refused = this.#mayNot("RejectChange", context, stored.kind);
        if (refused) return refused;
        if (request.reason.trim() === "") return this.#refuse(RefusalCode.REASON_REQUIRED, "A rejection carries its reason.");
        if (stored.state !== ChangeState.IN_APPROVAL) return this.#refuse(RefusalCode.WRONG_STATE, "Only a change in approval is rejected.");
        stored.state = ChangeState.DRAFT;
        stored.stateReason = request.reason;
        this.#log(context, "change.rejected", `change:${stored.id}`, request.reason);
        return this.#answer(stored);
      },
      scheduleChange: (request, context) => {
        const stored = this.#stored(request.changeId);
        const refused = this.#mayNot("ScheduleChange", context, stored.kind);
        if (refused) return refused;
        if (stored.state !== ChangeState.APPROVED) return this.#refuse(RefusalCode.WRONG_STATE, "Only an approved change is scheduled.");
        stored.state = ChangeState.SCHEDULED;
        this.#log(context, "change.scheduled", `change:${stored.id}`);
        return this.#answer(stored);
      },
      cancelChange: (request, context) => {
        const stored = this.#stored(request.changeId);
        const refused = this.#mayNot("CancelChange", context, stored.kind);
        if (refused) return refused;
        if (request.reason.trim() === "") return this.#refuse(RefusalCode.REASON_REQUIRED, "A cancellation carries its reason.");
        if (stored.state !== ChangeState.SCHEDULED) return this.#refuse(RefusalCode.WRONG_STATE, "Only a scheduled change is cancelled.");
        stored.state = ChangeState.CANCELLED;
        stored.stateReason = request.reason;
        this.#log(context, "change.cancelled", `change:${stored.id}`, request.reason);
        return this.#answer(stored);
      },
      suspendChange: (request, context) => {
        const stored = this.#stored(request.changeId);
        const refused = this.#mayNot("SuspendChange", context, stored.kind);
        if (refused) return refused;
        if (request.reason.trim() === "") return this.#refuse(RefusalCode.REASON_REQUIRED, "A suspension carries its reason.");
        if (stored.state !== ChangeState.ACTIVE) return this.#refuse(RefusalCode.WRONG_STATE, "Only an active change is suspended.");
        stored.state = ChangeState.SUSPENDED;
        stored.stateReason = request.reason;
        this.#log(context, "change.suspended", `change:${stored.id}`, request.reason);
        return this.#answer(stored);
      },
    });
    router.service(SimulationService, {
      // §8.7: who pays what and from when, the revenue at risk at a declared acceptance, who moves to Free.
      simulateMigration: (request, context) => {
        const stored = this.#stored(request.changeId);
        const refused = this.#mayNot("SimulateMigration", context, stored.kind);
        if (refused) return refused;
        const version = request.version === 0 ? stored.versions.at(-1) : stored.versions.find((candidate) => candidate.version === request.version);
        if (version === undefined) throw new ConnectError(`change ${stored.id} has no version ${request.version}`, Code.NotFound);
        const content = version.content;
        if (content.$typeName !== "commerce.v1.PriceMigrationContent") {
          throw new ConnectError(`change #${stored.id} is not a price migration${stored.kind === "offer" ? "; a campaign has SimulateOffer" : ""}`, Code.InvalidArgument);
        }
        const market = this.#market(content.market);
        const policy = POLICIES[content.market];
        const overridden = new Map(request.overrides.map((override) => [override.name, override.value]));
        for (const name of overridden.keys()) {
          if (!["existing", "acceptance"].includes(name)) throw new ConnectError(`'${name}' is not an assumption; they are existing, acceptance`, Code.InvalidArgument);
        }
        // Counted in the data, or typed; the book's illustrative 90% (§16), or typed.
        const existing = overridden.get("existing") ?? BigInt(this.#paidOf(content.plan, content.market).length);
        const acceptance = overridden.get("acceptance") ?? 9_000n;
        const typedBy = `typed by ${ROLE_WORDS[context.requestHeader.get("x-actor-role") ?? ""] ?? "someone"} at ${this.#now()}`;
        const keep = policy?.afterWindow === "keep_old_price";
        const before = breakdownOf(PRICES[content.market]?.[content.plan] ?? 0n, market);
        const after = breakdownOf(content.amount?.amountMinor ?? 0n, market);
        const minor = (value: Money | undefined) => value?.amountMinor ?? 0n;
        const step = (breakdown: typeof before) => ({
          price: breakdown.price, net: breakdown.net, artists: breakdown.artists, paymentCosts: breakdown.paymentCosts,
          contribution: money(minor(breakdown.net) - minor(breakdown.artists) - minor(breakdown.paymentCosts), market.currency),
        });
        const [b, a] = [step(before), step(after)];
        const accepting = (existing * acceptance + 5_000n) / 10_000n;
        const notAccepting = existing - accepting;
        // The acceptance at which the new price makes up for those who leave, rounded half up (domain/migration.py).
        const breakEven = (part: bigint, whole: bigint) => (keep || whole <= 0n ? -1 : Math.min(10_000, Math.max(0, Number(halfUp(part * 10_000n, whole)))));
        const windowEndsDay = addDays(content.noticesLocal.slice(0, 10), policy?.windowDays ?? 0);
        const at = (local: string) => ({ market: content.market, local, utc: utcOf(local, market.timeZone) });
        return {
          outcome: {
            case: "result" as const,
            value: {
              before: b, after: a, newSubscribersFrom: at(content.startsLocal), noticesFrom: at(content.noticesLocal), windowEnds: at(`${windowEndsDay}T23:59`),
              existingFrom: policy?.legalRequirement === "consent"
                ? `from their first charge after they consent, and not before new subscribers pay it; they answer by ${describeLocal(`${windowEndsDay}T23:59`, market.timeZone)}`
                : `from their first charge after the ${policy?.windowDays ?? 0} days of notice, ending ${describeLocal(`${windowEndsDay}T23:59`, market.timeZone)}, unless they leave before it`,
              existing, accepting, notAccepting, movingToFree: keep ? 0n : notAccepting,
              monthlyRevenueChange: money(accepting * (minor(a.net) - minor(b.net)) - (keep ? 0n : notAccepting * minor(b.net)), market.currency),
              monthlyContributionChange: money(accepting * (minor(a.contribution) - minor(b.contribution)) - (keep ? 0n : notAccepting * minor(b.contribution)), market.currency),
              revenueAtRiskMonthly: money(keep ? 0n : notAccepting * minor(b.net), market.currency),
              breakEvenAcceptanceRevenueBp: breakEven(minor(b.net), minor(a.net)),
              breakEvenAcceptanceContributionBp: breakEven(minor(b.contribution), minor(a.contribution)),
              prepaidPassesUntouched: this.#untouchedPasses(content.plan, content.market),
              assumptions: [
                { name: "existing", value: existing, source: overridden.has("existing") ? typedBy : `counted in the data at ${this.#now()}` },
                { name: "acceptance", value: acceptance, source: overridden.has("acceptance") ? typedBy : "default: business book §16 (illustrative)" },
              ],
              // The five conditions of §7.3, each met or not: a migration sets a list price and asks for consent.
              financeConditions: [
                { number: 1, rule: "a list price is created or changed", met: true, detail: "This change sets a list price." },
                { number: 2, rule: "an offer price is below the floor", met: false, detail: "Every offer price is at or above its market's floor." },
                { number: 3, rule: "the discount and top-up cost is over the threshold", met: false, detail: "Nothing to simulate." },
                { number: 4, rule: "the simulated contribution is negative", met: false, detail: "Nothing to simulate." },
                { number: 5, rule: "a price migration asks existing subscribers to accept a higher price", met: true, detail: "Existing subscribers are asked to accept a higher price." },
              ],
            },
          },
        };
      },
      simulateOffer: (request, context) => {
        const stored = this.#stored(request.changeId);
        const refused = this.#mayNot("SimulateOffer", context, stored.kind);
        if (refused) return refused;
        if (stored.kind !== "offer") return this.#refuse(RefusalCode.INVALID, "Only an offer is simulated.");
        const eur = (amount: bigint) => money(amount, "EUR");
        // Business book §6.7, the worked example.
        const overridden = new Map(request.overrides.map((override) => [override.name, override.value]));
        return {
          outcome: {
            case: "result" as const,
            value: {
              eligible: overridden.get("eligible") ?? 10_000n, takers: 1_200n, stayers: 660n, cannibalized: 480n,
              withOffer: { revenue: eur(3_703_500n), artists: eur(2_862_000n), paymentCosts: eur(81_282n), contribution: eur(760_218n) },
              withoutOffer: { revenue: eur(2_736_000n), artists: eur(1_728_000n), paymentCosts: eur(60_031n), contribution: eur(947_969n) },
              difference: { revenue: eur(967_500n), artists: eur(1_134_000n), paymentCosts: eur(21_251n), contribution: eur(-187_751n) },
              discountCost: eur(331_200n), topUpCost: eur(550_800n),
              financeConditions: [{ number: 4, rule: "the simulated contribution is negative", met: true, detail: "−€1,877.51 over 12 months" }],
              breakEvenRetentionBp: overridden.has("retention") ? -1 : 7_300,
              assumptions: [
                { name: "eligible", value: overridden.get("eligible") ?? 10_000n, source: "counted in the data" },
                { name: "take_up", value: 1_200n, source: "business book default" },
                { name: "incremental", value: 6_000n, source: "business book default" },
                { name: "retention", value: overridden.get("retention") ?? 5_500n, source: overridden.has("retention") ? "typed by finance" : "business book default" },
                { name: "horizon_months", value: 12n, source: "business book default" },
              ],
              horizonMonths: 12,
            },
          },
        };
      },
    });
    router.service(OverviewService, {
      getOverview: (_request, context) => {
        const role = context.requestHeader.get("x-actor-role") ?? "";
        const revenue = ["finance", "commercial_lead"].includes(role);
        // §9.2, §12.2: the value of prepaid passes not yet earned is finance's alone.
        const prepaid = role === "finance" ? this.#prepaidValues() : null;
        const changes = [...this.changes.values()];
        return {
          waitingForApproval: changes.filter((stored) => stored.state === ChangeState.IN_APPROVAL).map((stored) => this.#summary(stored)),
          launchesNext7Days: changes.filter((stored) => stored.state === ChangeState.SCHEDULED).map((stored) => ({
            changeId: stored.id, title: stored.versions.at(-1)?.content.title ?? "", state: stored.state, atRisk: false, risk: "",
            starts: { market: "IT", local: "2026-11-02T09:00", utc: "2026-11-02T08:00:00Z" },
          })),
          incidentsToday: this.incidents.map((incident) => create(IncidentSchema, incident)),
          payingSubscribers: [{ market: "IT", plan: "student", count: 12_480n }, { market: "DE", plan: "family", count: 9_310n }],
          freeListeners: [{ market: "IT", plan: "free", count: 51_200n }],
          ...(revenue
            ? {
              monthlyRevenue: [{ market: "IT", revenue: money(152_340_00n, "EUR"), revenueEur: money(152_340_00n, "EUR") }],
              monthlyRevenueEur: money(152_340_00n, "EUR"),
              monthlyTopUps: money(1_872_00n, "EUR"),
            }
            : {}),
          exchangeRateNote: "1 EUR = 0.83728 GBP (ECB reference rate, 23 October 2026)",
          ...(prepaid
            ? { prepaid, prepaidUnearnedEur: money(prepaid.reduce((sum, row) => sum + (row.unearnedEur.amountMinor ?? 0n), 0n), "EUR") }
            : {}),
        };
      },
    });
    // The engine's LaunchService (commerce/engine/launches.py), its checks in their order.
    router.service(LaunchService, {
      listLaunches: (request) => {
        const after = request.page?.after ?? "";
        if (after !== "" && !/^\d{1,18}$/.test(after)) throw new ConnectError("page.after is not a cursor this engine gave", Code.InvalidArgument);
        if ((request.page?.size ?? 0) < 0) throw new ConnectError("page.size is a positive number", Code.InvalidArgument);
        const size = Math.min(request.page?.size || 50, 200);
        const state = request.state === LaunchState.UNSPECIFIED ? null : LaunchState[request.state]?.toLowerCase();
        const matching = [...this.launches.values()]
          .filter((launch) => state === null || launch.state === state)
          .filter((launch) => request.changeId === "0" || request.changeId === "" || launch.changeId === request.changeId)
          .filter((launch) => after === "" || Number(launch.id) < Number(after))
          .sort((a, b) => Number(b.id) - Number(a.id));
        const page = matching.slice(0, size);
        return { launches: page.map((launch) => this.#launchMessage(launch, false)), page: { next: matching.length > size ? (page.at(-1)?.id ?? "") : "" } };
      },
      getLaunch: (request) => {
        const launch = this.launches.get(request.launchId);
        if (launch === undefined) throw new ConnectError(`no launch #${request.launchId}`, Code.NotFound);
        return { launch: this.#launchMessage(launch, true) };
      },
      retryLaunch: (request, context) => {
        const launch = this.launches.get(request.launchId);
        if (launch === undefined) throw new ConnectError(`no launch #${request.launchId}`, Code.NotFound);
        const refused = this.#mayNot("RetryLaunch", context, null);
        if (refused) return refused;
        const reason = request.reason.trim();
        if (reason.length > 2_000) throw new ConnectError("a reason is at most 2000 characters", Code.InvalidArgument);
        const waiting = launch.state === "running" && launch.retryAt !== "";
        if (launch.state !== "failed" && launch.state !== "refused" && !waiting) {
          return this.#refuse(RefusalCode.WRONG_STATE, `launch-${launch.id} is ${launch.state}: only a failed, refused or waiting launch is retried.`, { state: launch.state });
        }
        const change = this.#stored(launch.changeId);
        const published = launch.steps.find((step) => step.name === "publish")?.state === "done";
        if (!published && change.state !== ChangeState.SCHEDULED) {
          return this.#refuse(RefusalCode.WRONG_STATE, `Change #${change.id} is no longer scheduled: its launch has nothing left to do.`, { state: launch.state });
        }
        const from = launch.state;
        const actor = context.requestHeader.get("x-actor") ?? "";
        launch.state = "running";
        launch.finishedAt = "";
        launch.retryAt = "";
        launch.resolution = `retried by ${actor} at ${this.#now()}${reason ? `: ${reason}` : ""}`;
        this.#log(context, "launch.retried", `launch:${launch.id}`, reason, { launch: launch.id, change: launch.changeId, from, to: "running" });
        launch.auditEvents.push(this.audit.at(-1)?.seq ?? "");
        return { outcome: { case: "launch" as const, value: this.#launchMessage(launch, true) } };
      },
      cancelLaunch: (request, context) => {
        const launch = this.launches.get(request.launchId);
        if (launch === undefined) throw new ConnectError(`no launch #${request.launchId}`, Code.NotFound);
        const refused = this.#mayNot("CancelLaunch", context, null);
        if (refused) return refused;
        const reason = request.reason.trim();
        if (reason === "") return this.#refuse(RefusalCode.REASON_REQUIRED, "Say why you cancel the launch: its change is cancelled with that reason (§7.1).");
        if (reason.length > 2_000) throw new ConnectError("a reason is at most 2000 characters", Code.InvalidArgument);
        if (launch.steps.find((step) => step.name === "publish")?.state === "done") {
          return this.#refuse(RefusalCode.WRONG_STATE, `launch-${launch.id} has published: change #${launch.changeId} is live, and SuspendChange takes it off the site.`, {
            state: launch.state, published: "yes",
          });
        }
        if (launch.state === "done" || launch.state === "cancelled") return this.#refuse(RefusalCode.WRONG_STATE, `launch-${launch.id} is ${launch.state}.`, { state: launch.state });
        const change = this.#stored(launch.changeId);
        if (change.state !== ChangeState.SCHEDULED) {
          return this.#refuse(RefusalCode.WRONG_STATE, `Change #${change.id} is not scheduled.`, { state: launch.state });
        }
        const actor = context.requestHeader.get("x-actor") ?? "";
        change.state = ChangeState.CANCELLED;
        change.stateReason = reason;
        this.#log(context, "change.cancelled", `change:${change.id}`, reason, { change: change.id, from: "scheduled", to: "cancelled", launch: launch.id });
        launch.state = "cancelled";
        launch.finishedAt = this.#now();
        launch.resolution = `cancelled by ${actor}: ${reason}`;
        for (const incident of launch.incidents) {
          if (incident.state !== "open") continue;
          incident.state = "resolved";
          incident.closedAt = this.#now();
          incident.resolution = launch.resolution;
        }
        launch.auditEvents.push(this.audit.at(-1)?.seq ?? "");
        this.#log(context, "launch.cancelled", `launch:${launch.id}`, reason, { launch: launch.id, change: change.id });
        launch.auditEvents.push(this.audit.at(-1)?.seq ?? "");
        return { outcome: { case: "launch" as const, value: this.#launchMessage(launch, true) } };
      },
    });
    router.service(AuditService, {
      listEvents: (request) => {
        const size = request.page?.size || 50;
        const after = request.page?.after ? BigInt(request.page.after) : null;
        const matching = [...this.audit].reverse()
          .filter((event) => after === null || BigInt(event.seq) < after)
          .filter((event) => (request.actor === "" || event.actor === request.actor) && (request.action === "" || event.action === request.action)
            && (request.subject === "" || event.subject === request.subject));
        const page = matching.slice(0, size);
        return { events: page, page: { next: matching.length > size ? (page.at(-1)?.seq ?? "") : "" } };
      },
      verifyChain: (request) => {
        const head = this.audit.at(-1);
        const anchor = request.anchor;
        if (anchor) {
          const found = this.audit.find((event) => event.seq === anchor.seq);
          if (found === undefined || hex(found.hash) !== hex(anchor.hash)) {
            return { ok: false, events: BigInt(this.audit.length), brokenAt: anchor.seq, why: "the chain does not lead to the exported head" };
          }
        }
        return { ok: true, events: BigInt(this.audit.length), ...(head ? { head: create(ChainHeadSchema, { seq: head.seq, hash: head.hash }) } : {}) };
      },
      exportHead: (_request, context) => {
        const refused = this.#mayNot("ExportHead", context, null);
        if (refused) return refused;
        this.#log(context, "audit.exported", "audit");
        const head = this.audit.at(-1);
        return { outcome: { case: "head" as const, value: create(ChainHeadSchema, { seq: head?.seq ?? "0", hash: head?.hash ?? new Uint8Array(32) }) } };
      },
    });
  }

  async start(): Promise<void> {
    const handler = connectNodeAdapter({ routes: (router) => this.#routes(router), interceptors: [this.#interceptor()] });
    const server = createServer(handler);
    server.on("session", (session) => {
      this.#open.add(session);
      session.once("close", () => this.#open.delete(session));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
  }

  /** Stops answering: the clients' HTTP/2 sessions are ended, and the port is free when this resolves. */
  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const session of this.#open) session.destroy();
    });
  }

  readonly #open = new Set<ServerHttp2Session>();
}
