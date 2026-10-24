// The console's resolvers: every field of internal.graphql, written against
// the engine's messages (models.ts). Who may call each root field is decided
// before these run (policy.ts); the actor of each engine call comes from the
// session, never from an argument.
import { create } from "@bufbuild/protobuf";
import {
  ChangeKindSchema, ChangeStateSchema, type ListPriceContent, type OfferContent, SegmentSchema, SeveritySchema,
} from "contracts/commerce/v1/changes";
import { RefusalCodeSchema, RoleSchema } from "contracts/commerce/v1/common";
import { PersonSchema } from "contracts/commerce/v1/overview";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { OfferContentSchema, ListPriceContentSchema } from "contracts/commerce/v1/changes";
import type { InternalContext } from "../context.ts";
import {
  bytes, count, enumName, enumNumber, facts, graphqlRole, hex, idOrNull, money, optionalMoney, orNull, roleName,
} from "../convert.ts";
import { breach, contractBroken, gatewayError } from "../errors.ts";
import type {
  ActorRole, AssumptionName, AudioQuality, IncidentState, ListPriceInput, OfferInput, Resolvers, Role,
} from "../generated/internal.ts";
import { positiveId } from "../ids.ts";
import type { ChangeModel, RefusalModel } from "../models.ts";
import { actorFor, actorForChange } from "../policy.ts";
import { METHOD_ROLES, type RoleName } from "../roles.ts";
import {
  DateTimeScalar, LocalDateTimeScalar, MarketCodeScalar, MoneyScalar, PlanCodeScalar, Sha256Scalar,
} from "../scalars.ts";

/** The console's pages: 1 to 100 rows. */
export const MAX_PAGE = 100;

function changeId(value: string): string {
  const id = positiveId(value);
  if (id === null) throw gatewayError("BAD_USER_INPUT", `${JSON.stringify(value.slice(0, 40))} is not a change id`);
  return id;
}

function pageSize(first: number | undefined, fallback: number): number {
  const size = first ?? fallback;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) throw gatewayError("BAD_USER_INPUT", `first must be between 1 and ${MAX_PAGE}`);
  return size;
}

function version(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw gatewayError("BAD_USER_INPUT", `${name} must be a version number, 1 or more`);
  return value;
}

/** A cursor is the engine's and opaque; only its size is the gateway's business. */
function cursor(after: string | null | undefined): string {
  if (after === null || after === undefined) return "";
  if (after.length > 200) throw gatewayError("BAD_USER_INPUT", "after is not a cursor of this API");
  return after;
}

/** The engine's 0 means "no cap"; the schema's null says it, so a cap of 0 or less is refused rather than read as none. */
function redemptionCap(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (value < 1) throw gatewayError("BAD_USER_INPUT", "redemptionCap must be 1 or more; leave it null for no cap");
  return value;
}

function offerContent(input: OfferInput): MessageInitShape<typeof OfferContentSchema> {
  return {
    title: input.title,
    plan: input.plan,
    audience: {
      segment: enumNumber(SegmentSchema, input.audience.segment),
      currentPlan: input.audience.currentPlan ?? "",
      needsStudentCheck: input.audience.needsStudentCheck ?? false,
      ...(input.audience.listening ? { listening: { ...input.audience.listening } } : {}),
    },
    prices: input.prices.map((price) => {
      const fixed = price.fixed ?? null;
      const percent = price.percentOffBasisPoints ?? null;
      if ((fixed === null) === (percent === null)) {
        throw gatewayError("BAD_USER_INPUT", `the price for ${price.market} needs exactly one of fixed and percentOffBasisPoints`);
      }
      return {
        market: price.market,
        price: fixed !== null
          ? { case: "fixed" as const, value: { amountMinor: fixed.amountMinor, currency: fixed.currency } }
          : { case: "percentOffBp" as const, value: percent ?? 0 },
      };
    }),
    monthsAtOfferPrice: input.monthsAtOfferPrice,
    periods: input.periods.map((period) => ({ market: period.market, startsLocal: period.startsLocal, endsLocal: period.endsLocal ?? "" })),
    nonCombinabilityGroup: input.nonCombinabilityGroup,
    redemptionCap: redemptionCap(input.redemptionCap),
    pages: input.pages.map((page) => ({
      market: page.market, title: page.title, text: page.text, terms: page.terms, treatment: page.treatment ?? "standard",
    })),
  };
}

