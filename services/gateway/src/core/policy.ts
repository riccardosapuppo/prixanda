// Authorization of both APIs, on the server, for every operation.
//
// Authorized by default: guardInternalSchema() and guardPublicSchema() refuse
// to build a schema with a root field that has no entry here, so a new
// operation cannot ship without saying who may call it. The ones that need no
// session are listed as such. The console's roles come from the matrix in
// roles.ts, the same as the engine's.
//
// A person without a session gets UNAUTHENTICATED. A person whose roles may
// not do something gets the answer the engine would give: a ROLE_NOT_ALLOWED
// refusal where the operation answers with an outcome (mutations,
// simulateOffer), FORBIDDEN on reads (the engine's behaviour 6). On the site,
// what acts for a listener needs the site's session, and nothing else: it
// acts for that listener only.
import { create } from "@bufbuild/protobuf";
import { RefusalCode, RefusalSchema } from "contracts/commerce/v1/common";
import {
  defaultFieldResolver, getNamedType, type GraphQLFieldResolver, type GraphQLObjectType, type GraphQLSchema, isObjectType, isUnionType,
} from "graphql";
import type { InternalContext, Listener, PublicContext, Viewer } from "./context.ts";
import type { Actor } from "./engine.ts";
import { gatewayError } from "./errors.ts";
import type { RefusalModel } from "./models.ts";
import {
  actingRole, type Allowed, anyKind, type ByKind, FIELD_ROLES, isByKind, type Kind, METHOD_ROLES, type MethodName, ROLES,
} from "./roles.ts";

export type Access =
  | { readonly kind: "anyone" }
  | { readonly kind: "roles"; readonly roles: Allowed; readonly method: MethodName | null };

const ANYONE: Access = { kind: "anyone" };
/** Any signed-in role: what the console reads from the engine's public methods. */
const SIGNED_IN: Access = { kind: "roles", roles: ROLES, method: null };
const method = (name: MethodName, kind?: Kind): Access => {
  const allowed: Allowed | ByKind = METHOD_ROLES[name];
  return { kind: "roles", roles: kind && isByKind(allowed) ? allowed[kind] : anyKind(allowed), method: name };
};

/** Who may call each root field of the console's schema. */
export const INTERNAL_ACCESS: { readonly Query: Record<string, Access>; readonly Mutation: Record<string, Access> } = {
  Query: {
    people: ANYONE,
    session: ANYONE,
    overview: method("GetOverview"),
    markets: SIGNED_IN,
    plans: SIGNED_IN,
    priceList: SIGNED_IN,
    change: method("GetChange"),
    changes: method("ListChanges"),
    simulateOffer: method("SimulateOffer"),
    simulateMigration: method("SimulateMigration"),
    auditEvents: method("ListEvents"),
    verifyAuditChain: method("VerifyChain"),
    launches: method("ListLaunches"),
    launch: method("GetLaunch"),
    artists: method("ListArtists"),
  },
  Mutation: {
    signIn: ANYONE,
    signOut: ANYONE,
    createOffer: method("CreateChange", "offer"),
    createListPrice: method("CreateChange", "listPrice"),
    createPriceMigration: method("CreateChange", "priceMigration"),
    saveOfferVersion: method("SaveVersion", "offer"),
    saveListPriceVersion: method("SaveVersion", "listPrice"),
    savePriceMigrationVersion: method("SaveVersion", "priceMigration"),
    createPrepaidPass: method("CreateChange", "prepaid"),
    savePrepaidPassVersion: method("SaveVersion", "prepaid"),
    validateChange: method("ValidateChange"),
    submitChange: method("SubmitChange"),
    approveChange: method("ApproveChange"),
    rejectChange: method("RejectChange"),
    scheduleChange: method("ScheduleChange"),
    cancelChange: method("CancelChange"),
    suspendChange: method("SuspendChange"),
    exportAuditHead: method("ExportHead"),
    retryLaunch: method("RetryLaunch"),
    cancelLaunch: method("CancelLaunch"),
  },
};

