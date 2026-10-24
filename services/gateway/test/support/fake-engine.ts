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
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext, type Interceptor, type UnaryResponse } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { AuditEventSchema, AuditService, ChainHeadSchema, type AuditEvent } from "contracts/commerce/v1/audit";
import {
  CatalogService, MarketSchema, PlanSchema, PriceBreakdownSchema, PriceListEntrySchema, PublishedOfferSchema, type Market, type Plan,
  type PriceListEntry, type PublishedOffer,
} from "contracts/commerce/v1/catalog";
import {
  type Approval, ApprovalSchema, type Change, ChangeKind, ChangeSchema, ChangeService, ChangeState, ChangeSummarySchema, ChangeVersionSchema,
  type ListPriceContent, ListPriceContentSchema, type OfferContent, OfferContentSchema, type RequiredSignature, RequiredSignatureSchema,
  Severity, ValidationReportSchema, type ValidationReport,
} from "contracts/commerce/v1/changes";
import { type Money, MoneySchema, type Refusal, RefusalCode, RefusalSchema, Role } from "contracts/commerce/v1/common";
import { OverviewService, PeopleService, PersonSchema, type Person } from "contracts/commerce/v1/overview";
import { QuoteSchema, QuoteService } from "contracts/commerce/v1/quotes";
import { SimulationService } from "contracts/commerce/v1/simulation";
import {
  AccountSchema, DemoListenerSchema, ReceiptSchema, StudentVerificationSchema, SubscriberService, type Subscription, SubscriptionSchema,
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
  "ListDemoListeners", "VerifyStudent", "ConfirmQuote", "GetAccount",
]);
const IDEMPOTENT = new Set([
  "CreateChange", "SaveVersion", "ValidateChange", "SubmitChange", "ApproveChange", "RejectChange", "ScheduleChange",
  "CancelChange", "SuspendChange", "GetQuote", "ExportHead", "VerifyStudent", "ConfirmQuote",
]);
/** Reads without an outcome: a role that may not call them gets PERMISSION_DENIED instead of a refusal. */
const READS = new Set(["GetChange", "BatchGetChanges", "ListChanges", "GetOverview", "ListEvents", "VerifyChain"]);