function listPriceContent(input: ListPriceInput): MessageInitShape<typeof ListPriceContentSchema> {
  return {
    title: input.title,
    plan: input.plan,
    market: input.market,
    amount: { amountMinor: input.amount.amountMinor, currency: input.amount.currency },
    startsLocal: input.startsLocal,
  };
}

type Outcome = { case: "change"; value: ChangeModel } | { case: "refusal"; value: RefusalModel["refusal"] } | { case: undefined; value?: undefined };

/**
 * A mutation's answer. The request's loader forgets what it knew about the
 * change, so a field read after the mutation (the refusal's change, say)
 * sees the engine's state now.
 */
function answer(outcome: Outcome, about: string | null, context: InternalContext): ChangeModel | RefusalModel {
  if (about !== null) context.loaders.change.clear(about);
  if (outcome.case === "change") {
    context.loaders.change.clear(outcome.value.id).prime(outcome.value.id, outcome.value);
    return outcome.value;
  }
  if (outcome.case === "refusal") return { $typeName: "gateway.Refusal", refusal:outcome.value, changeId: about };
  throw contractBroken("a mutation answered with neither a change nor a refusal");
}

async function person(context: InternalContext, id: string) {
  const found = (await context.loaders.people()).get(id);
  if (found === undefined) throw contractBroken(`person ${id} is not among the people the engine lists`);
  return found;
}

const roleOf = (role: number): Role => enumName<Role>(RoleSchema, role, "role");

const AUDIO: Record<string, AudioQuality> = { standard: "STANDARD", lossless: "LOSSLESS" };
const INCIDENT: Record<string, IncidentState> = { recovered: "RECOVERED", open: "OPEN" };
const ACTOR_ROLES: readonly ActorRole[] = ["MARKETING", "COMMERCIAL_LEAD", "FINANCE", "CATALOG_MANAGER", "ON_CALL", "AUDITOR", "SYSTEM"];
const ASSUMPTIONS: readonly AssumptionName[] = ["ELIGIBLE", "TAKE_UP", "INCREMENTAL", "RETENTION", "HORIZON_MONTHS"];

function lookup<T>(table: Readonly<Record<string, T>>, key: string, what: string): T {
  const found = Object.hasOwn(table, key) ? table[key] : undefined;
  if (found === undefined) throw contractBroken(`${what} ${JSON.stringify(key)}`);
  return found;
}

function oneOf<T extends string>(values: readonly T[], value: string, what: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw contractBroken(`${what} ${JSON.stringify(value)}`);
  return found;
}

