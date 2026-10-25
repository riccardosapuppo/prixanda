// The kinds of change the console writes, and where each one lives: an offer
// is a campaign (§6), a price migration raises a plan's price in a market
// (§8), a prepaid pass sells months of a plan as a code (§9). Every link to a
// change goes through here, so that a migration in the approvals' queue opens
// as a migration, never as a campaign.
import type { IconName } from "design";
import type { Right } from "./permissions.ts";

export type ChangeKind = "OFFER" | "LIST_PRICE" | "ENTITLEMENT" | "PRICE_MIGRATION" | "PREPAID";

/** The section of the rail a kind belongs to. */
export type KindSection = "campaigns" | "price-migrations" | "passes" | "price-list";

type Kind = {
  /** "a campaign", inside a sentence. */
  readonly a: string;
  /** "Campaign", as a label. */
  readonly word: string;
  /** "Campaigns", the list. */
  readonly many: string;
  readonly icon: IconName;
  readonly section: KindSection;
  /** Where its pages live; null for a kind the console only reads. */
  readonly base: string | null;
  /** Who writes, edits, checks and submits it (§12). */
  readonly writes: Right | null;
  /** Who schedules its start, and who cancels a scheduled start (§12). */
  readonly schedules: Right | null;
  readonly cancels: Right | null;
};

export const KINDS: Readonly<Record<ChangeKind, Kind>> = {
  OFFER: {
    a: "a campaign", word: "Campaign", many: "Campaigns", icon: "megaphone", section: "campaigns", base: "/campaigns/",
    writes: "createOffer", schedules: "scheduleOffer", cancels: "cancelOffer",
  },
  PRICE_MIGRATION: {
    a: "a price migration", word: "Price migration", many: "Price migrations", icon: "arrow-up-right", section: "price-migrations", base: "/price-migrations/",
    writes: "createPriceMigration", schedules: "schedulePrice", cancels: "cancelPrice",
  },
  PREPAID: {
    a: "a prepaid pass", word: "Prepaid pass", many: "Prepaid passes", icon: "gift", section: "passes", base: "/passes/",
    writes: "createPrepaidPass", schedules: "schedulePrice", cancels: "cancelPrice",
  },
  LIST_PRICE: {
    a: "a list price", word: "List price", many: "Price list", icon: "tag", section: "price-list", base: null,
    writes: null, schedules: "schedulePrice", cancels: "cancelPrice",
  },
  ENTITLEMENT: {
    a: "a plan's entitlements", word: "Entitlements", many: "Plans", icon: "list-checks", section: "price-list", base: null,
    writes: null, schedules: null, cancels: null,
  },
};

/** A kind the gateway sends, as the console knows it; an unknown one reads as an offer's neighbour, the price list. */
export function kindOf(kind: string): Kind {
  return KINDS[kind as ChangeKind] ?? KINDS.LIST_PRICE;
}

/** The page where a change is written: a step of its guided form. Kinds the console does not write open on their approval page. */
export function editHref(kind: string, id: string, step?: number): string {
  const base = kindOf(kind).base;
  if (base === null) return approvalHref(kind, id);
  return `${base}edit/?id=${id}${step ? `&step=${step}` : ""}`;
}

/** The approval page, the same for every kind, under the kind's own section. */
export function approvalHref(kind: string, id: string): string {
  const base = kindOf(kind).base ?? "/campaigns/";
  return `${base}approval/?id=${id}`;
}

export function simulationHref(kind: string, id: string): string | null {
  if (kind === "OFFER") return `/campaigns/simulation/?id=${id}`;
  if (kind === "PRICE_MIGRATION") return `/price-migrations/simulation/?id=${id}`;
  return null;
}

/** Where a price migration's existing subscribers stand, once its requests went out. */
export function progressHref(id: string): string {
  return `/price-migrations/progress/?id=${id}`;
}

/** Where a row of a list leads: a draft to its form, anything else to its approval page. */
export function changeHref(row: { readonly id: string; readonly state: string; readonly kind: string }): string {
  return row.state === "DRAFT" || row.state === "VALIDATED" ? editHref(row.kind, row.id) : approvalHref(row.kind, row.id);
}