type Kind = "offer" | "listPrice";
/** The coordinator's table (§4 of the brief), transcribed here on its own. */
const MAY: Record<string, (role: string, kind: Kind | null) => boolean> = {
  CreateChange: (role, kind) => (kind === "offer" ? role === "marketing" : role === "commercial_lead"),
  SaveVersion: (role, kind) => (kind === "offer" ? role === "marketing" : role === "commercial_lead"),
  ValidateChange: (role, kind) => (kind === "offer" ? role === "marketing" : role === "commercial_lead"),
  SubmitChange: (role, kind) => (kind === "offer" ? role === "marketing" : role === "commercial_lead"),
  SimulateOffer: (role) => ["marketing", "commercial_lead", "finance"].includes(role),
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
  versions: Array<{ version: number; author: string; createdAt: string; content: OfferContent | ListPriceContent; hash: Uint8Array }>;
  approvals: Approval[];
  validation: ValidationReport | undefined;
  required: RequiredSignature[];
  authorReason: string;
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
export type OfferRules = { neverPaid: boolean; group: string; cap: number };

/** The demo's listeners by what they show, as the engine's generator labels them. */
export const LISTENERS = { verified: "5001", unverified: "5002", paidBefore: "5003", freeInFrance: "5004" } as const;

const RECEIPT_NOTE = "Demonstration receipt from a simulated payment provider: no payment was taken, no money moved, "
  + "and no subscription contract was made.";

/**
 * The engine's four demo listeners (its generator's DEMO_LISTENERS), with
 * their days fixed around the tests' 24 October 2026 instead of counted back
 * from the data's last day.
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
  readonly receipts: Array<{ id: string; subscriptionId: string; quoteId: string; subscriberId: string }> = [];
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
      audience: "Verified students who have never paid",
      needsStudentCheck: true,
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

  /** The simulated payment provider declines the next charge, with this reason (the engine's PaymentProvider may). */
  declineNextCharge(reason: string): void {
    this.#declineNext = reason;
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

  #breakdown(price: bigint, currency: string) {
    const planted = this.#options.sentinels;
    const amount = (value: bigint) => money(planted ? SENTINEL.amount : value, currency);
    return create(PriceBreakdownSchema, {
      price: money(price, currency), vat: amount(price / 6n), net: amount(price - price / 6n), artists: amount(300n),
      topUp: amount(0n), paymentCosts: amount(price / 50n), encoreKeeps: amount(price / 4n),
    });
  }

  #marketMessage(market: (typeof MARKETS)[number]): Market {
    const planted = this.#options.sentinels;
    return create(MarketSchema, {
      code: market.code, name: market.name, currency: market.currency, minorUnits: 2, timeZone: market.timeZone, vatBp: market.vatBp,
      artistsMinimum: money(planted ? SENTINEL.amount : market.minimum, market.currency),
      floor: money(planted ? SENTINEL.amount : market.floor, market.currency),
    });
  }

  #plans(code: string): Plan[] {
    const market = this.#market(code);
    return PLANS.map((plan) => {
      const price = PRICES[code]?.[plan.id];
      return create(PlanSchema, {
        id: plan.id, name: plan.name, paid: plan.paid,
        entitlements: { skipsPerHour: plan.skips, audio: plan.audio, offline: plan.offline, seats: plan.seats, needsStudentCheck: plan.student },
        ...(price === undefined ? {} : { listPrice: money(price, market.currency), breakdown: this.#breakdown(price, market.currency) }),
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
        entries.push(create(PriceListEntrySchema, {
          id: String(id), plan: planId, market: market.code, amount: money(price, market.currency),
          validFromLocal: "2026-01-01T00:00", validUntilLocal: "",
          changeId: planted ? SENTINEL.changeId : "0",
          belowFloor: planted ? true : price < market.floor,
          topUp: money(planted ? SENTINEL.amount : 0n, market.currency),
        }));
      }
    }
    return entries;
  }

  #change(stored: StoredChange): Change {
    const current = stored.versions.at(-1);
    return create(ChangeSchema, {
      id: stored.id,
      kind: stored.kind === "offer" ? ChangeKind.OFFER : ChangeKind.LIST_PRICE,
      title: current?.content.title ?? "",
      state: stored.state,
      stateReason: stored.stateReason,
      currentVersion: current?.version ?? 0,
      createdBy: stored.createdBy,
      createdAt: stored.createdAt,
      versions: stored.versions.map((version) => create(ChangeVersionSchema, {
        version: version.version, author: version.author, createdAt: version.createdAt, contentHash: version.hash,
        content: version.content.$typeName === "commerce.v1.OfferContent"
          ? { case: "offer", value: version.content }
          : { case: "listPrice", value: version.content },
      })),
      approvals: stored.approvals,
      ...(stored.validation ? { validation: stored.validation } : {}),
      requiredSignatures: stored.required,
      sentence: `${current?.content.title ?? ""}: a sentence the engine writes.`,
      authorReason: stored.authorReason,
    });
  }

  #summary(stored: StoredChange) {
    const change = this.#change(stored);
    const content = stored.versions.at(-1)?.content;
    const markets = content?.$typeName === "commerce.v1.OfferContent" ? content.prices.map((price) => price.market) : content ? [content.market] : [];
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
    return !this.offerRules.get(offerId)?.neverPaid || !listener.subscriptions.some((subscription) => subscription.paid);
  }

  /** A subscription as the engine answers it on a day: its price, its offer's months, its next charge (§4.3, §6.1). */
  #subscription(listener: StoredListener, stored: StoredSubscription, today: string): Subscription {
    const currency = this.#market(listener.market).currency;
    const message = create(SubscriptionSchema, {
      subscriptionId: this.#options.sentinels ? SENTINEL.changeId : stored.id, plan: stored.plan, market: listener.market, paid: stored.paid,
      price: money(stored.priceMinor, currency), startedOn: stored.startedOn, offerId: stored.offerId ?? "0",
    });
    if (!stored.paid) return message;
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
    return message;
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
      listOffers: (request) => {
        this.#market(request.market);
        const planted = this.#options.sentinels;
        return {
          offers: this.published.filter((offer) => offer.market === request.market).map((offer) =>
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
              offerId: request.offerId, breakdown: this.#breakdown(this.#options.sentinels ? SENTINEL.amount : price, market.currency),
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
        const declined = this.#declineNext;
        this.#declineNext = null;
        if (declined !== null) return this.#refuse(RefusalCode.PAYMENT_DECLINED, declined, { provider: "simulated" });
        const reference = `sim-pay-${hex(sha256(quote.id)).slice(0, 24)}`;
        current.endedOn = today;
        const stored: StoredSubscription = {
          id: String(this.#nextSubscription++), plan: quote.plan, paid: true, priceMinor: quote.priceMinor, startedOn: today, endedOn: null,
          billingDay: billingDayFor(today), quoteId: quote.id, offerId: quote.offerId, offerMonths: quote.months,
        };
        listener.subscriptions.push(stored);
        const receiptId = `r_${hex(sha256(`receipt-${stored.id}`)).slice(0, 32)}`;
        this.receipts.push({ id: receiptId, subscriptionId: stored.id, quoteId: quote.id, subscriberId: listener.id });
        const subscription = this.#subscription(listener, stored, today);
        this.#log(context, "subscription.confirmed", `subscription:${stored.id}`, "", {
          subscriber: listener.id, quote: quote.id, offer: quote.offerId, plan: quote.plan, market: market.code, price: quote.priceMinor,
          offer_months: quote.months, full_price_from: subscription.fullPriceFrom || null, from: current.plan, receipt: receiptId,
          provider: "simulated", provider_reference: reference,
        }, { actor: `subscriber-${listener.id}`, role: "subscriber" });
        return {
          outcome: {
            case: "confirmation" as const,
            value: {
              subscription,
              receipt: create(ReceiptSchema, {
                receiptId, amount: money(quote.priceMinor, market.currency), issuedAt: this.#now(), provider: "simulated",
                providerReference: reference, demonstration: true, note: RECEIPT_NOTE,
              }),
            },
          },
        };
      },
      getAccount: (request) => {
        const listener = this.#listener(request.subscriberId);
        const today = this.#today(listener.market);
        const current = this.#current(listener, today);
        if (current === undefined) throw new ConnectError(`subscriber #${listener.id} is on no plan on ${today}`, Code.FailedPrecondition);
        const verification = this.#latestVerification(listener, today);
        return {
          account: create(AccountSchema, {
            subscriberId: this.#options.sentinels ? SENTINEL.changeId : listener.id, market: listener.market,
            subscription: this.#subscription(listener, current, today),
            ...(verification ? { studentVerification: verification } : {}),
          }),
        };
      },
    });
    router.service(ChangeService, {
      createChange: (request, context) => {
        const kind: Kind = request.content.case === "listPrice" ? "listPrice" : "offer";
        const refused = this.#mayNot("CreateChange", context, kind);
        if (refused) return refused;
        if (request.content.case === undefined) throw new ConnectError("a change needs its content", Code.InvalidArgument);
        const id = String(this.#nextId++);
        const author = context.requestHeader.get("x-actor") ?? "";
        const now = this.#now();
        const content = request.content.value;
        const hash = sha256(request.content.case === "offer" ? toBinary(OfferContentSchema, request.content.value) : toBinary(ListPriceContentSchema, request.content.value));
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
        const content = request.content.value;
        const hash = sha256(request.content.case === "offer" ? toBinary(OfferContentSchema, request.content.value) : toBinary(ListPriceContentSchema, request.content.value));
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
          .filter((stored) => request.kind === 0 || (request.kind === ChangeKind.OFFER) === (stored.kind === "offer"))
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
        const missingPages = content.$typeName === "commerce.v1.OfferContent"
          ? content.prices.filter((price) => !content.pages.some((page) => page.market === price.market)).map((price) => price.market)
          : [];
        stored.validation = create(ValidationReportSchema, {
          version: current.version,
          valid: missingPages.length === 0,
          eligible: 10_000n,
          findings: missingPages.map((market) => ({ check: "page_text", severity: Severity.BLOCKING, market, message: `No page text for ${market}.`, facts: { market } })),
        });
        if (missingPages.length) {
          return this.#refuse(RefusalCode.INVALID, "Validation found blocking problems.", { blocking: String(missingPages.length), checks: "page_text" });
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
        const changes = [...this.changes.values()];
        return {
          waitingForApproval: changes.filter((stored) => stored.state === ChangeState.IN_APPROVAL).map((stored) => this.#summary(stored)),
          launchesNext7Days: changes.filter((stored) => stored.state === ChangeState.SCHEDULED).map((stored) => ({
            changeId: stored.id, title: stored.versions.at(-1)?.content.title ?? "", state: stored.state, atRisk: false, risk: "",
            starts: { market: "IT", local: "2026-11-02T09:00", utc: "2026-11-02T08:00:00Z" },
          })),
          incidentsToday: [],
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
        };
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
