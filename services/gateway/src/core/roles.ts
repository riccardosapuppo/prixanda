// Who may call what: the role matrix of the business book's §12, in one place.
//
// It is the matrix the coordinator fixed on 24 October for the engine and the
// gateway alike. The engine, the trusted layer, decides (§7.4); the gateway
// repeats the same matrix before it calls the engine, so that a role never
// reaches an operation it cannot do. test/roles.test.ts compares every entry
// with the rows of §12, quoted from docs/business.md: when the book changes,
// that test fails until this matrix is read again.

export const ROLES = ["marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor"] as const;

/** A role as the business book and the database write it, and as x-actor-role carries it. */
export type RoleName = (typeof ROLES)[number];

/** Who may call a method; the order is a precedence: a person holding two of them acts in the first. */
export type Allowed = readonly RoleName[];

/** The kinds of change the contract carries today; entitlements, migrations and passes come with stage 7. */
export const KINDS = ["offer", "listPrice"] as const;
export type Kind = (typeof KINDS)[number];

/** A method whose roles depend on the kind of change it acts on. */
export type ByKind = { readonly [K in Kind]: Allowed };

const ALL: Allowed = ROLES;

/**
 * The engine methods that act for nobody: the gateway sends them no x-actor
 * and no x-actor-role (the coordinator's convention 2).
 */
export const PUBLIC_METHODS = ["ListPeople", "ListMarkets", "ListPlans", "GetPriceList", "ListOffers", "GetQuote"] as const;

/** The other engine methods, and the roles that may call them. */
export const METHOD_ROLES = {
  // Marketing creates and edits campaigns; the commercial lead owns the price list.
  CreateChange: { offer: ["marketing"], listPrice: ["commercial_lead"] },
  SaveVersion: { offer: ["marketing"], listPrice: ["commercial_lead"] },
  // The role that may create that kind of change moves it on.
  ValidateChange: { offer: ["marketing"], listPrice: ["commercial_lead"] },
  SubmitChange: { offer: ["marketing"], listPrice: ["commercial_lead"] },
  SimulateOffer: ["marketing", "commercial_lead", "finance"],
  // Finance first: a person holding both signs as finance. The engine checks
  // which signatures the version needs and that its author does not sign.
  ApproveChange: ["finance", "commercial_lead"],
  RejectChange: ["finance", "commercial_lead"],
  // Finance approves but does not schedule the start: separation of duties.
  ScheduleChange: { offer: ["commercial_lead", "marketing"], listPrice: ["commercial_lead"] },
  // Cancelling a scheduled start is part of the on-call engineer's "roll back a launch".
  CancelChange: { offer: ["commercial_lead", "on_call", "marketing"], listPrice: ["commercial_lead", "on_call"] },
  SuspendChange: ["on_call"],
  // The log is read, never changed (§11.4).
  GetChange: ALL,
  BatchGetChanges: ALL,
  ListChanges: ALL,
  GetOverview: ALL,
  ListEvents: ALL,
  // The on-call engineer verifies the chain when the runbook says it does not add up.
  VerifyChain: ["auditor", "on_call"],
  ExportHead: ["auditor"],
} as const satisfies Record<string, Allowed | ByKind>;

export type MethodName = keyof typeof METHOD_ROLES;

/**
 * Fields of the console's API narrower than the operation that returns them:
 * finance and the commercial lead read revenue. The engine leaves these
 * fields empty for the other roles; the gateway answers FORBIDDEN on them.
 */
export const FIELD_ROLES = {
  "Overview.monthlyRevenue": ["finance", "commercial_lead"],
  "Overview.monthlyRevenueEur": ["finance", "commercial_lead"],
  "Overview.monthlyTopUps": ["finance", "commercial_lead"],
} as const satisfies Record<string, Allowed>;

/** Every role that may call the method, whatever the kind of change. */
export function anyKind(allowed: Allowed | ByKind): Allowed {
  if (isByKind(allowed)) {
    const roles: RoleName[] = [];
    for (const kind of KINDS) for (const role of allowed[kind]) if (!roles.includes(role)) roles.push(role);
    return roles;
  }
  return allowed;
}

export function isByKind(allowed: Allowed | ByKind): allowed is ByKind {
  return !Array.isArray(allowed);
}

/** The role a person acts in for something allowed to `allowed`, or null when they hold none of them. */
export function actingRole(held: readonly RoleName[], allowed: Allowed): RoleName | null {
  return allowed.find((role) => held.includes(role)) ?? null;
}