export function viewerOf(context: InternalContext): Viewer | null {
  return context.sessions.current()?.viewer ?? null;
}

/** The actor for something allowed to `allowed`: the session's person in the first of those roles they hold. */
export function actorFor(context: InternalContext, allowed: Allowed): Actor {
  const viewer = viewerOf(context);
  if (viewer === null) throw gatewayError("UNAUTHENTICATED", "Sign in first: this needs a session.");
  const role = actingRole(viewer.roles, allowed);
  if (role === null) throw gatewayError("FORBIDDEN", "None of this session's roles may do this.");
  return { id: viewer.personId, role };
}

const KIND_OF: Record<number, Kind | undefined> = { 1: "offer", 2: "listPrice", 4: "priceMigration", 5: "prepaid" };

/**
 * The actor for a method whose roles depend on the change's kind. When the
 * person holds only one of the roles involved there is nothing to choose;
 * otherwise the change is loaded (through the request's loader) to act in the
 * role its kind asks for.
 */
export async function actorForChange(context: InternalContext, allowed: ByKind, changeId: string): Promise<Actor> {
  const viewer = viewerOf(context);
  if (viewer === null) throw gatewayError("UNAUTHENTICATED", "Sign in first: this needs a session.");
  const candidates = anyKind(allowed).filter((role) => viewer.roles.includes(role));
  const first = candidates[0];
  if (first === undefined) throw gatewayError("FORBIDDEN", "None of this session's roles may do this.");
  if (candidates.length === 1) return { id: viewer.personId, role: first };
  const change = await context.loaders.change.load(changeId);
  const kind = KIND_OF[change.kind];
  const role = kind ? actingRole(viewer.roles, allowed[kind]) : null;
  return { id: viewer.personId, role: role ?? first };
}

function roleNotAllowed(operation: string, changeId: string | null): RefusalModel {
  const refusal = create(RefusalSchema, {
    code: RefusalCode.ROLE_NOT_ALLOWED,
    reason: `None of this session's roles may ${operation} (business book §12).`,
    facts: { operation },
  });
  return { $typeName: "gateway.Refusal", refusal, changeId };
}

function answersWithRefusal(type: GraphQLObjectType, field: string): boolean {
  const returned = getNamedType(type.getFields()[field]?.type);
  return returned !== undefined && isUnionType(returned) && returned.getTypes().some((member) => member.name === "Refusal");
}

/**
 * Wraps every root field of the console's schema in its access check, and the
 * fields narrower than their operation in theirs. Throws when a root field has
 * no entry, or an entry names a field that does not exist.
 */
