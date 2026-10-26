// The team, in one table (business book §12): each role as §12.1 writes it,
// what it may do in the console, what every role reads (§12.2), and who
// signs (§7.3). Every sentence the console says about who may do what is
// composed from this table: the menu and the entry show its rows, and the
// locks, the confirmations and the audit log's rule (§11.4) name the roles
// it gives. A rule changed here changes the words with it.
//
// The server decides: the gateway applies the same rights before calling the
// engine, the engine applies them again, and the database refuses an
// approval by the author. The console only uses the table to hide or explain
// what a role cannot do, so nobody presses a button that can only be
// refused. test/permissions.test.ts compares the rows with §12.1 of
// docs/business.md and the rights with the gateway's matrix
// (services/gateway/src/core/roles.ts): when one changes, the test fails
// until the other is read again.

export const ROLES = ["MARKETING", "COMMERCIAL_LEAD", "FINANCE", "CATALOG_MANAGER", "ON_CALL", "AUDITOR"] as const;
export type Role = (typeof ROLES)[number];

/** What a role may do beyond reading the changes, the home and the audit log, which every role does (§12.2). */
export type Right =
  | "createOffer"
  | "editOffer"
  | "submitOffer"
  | "createListPrice"
  | "createPriceMigration"
  | "createPrepaidPass"
  | "simulate"
  | "approve"
  | "reject"
  | "scheduleOffer"
  | "cancelOffer"
  | "schedulePrice"
  | "cancelPrice"
  | "suspend"
  | "retryLaunch"
  | "cancelLaunch"
  | "verifyChain"
  | "exportHead"
  | "readRevenue"
  | "readUnearnedValue"
  | "readArtists";

type Row = {
  /** As the menu writes it. */
  readonly name: string;
  /** As a sentence names it: "Finance", "the commercial lead". */
  readonly said: string;
  /** §12.1, word for word. */
  readonly can: string;
  readonly cannot: string;
};

export const TEAM = {
  roles: {
    MARKETING: { name: "Marketing", said: "Marketing", can: "create and edit campaigns, run simulations, submit", cannot: "approve" },
    COMMERCIAL_LEAD: {
      name: "Commercial lead",
      said: "the commercial lead",
      can: "own the price list and commercial rules, create price changes, approve campaigns within the thresholds, read revenue",
      cannot: "approve own versions; sign for finance",
    },
    FINANCE: {
      name: "Finance",
      said: "Finance",
      can: "approve price changes and anything over a finance condition (§7.3); read revenue and unearned value",
      cannot: "approve own versions",
    },
    CATALOG_MANAGER: { name: "Catalog manager", said: "the catalog manager", can: "define plans and entitlements", cannot: "approve own versions; change prices" },
    ON_CALL: {
      name: "On-call engineer",
      said: "the on-call engineer",
      can: "suspend an active change; retry or cancel a launch that stopped (roll back a launch)",
      cannot: "create or approve anything",
    },
    AUDITOR: { name: "Auditor", said: "the auditor", can: "read and export the audit log", cannot: "change anything" },
  },
  /** Who holds each right, in the order the book names them ("finance and the commercial lead", "the auditor and the on-call engineer"). */
  rights: {
    // Marketing creates, edits and submits campaigns; the commercial lead owns the price list (§12.1), and with it
    // the price changes for existing subscribers (§8) and the prepaid passes, which are prices too (§9). Who
    // creates a kind of change also edits, checks and submits it.
    createOffer: ["MARKETING"],
    editOffer: ["MARKETING"],
    submitOffer: ["MARKETING"],
    createListPrice: ["COMMERCIAL_LEAD"],
    createPriceMigration: ["COMMERCIAL_LEAD"],
    createPrepaidPass: ["COMMERCIAL_LEAD"],
    simulate: ["MARKETING", "COMMERCIAL_LEAD", "FINANCE"],
    // The roles that approve also send back; the engine decides which signature a version needs (§7.3, §7.4).
    approve: ["FINANCE", "COMMERCIAL_LEAD"],
    reject: ["FINANCE", "COMMERCIAL_LEAD"],
    // Finance approves but does not schedule: separation of duties. A price (a list price, a price migration, a
    // prepaid pass) is scheduled by the commercial lead alone.
    scheduleOffer: ["MARKETING", "COMMERCIAL_LEAD"],
    schedulePrice: ["COMMERCIAL_LEAD"],
    // Cancelling a scheduled start is part of the on-call engineer's "roll back a launch".
    cancelOffer: ["MARKETING", "COMMERCIAL_LEAD", "ON_CALL"],
    cancelPrice: ["COMMERCIAL_LEAD", "ON_CALL"],
    suspend: ["ON_CALL"],
    // §12.1: the on-call engineer retries or cancels a launch that stopped.
    retryLaunch: ["ON_CALL"],
    cancelLaunch: ["ON_CALL"],
    // §11.4: the auditor exports the log, and the auditor and the on-call engineer verify the chain.
    verifyChain: ["AUDITOR", "ON_CALL"],
    exportHead: ["AUDITOR"],
    // §12.2: revenue is read by finance and the commercial lead, unearned pass value by finance.
    readRevenue: ["FINANCE", "COMMERCIAL_LEAD"],
    readUnearnedValue: ["FINANCE"],
    // §14.2: the catalog's artists, for a campaign for an album release: whoever writes an offer and whoever signs one.
    readArtists: ["MARKETING", "COMMERCIAL_LEAD", "FINANCE"],
  },
  /** §12.2: what every role reads. */
  everyoneReads: "the changes, the home and the audit log",
  /** §7.3: who must sign when a finance condition is met, and who may approve otherwise. */
  signs: { condition: "FINANCE", otherwise: ["COMMERCIAL_LEAD", "FINANCE"] },
} as const satisfies {
  readonly roles: Readonly<Record<Role, Row>>;
  readonly rights: Readonly<Record<Right, readonly Role[]>>;
  readonly everyoneReads: string;
  readonly signs: { readonly condition: Role; readonly otherwise: readonly Role[] };
};

