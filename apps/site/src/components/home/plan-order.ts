// The order the site lists plans in, and which plan an address asks for.
import type { SitePlansQuery } from "../../graphql/generated.ts";

export type Plan = SitePlansQuery["plans"][number];

/** The paid plans from the one most people take, then Free; a plan the site does not know goes last. */
export const PLAN_ORDER: readonly string[] = ["individual", "duo", "family", "student", "free"];
/** The plan open when the address names none. */
export const FIRST_PLAN = "individual";

const rank = (code: string) => {
  const at = PLAN_ORDER.indexOf(code);
  return at === -1 ? PLAN_ORDER.length : at;
};

export function inSiteOrder<T extends { readonly code: string }>(plans: readonly T[]): T[] {
  return plans.toSorted((a, b) => rank(a.code) - rank(b.code));
}

/** The plan an address asks for (?plan=duo), or null when it names none that could be one. */
export function planFromQuery(search: URLSearchParams): string | null {
  const asked = search.get("plan")?.toLowerCase() ?? null;
  return asked !== null && /^[a-z][a-z0-9-]{0,31}$/.test(asked) ? asked : null;
}