export const internalResolvers: Resolvers = {
  Money: MoneyScalar,
  LocalDateTime: LocalDateTimeScalar,
  DateTime: DateTimeScalar,
  MarketCode: MarketCodeScalar,
  PlanCode: PlanCodeScalar,
  Sha256: Sha256Scalar,

  Query: {
    people: async (_root, _args, context) => [...(await context.loaders.people()).values()],
    session: (_root, _args, context) => context.sessions.current(),
    overview: async (_root, { at }, context) =>
      context.engine(actorFor(context, METHOD_ROLES.GetOverview)).overview.getOverview({ at: at ?? "" }),
    markets: async (_root, _args, context) => (await context.engine(null).catalog.listMarkets({})).markets,
    plans: async (_root, { market, at }, context) => (await context.engine(null).catalog.listPlans({ market, at: at ?? "" })).plans,
    priceList: async (_root, { market, plan }, context) =>
      (await context.engine(null).catalog.getPriceList({ market: market ?? "", plan: plan ?? "" })).entries,
    change: async (_root, { id }, context) => context.loaders.change.load(changeId(id)),
    changes: async (_root, { filter, first, after }, context) => {
      const answer = await context.engine(actorFor(context, METHOD_ROLES.ListChanges)).changes.listChanges({
        states: (filter?.states ?? []).map((state) => enumNumber(ChangeStateSchema, state)),
        kind: filter?.kind ? enumNumber(ChangeKindSchema, filter.kind) : 0,
        market: filter?.market ?? "",
        page: { size: pageSize(first, 20), after: cursor(after) },
      });
      return { nodes: answer.changes, next: orNull(answer.page?.next ?? "") };
    },
    simulateOffer: async (_root, { changeId: id, version: versionNumber, market, overrides }, context) => {
      const about = changeId(id);
      const answer = await context.engine(actorFor(context, METHOD_ROLES.SimulateOffer)).simulation.simulateOffer({
        changeId: about,
        version: version(versionNumber, "version"),
        market,
        overrides: (overrides ?? []).map((override) => ({ name: override.name.toLowerCase(), value: BigInt(override.value) })),
      });
      if (answer.outcome.case === "result") return answer.outcome.value;
      if (answer.outcome.case === "refusal") return { $typeName: "gateway.Refusal", refusal:answer.outcome.value, changeId: about };
      throw contractBroken("SimulateOffer answered with neither a result nor a refusal");
    },
    auditEvents: async (_root, { filter, first, after }, context) => {
      const answer = await context.engine(actorFor(context, METHOD_ROLES.ListEvents)).audit.listEvents({
        actor: filter?.actor ?? "",
        action: filter?.action ?? "",
        subject: filter?.subject ?? "",
        page: { size: pageSize(first, 50), after: cursor(after) },
      });
      return { nodes: answer.events, next: orNull(answer.page?.next ?? "") };
    },
    verifyAuditChain: async (_root, { anchor }, context) => {
      const seq = anchor ? positiveId(anchor.seq) : null;
      if (anchor && seq === null) throw gatewayError("BAD_USER_INPUT", "anchor.seq is not a sequence number");
      return context.engine(actorFor(context, METHOD_ROLES.VerifyChain)).audit.verifyChain(
        anchor && seq ? { anchor: { seq, hash: bytes(anchor.hash) } } : {},
      );
    },
  },

  Mutation: {
    // DEMONSTRATION MODE: the person comes from the engine's list, and their
    // roles with them; the browser chooses who to be, never what they hold.
    signIn: async (_root, { personId }, context) => {
      const found = (await context.loaders.people()).get(personId);
      if (found === undefined) throw gatewayError("BAD_USER_INPUT", "There is no person of the demo with that id.");
      const roles: RoleName[] = found.roles.map((role) => roleName(roleOf(role)));
      if (roles.length === 0) throw gatewayError("BAD_USER_INPUT", "That person of the demo holds no role.");
      return context.sessions.start({ personId: found.id, label: found.label, roles });
    },
    signOut: (_root, _args, context) => context.sessions.end(),
    createOffer: async (_root, { offer }, context) => {
      const engine = context.engine(actorFor(context, METHOD_ROLES.CreateChange.offer));
      const created = await engine.changes.createChange({ content: { case: "offer", value: offerContent(offer) } });
      return answer(created.outcome, null, context);
    },
    createListPrice: async (_root, { listPrice }, context) => {
      const engine = context.engine(actorFor(context, METHOD_ROLES.CreateChange.listPrice));
      const created = await engine.changes.createChange({ content: { case: "listPrice", value: listPriceContent(listPrice) } });
      return answer(created.outcome, null, context);
    },
    saveOfferVersion: async (_root, { changeId: id, baseVersion, offer }, context) => {
      const about = changeId(id);
      const engine = context.engine(actorFor(context, METHOD_ROLES.SaveVersion.offer));
      const saved = await engine.changes.saveVersion({
        changeId: about, baseVersion: version(baseVersion, "baseVersion"), content: { case: "offer", value: offerContent(offer) },
      });
      return answer(saved.outcome, about, context);
    },
    saveListPriceVersion: async (_root, { changeId: id, baseVersion, listPrice }, context) => {
      const about = changeId(id);
      const engine = context.engine(actorFor(context, METHOD_ROLES.SaveVersion.listPrice));
      const saved = await engine.changes.saveVersion({
        changeId: about, baseVersion: version(baseVersion, "baseVersion"), content: { case: "listPrice", value: listPriceContent(listPrice) },
      });
      return answer(saved.outcome, about, context);
    },
    validateChange: async (_root, { changeId: id, version: versionNumber }, context) => {
      const about = changeId(id);
      const engine = context.engine(await actorForChange(context, METHOD_ROLES.ValidateChange, about));
      const validated = await engine.changes.validateChange({ changeId: about, version: version(versionNumber, "version") });
      return answer(validated.outcome, about, context);
    },
    submitChange: async (_root, { changeId: id, version: versionNumber, authorReason }, context) => {
      const about = changeId(id);
      const engine = context.engine(await actorForChange(context, METHOD_ROLES.SubmitChange, about));
      const submitted = await engine.changes.submitChange({
        changeId: about, version: version(versionNumber, "version"), authorReason: authorReason ?? "",
      });
      return answer(submitted.outcome, about, context);
    },
    approveChange: async (_root, { changeId: id, version: versionNumber, fingerprint }, context) => {
      const about = changeId(id);
      const engine = context.engine(actorFor(context, METHOD_ROLES.ApproveChange));
      const approved = await engine.changes.approveChange({
        changeId: about, version: version(versionNumber, "version"), contentHash: bytes(fingerprint),
      });
      return answer(approved.outcome, about, context);
    },
    rejectChange: async (_root, { changeId: id, version: versionNumber, reason }, context) => {
      const about = changeId(id);
      const engine = context.engine(actorFor(context, METHOD_ROLES.RejectChange));
      const rejected = await engine.changes.rejectChange({ changeId: about, version: version(versionNumber, "version"), reason });
      return answer(rejected.outcome, about, context);
    },
    scheduleChange: async (_root, { changeId: id }, context) => {
      const about = changeId(id);
      const engine = context.engine(await actorForChange(context, METHOD_ROLES.ScheduleChange, about));
      return answer((await engine.changes.scheduleChange({ changeId: about })).outcome, about, context);
    },
    cancelChange: async (_root, { changeId: id, reason }, context) => {
      const about = changeId(id);
      const engine = context.engine(await actorForChange(context, METHOD_ROLES.CancelChange, about));
      return answer((await engine.changes.cancelChange({ changeId: about, reason })).outcome, about, context);
    },
    suspendChange: async (_root, { changeId: id, reason }, context) => {
      const about = changeId(id);
      const engine = context.engine(actorFor(context, METHOD_ROLES.SuspendChange));
      return answer((await engine.changes.suspendChange({ changeId: about, reason })).outcome, about, context);
    },
    exportAuditHead: async (_root, _args, context) => {
      const exported = await context.engine(actorFor(context, METHOD_ROLES.ExportHead)).audit.exportHead({});
      if (exported.outcome.case === "head") return exported.outcome.value;
      if (exported.outcome.case === "refusal") return { $typeName: "gateway.Refusal", refusal:exported.outcome.value, changeId: null };
      throw contractBroken("ExportHead answered with neither a head nor a refusal");
    },
  },

  Person: {
    id: (person) => person.id,
    label: (person) => person.label,
    roles: (person) => person.roles.map(roleOf),
  },
  Session: {
    mode: () => "DEMONSTRATION",
    person: (session) =>
      create(PersonSchema, { id: session.viewer.personId, label: session.viewer.label, roles: session.viewer.roles.map((role) => enumNumber(RoleSchema, graphqlRole(role))) }),
    roles: (session) => session.viewer.roles.map(graphqlRole),
    csrfToken: (session) => session.csrfToken,
    expiresAt: (session) => session.expiresAt.toISOString(),
  },
  Market: {
    code: (market) => market.code,
    name: (market) => market.name,
    currency: (market) => market.currency,
    minorUnits: (market) => market.minorUnits,
    timeZone: (market) => market.timeZone,
    vatBasisPoints: (market) => market.vatBp,
    artistsMinimum: (market) => money(market.artistsMinimum, `market ${market.code}'s artists' minimum`),
    floor: (market) => money(market.floor, `market ${market.code}'s floor`),
  },
  Entitlements: {
    skipsPerHour: (entitlements) => (entitlements.skipsPerHour === 0 ? null : entitlements.skipsPerHour),
    audio: (entitlements) => lookup(AUDIO, entitlements.audio, "audio quality"),
    offline: (entitlements) => entitlements.offline,
    seats: (entitlements) => entitlements.seats,
    needsStudentCheck: (entitlements) => entitlements.needsStudentCheck,
  },
  PriceBreakdown: {
    price: (breakdown) => money(breakdown.price, "breakdown price"),
    vat: (breakdown) => money(breakdown.vat, "breakdown VAT"),
    net: (breakdown) => money(breakdown.net, "breakdown net"),
    artists: (breakdown) => money(breakdown.artists, "breakdown artists"),
    topUp: (breakdown) => money(breakdown.topUp, "breakdown top-up"),
    paymentCosts: (breakdown) => money(breakdown.paymentCosts, "breakdown payment costs"),
    companyKeeps: (breakdown) => money(breakdown.encoreKeeps, "breakdown margin"),
  },
  Plan: {
    code: (plan) => plan.id,
    name: (plan) => plan.name,
    paid: (plan) => plan.paid,
    entitlements: (plan) => plan.entitlements ?? breach(`plan ${plan.id} has no entitlements`),
    listPrice: (plan) => optionalMoney(plan.listPrice),
    breakdown: (plan) => plan.breakdown ?? null,
  },
  PriceListEntry: {
    id: (entry) => entry.id,
    plan: (entry) => entry.plan,
    market: (entry) => entry.market,
    amount: (entry) => money(entry.amount, `price ${entry.id}`),
    validFrom: (entry) => entry.validFromLocal,
    validUntil: (entry) => orNull(entry.validUntilLocal),
    change: (entry, _args, context) => {
      const id = idOrNull(entry.changeId);
      return id === null ? null : context.loaders.change.load(id);
    },
    belowFloor: (entry) => entry.belowFloor,
    topUp: (entry) => money(entry.topUp, `price ${entry.id}'s top-up`),
  },
  ChangePage: {
    nodes: (page) => page.nodes,
    next: (page) => page.next,
  },
  ChangeSummary: {
    id: (summary) => summary.id,
    kind: (summary) => enumName(ChangeKindSchema, summary.kind, "change kind"),
    title: (summary) => summary.title,
    state: (summary) => enumName(ChangeStateSchema, summary.state, "change state"),
    currentVersion: (summary) => summary.currentVersion,
    createdBy: (summary, _args, context) => person(context, summary.createdBy),
    markets: (summary) => summary.markets,
    requiredSignatures: (summary) => summary.requiredSignatures,
    updatedAt: (summary) => summary.updatedAt,
    details: (summary, _args, context) => context.loaders.change.load(summary.id),
  },
  Change: {
    id: (change) => change.id,
    kind: (change) => enumName(ChangeKindSchema, change.kind, "change kind"),
    title: (change) => change.title,
    state: (change) => enumName(ChangeStateSchema, change.state, "change state"),
    stateReason: (change) => orNull(change.stateReason),
    currentVersion: (change) => change.currentVersion,
    createdBy: (change, _args, context) => person(context, change.createdBy),
    createdAt: (change) => change.createdAt,
    versions: (change) => change.versions,
    current: (change) =>
      change.versions.find((candidate) => candidate.version === change.currentVersion)
        ?? breach(`change ${change.id} came without its current version ${change.currentVersion}`),
    approvals: (change) => change.approvals,
    validation: (change) => change.validation ?? null,
    requiredSignatures: (change) => change.requiredSignatures,
    sentence: (change) => orNull(change.sentence),
    authorReason: (change) => orNull(change.authorReason),
  },
  ChangeVersion: {
    version: (changeVersion) => changeVersion.version,
    author: (changeVersion, _args, context) => person(context, changeVersion.author),
    createdAt: (changeVersion) => changeVersion.createdAt,
    fingerprint: (changeVersion) => hex(changeVersion.contentHash),
    content: (changeVersion) => changeVersion.content.value ?? breach(`version ${changeVersion.version} has no content`),
  },
  ChangeContent: {
    __resolveType: (content: OfferContent | ListPriceContent) =>
      content.$typeName === "commerce.v1.OfferContent" ? "OfferContent" : "ListPriceContent",
  },
  OfferContent: {
    title: (offer) => offer.title,
    plan: (offer) => offer.plan,
    audience: (offer) => offer.audience ?? breach("an offer came without its audience"),
    prices: (offer) => offer.prices,
    monthsAtOfferPrice: (offer) => offer.monthsAtOfferPrice,
    periods: (offer) => offer.periods,
    nonCombinabilityGroup: (offer) => offer.nonCombinabilityGroup,
    redemptionCap: (offer) => (offer.redemptionCap === 0 ? null : offer.redemptionCap),
    pages: (offer) => offer.pages,
  },
  ListPriceContent: {
    title: (content) => content.title,
    plan: (content) => content.plan,
    market: (content) => content.market,
    amount: (content) => money(content.amount, "a list price change"),
    startsLocal: (content) => content.startsLocal,
  },
  Audience: {
    segment: (audience) => enumName(SegmentSchema, audience.segment, "segment"),
    currentPlan: (audience) => orNull(audience.currentPlan),
    needsStudentCheck: (audience) => audience.needsStudentCheck,
    listening: (audience) => audience.listening ?? null,
  },
  ListeningRule: {
    artistId: (rule) => rule.artistId,
    minSeconds: (rule) => rule.minSeconds,
    withinDays: (rule) => rule.withinDays,
  },
  OfferPrice: {
    market: (price) => price.market,
    fixed: (price) => (price.price.case === "fixed" ? price.price.value : null),
    percentOffBasisPoints: (price) => (price.price.case === "percentOffBp" ? price.price.value : null),
  },
  OfferPeriod: {
    market: (period) => period.market,
    startsLocal: (period) => period.startsLocal,
    endsLocal: (period) => orNull(period.endsLocal),
  },
  OfferPage: {
    market: (page) => page.market,
    title: (page) => page.title,
    text: (page) => page.text,
    terms: (page) => page.terms,
    treatment: (page) => page.treatment,
  },
  Approval: {
    version: (approval) => approval.version,
    approver: (approval, _args, context) => person(context, approval.approver),
    role: (approval) => roleOf(approval.role),
    decidedAt: (approval) => approval.decidedAt,
    fingerprint: (approval) => hex(approval.contentHash),
  },
  RequiredSignature: {
    role: (signature) => roleOf(signature.role),
    conditions: (signature) => signature.conditions,
    why: (signature) => signature.why,
    signed: (signature) => signature.signed,
  },
  Fact: {
    name: (fact) => fact.name,
    value: (fact) => fact.value,
  },
  ValidationFinding: {
    check: (finding) => finding.check,
    severity: (finding) => enumName(SeveritySchema, finding.severity, "severity"),
    market: (finding) => orNull(finding.market),
    message: (finding) => finding.message,
    facts: (finding) => facts(finding.facts),
  },
  ValidationReport: {
    version: (report) => report.version,
    valid: (report) => report.valid,
    findings: (report) => report.findings,
    eligible: (report) => count(report.eligible, "eligible"),
  },
  Refusal: {
    code: (refusal) => enumName(RefusalCodeSchema, refusal.refusal.code, "refusal code"),
    reason: (refusal) => refusal.refusal.reason,
    facts: (refusal) => facts(refusal.refusal.facts),
    change: (refusal, _args, context) => (refusal.changeId === null ? null : context.loaders.change.load(refusal.changeId)),
  },
  ChangeResult: {
    __resolveType: (result) => (result.$typeName === "gateway.Refusal" ? "Refusal" : "Change"),
  },
  Overview: {
    waitingForApproval: (overview) => overview.waitingForApproval,
    launchesNext7Days: (overview) => overview.launchesNext7Days,
    incidentsToday: (overview) => overview.incidentsToday,
    payingSubscribers: (overview) => overview.payingSubscribers,
    freeListeners: (overview) => overview.freeListeners,
    monthlyRevenue: (overview) => overview.monthlyRevenue,
    monthlyRevenueEur: (overview) => optionalMoney(overview.monthlyRevenueEur),
    monthlyTopUps: (overview) => optionalMoney(overview.monthlyTopUps),
    exchangeRateNote: (overview) => overview.exchangeRateNote,
  },
  MarketTime: {
    market: (time) => time.market,
    local: (time) => time.local,
    utc: (time) => time.utc,
  },
  Launch: {
    change: (launch, _args, context) => context.loaders.change.load(launch.changeId),
    title: (launch) => launch.title,
    starts: (launch) => launch.starts ?? breach(`launch of change ${launch.changeId} has no start`),
    state: (launch) => enumName(ChangeStateSchema, launch.state, "change state"),
    atRisk: (launch) => launch.atRisk,
    risk: (launch) => orNull(launch.risk),
  },
  Incident: {
    change: (incident, _args, context) => context.loaders.change.load(incident.changeId),
    title: (incident) => incident.title,
    run: (incident) => incident.run,
    state: (incident) => lookup(INCIDENT, incident.state, "incident state"),
    summary: (incident) => incident.summary,
  },
  SubscriberCount: {
    market: (row) => row.market,
    plan: (row) => row.plan,
    count: (row) => count(row.count, "subscriber count"),
  },
  MarketRevenue: {
    market: (row) => row.market,
    revenue: (row) => money(row.revenue, `revenue in ${row.market}`),
    revenueEur: (row) => money(row.revenueEur, `revenue in ${row.market}, in euros`),
  },
  Assumption: {
    name: (assumption) => oneOf(ASSUMPTIONS, assumption.name.toUpperCase(), "assumption"),
    value: (assumption) => count(assumption.value, `assumption ${assumption.name}`),
    source: (assumption) => assumption.source,
  },
  Totals: {
    revenue: (totals) => money(totals.revenue, "total revenue"),
    artists: (totals) => money(totals.artists, "total owed to artists"),
    paymentCosts: (totals) => money(totals.paymentCosts, "total payment costs"),
    contribution: (totals) => money(totals.contribution, "total contribution"),
  },
  FinanceCondition: {
    number: (condition) => condition.number,
    rule: (condition) => condition.rule,
    met: (condition) => condition.met,
    detail: (condition) => condition.detail,
  },
  Simulation: {
    eligible: (result) => count(result.eligible, "eligible"),
    takers: (result) => count(result.takers, "takers"),
    stayers: (result) => count(result.stayers, "stayers"),
    cannibalized: (result) => count(result.cannibalized, "cannibalized"),
    withOffer: (result) => result.withOffer ?? breach("a simulation came without its totals with the offer"),
    withoutOffer: (result) => result.withoutOffer ?? breach("a simulation came without its totals without the offer"),
    difference: (result) => result.difference ?? breach("a simulation came without its difference"),
    discountCost: (result) => money(result.discountCost, "discount cost"),
    topUpCost: (result) => money(result.topUpCost, "top-up cost"),
    financeConditions: (result) => result.financeConditions,
    // -1 from the engine: no retention makes the contribution non-negative.
    breakEvenRetentionBasisPoints: (result) => (result.breakEvenRetentionBp < 0 ? null : result.breakEvenRetentionBp),
    assumptions: (result) => result.assumptions,
    horizonMonths: (result) => result.horizonMonths,
  },
  SimulationOutcome: {
    __resolveType: (outcome) => (outcome.$typeName === "gateway.Refusal" ? "Refusal" : "Simulation"),
  },
  AuditEvent: {
    seq: (event) => event.seq,
    at: (event) => event.at,
    actor: (event) => event.actor,
    actorRole: (event) => oneOf(ACTOR_ROLES, event.actorRole.toUpperCase(), "actor role"),
    action: (event) => event.action,
    subject: (event) => event.subject,
    requestId: (event) => event.requestId,
    reason: (event) => orNull(event.reason),
    body: (event) => event.bodyJson,
    previousHash: (event) => hex(event.prevHash),
    hash: (event) => hex(event.hash),
  },
  AuditPage: {
    nodes: (page) => page.nodes,
    next: (page) => page.next,
  },
  ChainHead: {
    seq: (head) => head.seq,
    hash: (head) => hex(head.hash),
  },
  ChainVerification: {
    ok: (verification) => verification.ok,
    events: (verification) => count(verification.events, "events"),
    head: (verification) => verification.head ?? null,
    brokenAt: (verification) => idOrNull(verification.brokenAt),
    why: (verification) => orNull(verification.why),
  },
  ExportHeadResult: {
    __resolveType: (result) => (result.$typeName === "gateway.Refusal" ? "Refusal" : "ChainHead"),
  },
};