/** The role's name, as the menu writes it. */
export const ROLE_NAME: Readonly<Record<Role, string>> = Object.fromEntries(ROLES.map((role) => [role, TEAM.roles[role].name])) as Record<Role, string>;

export function can(roles: readonly Role[], right: Right): boolean {
  const holders: readonly Role[] = TEAM.rights[right];
  return roles.some((role) => holders.includes(role));
}

/** The roles that hold a right, in the order the book names them. */
export function whoMay(right: Right): readonly Role[] {
  return TEAM.rights[right];
}

/** The roles that hold one right and not another: Finance approves but does not schedule. */
export function holdsOnly(right: Right, without: Right): readonly Role[] {
  const others: readonly Role[] = TEAM.rights[without];
  return whoMay(right).filter((role) => !others.includes(role));
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Finance and the commercial lead", "Marketing or the commercial lead"; start: with a capital, to open a sentence. */
export function people(roles: readonly Role[], options: { readonly start?: boolean; readonly joiner?: "and" | "or" } = {}): string {
  const words = roles.map((role) => TEAM.roles[role].said);
  const text = words.length > 1 ? `${words.slice(0, -1).join(", ")} ${options.joiner ?? "and"} ${words.at(-1)}` : (words[0] ?? "");
  return options.start ? capital(text) : text;
}

/**
 * Who holds a right, with the verb agreeing: "Finance and the commercial lead
 * read revenue", "Marketing creates campaigns". either: any one of them
 * ("Marketing or the commercial lead schedules it").
 */
export function whoDoes(right: Right, verb: { readonly one: string; readonly many: string }, options: { readonly start?: boolean; readonly either?: boolean } = {}): string {
  const roles = whoMay(right);
  const one = roles.length === 1 || options.either === true;
  return `${people(roles, { start: options.start ?? true, joiner: options.either ? "or" : "and" })} ${one ? verb.one : verb.many}`;
}

/** "As Finance", or "With this role" when the person holds none of the team's roles; start: false inside a sentence. */
export function asRole(role: Role | null, options: { readonly start?: boolean } = {}): string {
  const words = role === null ? "with this role" : `as ${ROLE_NAME[role]}`;
  return options.start === false ? words : capital(words);
}

/** "Finance approves but does not schedule": the roles that approve and do not schedule a start (separation of duties); schedules: the right that schedules the kind of change at hand. */
export function approvesWithoutScheduling(options: { readonly start?: boolean; readonly schedules?: Right } = {}): string {
  const roles = holdsOnly("approve", options.schedules ?? "scheduleOffer");
  return `${people(roles, { start: options.start ?? true })} ${roles.length > 1 ? "approve but do not schedule" : "approves but does not schedule"}`;
}

/** What every role reads, for the person who reads nothing more here (§12.2). */
export function everyoneReadsWords(role: Role | null): string {
  return `${asRole(role)} you read what every role reads: ${TEAM.everyoneReads} (§12.2).`;
}

/** §11.4, word for word, with the roles from the rights: who reads, exports and verifies the log. */
export function logRule(platform: string): string {
  const exports = whoDoes("exportHead", { one: "exports it", many: "export it" }, { start: false });
  const verifies = whoDoes("verifyChain", { one: "verifies the chain", many: "verify the chain" }, { start: false });
  return `Everyone on the team reads the log, so any decision can be traced from any seat; ${exports}, and ${verifies}. Nobody can change it through ${platform}.`;
}

/** The first role of a person, for the sentences that name who they act as. */
export function primaryRole(roles: readonly Role[]): Role | null {
  return ROLES.find((role) => roles.includes(role)) ?? null;
}

/**
 * The demo's people as the console lists them: Marketing first, where the
 * guided path starts, then the other roles in the order of the team's table
 * (§12.1), two people of one role in the order of their ids. The engine
 * lists them by name; only the console's lists change.
 */
export function inTeamOrder<T extends { readonly id: string; readonly roles: readonly Role[] }>(people: readonly T[]): T[] {
  const rank = (person: T) => {
    const role = primaryRole(person.roles);
    return role === null ? ROLES.length : ROLES.indexOf(role);
  };
  return [...people].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export type Signature = { readonly role: Role; readonly conditions: readonly number[]; readonly why: string; readonly signed: boolean };
export type ApprovalView = {
  readonly state: string;
  readonly version: number;
  /** Who wrote each version: the engine refuses a review by the author of any of them (§7.4). */
  readonly versions: readonly { readonly version: number; readonly authorId: string }[];
  readonly signatures: readonly Signature[];
  readonly approvals: readonly { readonly version: number; readonly approverId: string }[];
};

/** What the approval page offers a person, and why when it offers nothing. */
export type Decision =
  | { readonly kind: "sign"; readonly as: Role; readonly signature: Signature; readonly version: number }
  | { readonly kind: "not-in-approval"; readonly state: string }
  | { readonly kind: "author"; readonly version: number; readonly wrote: readonly number[] }
  | { readonly kind: "already-signed"; readonly version: number }
  | { readonly kind: "role-cannot-approve"; readonly needs: readonly Signature[] }
  | { readonly kind: "needs-another-role"; readonly needs: readonly Signature[] };

/**
 * A signature can be given by its role; one the book asks of the commercial
 * lead ("the commercial lead or finance may approve", §7.3) can be given by
 * finance too. A person holding both signs in the first role of the approve
 * right, as the gateway does: finance.
 */
export function signsFor(roles: readonly Role[], signature: Signature): Role | null {
  const otherwise: readonly Role[] = TEAM.signs.otherwise;
  const allowed = signature.role === "COMMERCIAL_LEAD" ? whoMay("approve").filter((role) => otherwise.includes(role)) : [signature.role];
  return allowed.find((role) => roles.includes(role)) ?? null;
}

type Person = { readonly personId: string; readonly roles: readonly Role[] };

/** The versions of the change a person wrote. */
function wroteBy(view: ApprovalView, personId: string): number[] {
  return view.versions.filter((version) => version.authorId === personId).map((version) => version.version);
}

export function decide(view: ApprovalView, viewer: Person): Decision {
  if (view.state !== "IN_APPROVAL") return { kind: "not-in-approval", state: view.state };
  const wrote = wroteBy(view, viewer.personId);
  if (wrote.length > 0) return { kind: "author", version: view.version, wrote };
  if (view.approvals.some((approval) => approval.version === view.version && approval.approverId === viewer.personId)) {
    return { kind: "already-signed", version: view.version };
  }
  const missing = view.signatures.filter((signature) => !signature.signed);
  if (!can(viewer.roles, "approve")) return { kind: "role-cannot-approve", needs: missing };
  for (const signature of missing) {
    const as = signsFor(viewer.roles, signature);
    if (as !== null) return { kind: "sign", as, signature, version: view.version };
  }
  return { kind: "needs-another-role", needs: missing };
}

/**
 * Whether a person may send the version in approval back to its author, by
 * the engine's rules for it: a role that reviews (Finance or the commercial
 * lead), someone who wrote none of the change's versions, a change in
 * approval. Sending back is not signing: the commercial lead sends back an
 * offer that only Finance may sign.
 */
export function sendsBack(view: ApprovalView, viewer: Person): boolean {
  return view.state === "IN_APPROVAL" && can(viewer.roles, "reject") && wroteBy(view, viewer.personId).length === 0;
}

/** "v1", "v1 and v2". */
function versionWords(versions: readonly number[]): string {
  const named = versions.map((version) => `v${version}`);
  return named.length === 1 ? (named[0] ?? "") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

/** "conditions 2 and 4", "condition 1". */
export function conditionWords(conditions: readonly number[]): string {
  if (conditions.length === 0) return "";
  if (conditions.length === 1) return `condition ${conditions[0]}`;
  return `conditions ${conditions.slice(0, -1).join(", ")} and ${conditions.at(-1)}`;
}

/** Who signs when a finance condition is met (§7.3): "Finance". */
export function conditionSigner(options: { readonly start?: boolean } = {}): string {
  return people([TEAM.signs.condition], options);
}

/** Who approves when no finance condition is met (§7.3): "the commercial lead or Finance". */
export function otherwiseSigner(options: { readonly start?: boolean } = {}): string {
  return people(TEAM.signs.otherwise, { ...options, joiner: "or" });
}

/** Who may give a signature: a signature asked of the commercial lead is "the commercial lead or Finance" (§7.3). */
export function signerWords(signature: Signature, options: { readonly start?: boolean } = {}): string {
  return signature.role === "COMMERCIAL_LEAD" ? otherwiseSigner(options) : people([signature.role], options);
}

/** "Finance (conditions 2 and 4)", "the commercial lead or Finance". */
export function signatureWords(signature: Signature): string {
  const who = signerWords(signature);
  return signature.role !== "COMMERCIAL_LEAD" && signature.conditions.length ? `${who} (${conditionWords(signature.conditions)})` : who;
}

/** "Waiting for Finance", "Waiting for the commercial lead or Finance", or that every signature is there. */
export function waitingFor(signatures: readonly Signature[]): string {
  const missing = signatures.filter((signature) => !signature.signed);
  if (missing.length === 0) return "Signed: moving to approved";
  return `Waiting for ${missing.map((signature) => signerWords(signature)).join(" and ")}`;
}

/** The sentence the approval page shows when it offers no button. */
export function decisionSentence(decision: Decision, viewerRole: Role | null): string {
  switch (decision.kind) {
    case "sign":
      return `${asRole(decision.as)} you can sign v${decision.version}: review it first.`;
    case "author":
      return decision.wrote.includes(decision.version)
        ? `You wrote v${decision.version}. Someone else has to approve it.`
        : `You wrote ${versionWords(decision.wrote)} of this change. Someone else has to approve it.`;
    case "already-signed":
      return `You have signed v${decision.version}. One person gives one signature: the next one has to come from someone else.`;
    case "role-cannot-approve":
      return decision.needs.length
        ? `${asRole(viewerRole)} you can't sign this one: it needs ${decision.needs.map(signatureWords).join(" and ")}.`
        : `${asRole(viewerRole)} you can't approve changes.`;
    case "needs-another-role":
      return `${asRole(viewerRole)} you can't sign this one: it needs ${decision.needs.map(signatureWords).join(" and ")}.`;
    case "not-in-approval":
      return "It is not waiting for approval.";
  }
}
