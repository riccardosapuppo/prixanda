// What each role may do, as the console shows it (business book §12, §12.2).
//
// The server decides: the gateway applies the same matrix before calling the
// engine, the engine applies it again, and the database refuses an
// approval by the author. The console only uses it to hide or explain what
// a role cannot do, so nobody presses a button that can only be refused.
// test/permissions.test.ts compares this table with the gateway's matrix
// (services/gateway/src/core/roles.ts): when one changes, the test fails
// until the other is read again.

export const ROLES = ["MARKETING", "COMMERCIAL_LEAD", "FINANCE", "CATALOG_MANAGER", "ON_CALL", "AUDITOR"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_NAME: Readonly<Record<Role, string>> = {
  MARKETING: "Marketing",
  COMMERCIAL_LEAD: "Commercial lead",
  FINANCE: "Finance",
  CATALOG_MANAGER: "Catalog manager",
  ON_CALL: "On-call engineer",
  AUDITOR: "Auditor",
};

/** §12.1, word for word: what each role can and cannot do. */
export const ROLE_DUTIES: Readonly<Record<Role, { readonly can: string; readonly cannot: string }>> = {
  MARKETING: { can: "create and edit campaigns, run simulations, submit", cannot: "approve" },
  COMMERCIAL_LEAD: {
    can: "own the price list and commercial rules, create price changes, approve campaigns within the thresholds, read revenue",
    cannot: "approve own versions; sign for finance",
  },
  FINANCE: {
    can: "approve price changes and anything over a finance condition (§7.3); read revenue and unearned value",
    cannot: "approve own versions",
  },
  CATALOG_MANAGER: { can: "define plans and entitlements", cannot: "approve own versions; change prices" },
  ON_CALL: { can: "suspend an active change and roll back a launch", cannot: "create or approve anything" },
  AUDITOR: { can: "read and export the audit log", cannot: "change anything" },
};

/** Who may do what in the console. Reading changes, the home and the log is everyone's (§12.2). */
export const CAPABILITIES = {
  createOffer: ["MARKETING"],
  editOffer: ["MARKETING"],
  submitOffer: ["MARKETING"],
  createListPrice: ["COMMERCIAL_LEAD"],
  simulate: ["MARKETING", "COMMERCIAL_LEAD", "FINANCE"],
  approve: ["FINANCE", "COMMERCIAL_LEAD"],
  reject: ["FINANCE", "COMMERCIAL_LEAD"],
  scheduleOffer: ["COMMERCIAL_LEAD", "MARKETING"],
  cancelOffer: ["COMMERCIAL_LEAD", "ON_CALL", "MARKETING"],
  suspend: ["ON_CALL"],
  verifyChain: ["AUDITOR", "ON_CALL"],
  exportHead: ["AUDITOR"],
  readRevenue: ["FINANCE", "COMMERCIAL_LEAD"],
  readUnearnedValue: ["FINANCE"],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(roles: readonly Role[], capability: Capability): boolean {
  const allowed: readonly Role[] = CAPABILITIES[capability];
  return roles.some((role) => allowed.includes(role));
}

/** "finance and the commercial lead", "the auditor and the on-call engineer": the roles that may, for a sentence. */
export function whoCan(capability: Capability): string {
  const names = CAPABILITIES[capability].map((role) => (role === "MARKETING" || role === "FINANCE" ? ROLE_NAME[role] : `the ${ROLE_NAME[role].toLowerCase()}`));
  if (names.length === 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The first role of a person, for the sentences that name who they act as. */
export function primaryRole(roles: readonly Role[]): Role | null {
  return ROLES.find((role) => roles.includes(role)) ?? null;
}

export type Signature = { readonly role: Role; readonly conditions: readonly number[]; readonly why: string; readonly signed: boolean };
export type ApprovalView = {
  readonly state: string;
  readonly version: number;
  readonly authorId: string;
  readonly signatures: readonly Signature[];
  readonly approvals: readonly { readonly version: number; readonly approverId: string }[];
};

/** What the approval page offers a person, and why when it offers nothing. */
export type Decision =
  | { readonly kind: "sign"; readonly as: Role; readonly signature: Signature; readonly version: number }
  | { readonly kind: "not-in-approval"; readonly state: string }
  | { readonly kind: "author"; readonly version: number }
  | { readonly kind: "already-signed"; readonly version: number }
  | { readonly kind: "role-cannot-approve"; readonly needs: readonly Signature[] }
  | { readonly kind: "needs-another-role"; readonly needs: readonly Signature[] };

/**
 * A signature can be given by its role; one the book asks of the commercial
 * lead ("commercial lead or finance", §7.3) can be given by finance too.
 */
export function signsFor(roles: readonly Role[], signature: Signature): Role | null {
  if (signature.role === "FINANCE") return roles.includes("FINANCE") ? "FINANCE" : null;
  if (signature.role === "COMMERCIAL_LEAD") return roles.includes("FINANCE") ? "FINANCE" : roles.includes("COMMERCIAL_LEAD") ? "COMMERCIAL_LEAD" : null;
  return roles.includes(signature.role) ? signature.role : null;
}

export function decide(view: ApprovalView, viewer: { readonly personId: string; readonly roles: readonly Role[] }): Decision {
  if (view.state !== "IN_APPROVAL") return { kind: "not-in-approval", state: view.state };
  if (view.authorId === viewer.personId) return { kind: "author", version: view.version };
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

/** "conditions 2 and 4", "condition 1". */
export function conditionWords(conditions: readonly number[]): string {
  if (conditions.length === 0) return "";
  if (conditions.length === 1) return `condition ${conditions[0]}`;
  return `conditions ${conditions.slice(0, -1).join(", ")} and ${conditions.at(-1)}`;
}

/** "Finance (conditions 2 and 4)", "the commercial lead or finance". */
export function signatureWords(signature: Signature): string {
  if (signature.role === "COMMERCIAL_LEAD") return "the commercial lead or Finance";
  const who = signature.role === "FINANCE" ? "Finance" : ROLE_NAME[signature.role];
  return signature.conditions.length ? `${who} (${conditionWords(signature.conditions)})` : who;
}

/** The sentence the approval page shows when it offers no button. */
export function decisionSentence(decision: Decision, viewerRole: Role | null): string {
  const as = viewerRole === null ? "With this role" : `As ${ROLE_NAME[viewerRole]}`;
  switch (decision.kind) {
    case "sign":
      return `As ${ROLE_NAME[decision.as]} you can sign v${decision.version}: review it first.`;
    case "author":
      return `You wrote v${decision.version}. Someone else has to approve it.`;
    case "already-signed":
      return `You have signed v${decision.version}. One person gives one signature: the next one has to come from someone else.`;
    case "role-cannot-approve":
      return decision.needs.length
        ? `${as} you can't sign this one: it needs ${decision.needs.map(signatureWords).join(" and ")}.`
        : `${as} you can't approve changes.`;
    case "needs-another-role":
      return `${as} you can't sign this one: it needs ${decision.needs.map(signatureWords).join(" and ")}.`;
    case "not-in-approval":
      return "It is not waiting for approval.";
  }
}