export function guardInternalSchema(schema: GraphQLSchema): void {
  for (const rootName of ["Query", "Mutation"] as const) {
    const root = schema.getType(rootName);
    if (!isObjectType(root)) throw new Error(`the console's schema has no ${rootName}`);
    const table = INTERNAL_ACCESS[rootName];
    const fields = root.getFields();
    const missing = Object.keys(fields).filter((name) => !Object.hasOwn(table, name));
    const stale = Object.keys(table).filter((name) => !Object.hasOwn(fields, name));
    if (missing.length) throw new Error(`no access rule for ${missing.map((name) => `${rootName}.${name}`).join(", ")} (policy.ts)`);
    if (stale.length) throw new Error(`access rules for fields that do not exist: ${stale.map((name) => `${rootName}.${name}`).join(", ")}`);
    for (const [name, field] of Object.entries(fields)) {
      const access = table[name];
      if (access === undefined || access.kind === "anyone") continue;
      const resolve: GraphQLFieldResolver<unknown, InternalContext> = field.resolve ?? defaultFieldResolver;
      const refuses = answersWithRefusal(root, name);
      field.resolve = (parent, args: Record<string, unknown>, context, info) => {
        const viewer = viewerOf(context);
        if (viewer === null) throw gatewayError("UNAUTHENTICATED", "Sign in first: this needs a session.");
        if (actingRole(viewer.roles, access.roles) === null) {
          if (refuses) return roleNotAllowed(name, typeof args["changeId"] === "string" ? args["changeId"] : null);
          throw gatewayError("FORBIDDEN", `None of this session's roles may read ${name} (business book §12).`);
        }
        return resolve(parent, args, context, info);
      };
    }
  }
  for (const [path, allowed] of Object.entries(FIELD_ROLES) as Array<[string, Allowed]>) {
    const [typeName = "", fieldName = ""] = path.split(".");
    const type = schema.getType(typeName);
    const field = isObjectType(type) ? type.getFields()[fieldName] : undefined;
    if (field === undefined) throw new Error(`FIELD_ROLES names ${path}, which the console's schema does not have`);
    const resolve: GraphQLFieldResolver<unknown, InternalContext> = field.resolve ?? defaultFieldResolver;
    field.resolve = (parent, args, context, info) => {
      const viewer = viewerOf(context);
      if (viewer === null || actingRole(viewer.roles, allowed) === null) {
        throw gatewayError("FORBIDDEN", `Only ${allowed.join(" and ")} may read ${path} (business book §12).`);
      }
      return resolve(parent, args, context, info);
    };
  }
}

/** Who may call a root field of the site's schema: any visitor, or the listener of the site's session. */
export type PublicAccess = "anyone" | "listener";

/** Who may call each root field of the site's schema. */
export const PUBLIC_ACCESS: { readonly Query: Record<string, PublicAccess>; readonly Mutation: Record<string, PublicAccess> } = {
  Query: {
    markets: "anyone",
    plans: "anyone",
    prices: "anyone",
    offers: "anyone",
    prepaidPasses: "anyone",
    demoListeners: "anyone",
    // Null without a session: asking who is signed in needs no session.
    me: "anyone",
  },
  Mutation: {
    // A visitor gets an anonymous quote, a listener their own (eligibility checked).
    requestQuote: "anyone",
    signInAsListener: "anyone",
    signOutListener: "anyone",
    verifyStudent: "listener",
    answerPriceChange: "listener",
    buyPrepaidPass: "listener",
    activatePrepaidPass: "listener",
    confirmSubscription: "listener",
  },
};

export function listenerOf(context: PublicContext): Listener | null {
  return context.sessions?.current()?.viewer ?? null;
}

/**
 * Wraps the site's root fields that act for a listener in the session check.
 * Throws when a root field has no entry, or an entry names a field that does
 * not exist. The engine's binding checks the session again (engine.ts).
 */
export function guardPublicSchema(schema: GraphQLSchema): void {
  for (const rootName of ["Query", "Mutation"] as const) {
    const root = schema.getType(rootName);
    if (!isObjectType(root)) throw new Error(`the site's schema has no ${rootName}`);
    const table = PUBLIC_ACCESS[rootName];
    const fields = root.getFields();
    const missing = Object.keys(fields).filter((name) => !Object.hasOwn(table, name));
    const stale = Object.keys(table).filter((name) => !Object.hasOwn(fields, name));
    if (missing.length) throw new Error(`no access rule for ${missing.map((name) => `${rootName}.${name}`).join(", ")} (policy.ts)`);
    if (stale.length) throw new Error(`access rules for fields that do not exist: ${stale.map((name) => `${rootName}.${name}`).join(", ")}`);
    for (const [name, field] of Object.entries(fields)) {
      if (table[name] !== "listener") continue;
      const resolve: GraphQLFieldResolver<unknown, PublicContext> = field.resolve ?? defaultFieldResolver;
      field.resolve = (parent, args, context, info) => {
        if (listenerOf(context) === null) throw gatewayError("UNAUTHENTICATED", "Choose a listener first: this needs the site's session.");
        return resolve(parent, args, context, info);
      };
    }
  }
}
