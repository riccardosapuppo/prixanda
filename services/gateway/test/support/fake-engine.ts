// A fake commerce engine for the gateway's tests: every service of the gRPC
// contract, in memory, served over real gRPC (HTTP/2) on 127.0.0.1:4613.
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
import { Health, HealthCheckResponse_ServingStatus } from "contracts/grpc/health/v1/health";

export const FAKE_ENGINE_PORT = Number(process.env["FAKE_ENGINE_PORT"] ?? 4613);
export const FAKE_TOKEN = "fake-engine-token-for-the-gateway-tests";

const SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;
const PUBLIC = new Set(["ListPeople", "ListMarkets", "ListPlans", "GetPriceList", "ListOffers", "GetQuote"]);
const IDEMPOTENT = new Set([
  "CreateChange", "SaveVersion", "ValidateChange", "SubmitChange", "ApproveChange", "RejectChange", "ScheduleChange",
  "CancelChange", "SuspendChange", "GetQuote", "ExportHead",
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
  /** Idempotency keys and what they answered (the engine's behaviour 2). */
  readonly #idempotency = new Map<string, { method: string; actor: string; role: string; fingerprint: string; response: UnaryResponse }>();
  readonly #faults = new Map<string, { code: Code; message: string }>();
  readonly #delays = new Map<string, number>();
  readonly #options: FakeEngineOptions;
  #server: Http2Server | null = null;
  #nextId = 1;
  #quotes = 0;
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

  #log(context: HandlerContext, action: string, subject: string, reason = "", body: Record<string, unknown> = {}): void {
    const previous = this.audit.at(-1);
    const seq = BigInt(this.audit.length + 1);
    const prevHash = previous?.hash ?? new Uint8Array(32);
    const fields = {
      seq: String(seq), at: this.#now(), actor: context.requestHeader.get("x-actor") ?? "system",
      actorRole: context.requestHeader.get("x-actor-role") ?? "system", action, subject,
      requestId: context.requestHeader.get("x-request-id") ?? "", reason, bodyJson: JSON.stringify(body),
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
            const replay = { ...kept.response, header: new Headers(), trailer: new Headers() };
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
        let price = list;
        let months = 0;
        if (request.offerId !== "0") {
          const offer = this.published.find((candidate) => candidate.offerId === request.offerId && candidate.market === market.code && candidate.plan === request.plan);
          if (offer === undefined) return this.#refuse(RefusalCode.QUOTE_EXPIRED, "This offer is no longer on sale.", { offer_id: request.offerId });
          price = offer.price?.amountMinor ?? list;
          months = offer.monthsAtOfferPrice;
        }
        this.#quotes += 1;
        const expires = new Date(this.#options.clock().getTime() + 15 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
        return {
          outcome: {
            case: "quote" as const,
            value: create(QuoteSchema, {
              quoteId: `quote-${this.#quotes}`, plan: request.plan, market: market.code, price: money(price, market.currency),
              listPrice: money(list, market.currency), monthsAtPrice: months, thenPrice: money(list, market.currency), expiresAt: expires,
              offerId: request.offerId, breakdown: this.#breakdown(this.#options.sentinels ? SENTINEL.amount : price, market.currency),
            }),
          },
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
