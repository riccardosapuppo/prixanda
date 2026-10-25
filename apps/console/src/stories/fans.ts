// Fixtures for the stories of a campaign for an album release (business book
// §14.2): the catalog's named artists as the engine lists them, by name, and
// the Nordflur release for the fans of Doppelfenster on Free in Germany, as
// the gateway would send it once checked.
import type { ArtistsQuery } from "../graphql/generated.ts";
import { type Change, studentPass } from "./fixtures.ts";

type Artist = ArtistsQuery["artists"]["nodes"][number];

const artist = (id: number, name: string, label: string, country: string, title: string | null, releasedOn = ""): Artist => ({
  id, name, label, country, latestRelease: title === null ? null : { title, releasedOn },
});

/** The catalog's named artists, by name, as ListArtists gives them. */
export const ARTISTS: readonly Artist[] = [
  artist(3, "Ciel Fendu", "Disques Pareil", "FR", "Lumière de service", "2026-09-04"),
  artist(6, "Corale Ferrovia", "Casa Lenta", "IT", "Binario Morto", "2026-02-06"),
  artist(4, "Doppelfenster", "Kellerlicht", "DE", "Nordflur", "2026-11-06"),
  artist(7, "Halde", "Kellerlicht", "DE", "Abraum", "2026-06-12"),
  artist(2, "Ottoline Marr", "Coldframe Records", "GB", "Low Tide Hymns", "2026-03-20"),
  artist(5, "Pinewire", "Coldframe Records", "GB", "Signal Fires", "2025-11-14"),
  artist(1, "Velluto Basso", "Casa Lenta", "IT", "Stanze al piano terra", "2026-05-15"),
];

/** The engine's answer over the fixtures: a part of the name in any case, only the ids named, a page by name. */
export function artistsAnswer(variables: { readonly search?: string | null; readonly ids?: readonly number[] | null; readonly first?: number }): ArtistsQuery {
  const search = (variables.search ?? "").trim().toLowerCase();
  const ids = variables.ids ?? [];
  const found = ARTISTS.filter((entry) => entry.name.toLowerCase().includes(search) && (ids.length === 0 || ids.includes(entry.id)));
  const first = variables.first ?? 20;
  return { artists: { nodes: found.slice(0, first), next: found.length > first ? "more" : null } };
}

export const NORDFLUR_SENTENCE = "Germany, Individual: from €10.99 to €1.99 for 2 months, Free listeners with more than 3 hours of Doppelfenster in 30 days; "
  + "3,840 eligible; at most 1,500; conflicts: none.";

/** The Nordflur release as v1, written by Marketing and checked: Finance to sign, the price being below the floor. */
export function nordflurRelease(state: Change["state"] = "VALIDATED"): Change {
  const base = studentPass(state);
  const fingerprint = "4e0d9c1b2a39485766a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0a1";
  const content = {
    __typename: "OfferContent" as const,
    title: "Nordflur release",
    plan: "individual",
    audience: { segment: "FREE_LISTENERS" as const, currentPlan: null, needsStudentCheck: false, listening: { artistId: 4, minSeconds: 10_800, withinDays: 30 } },
    prices: [{ market: "DE", fixed: { amountMinor: "199", currency: "EUR" }, percentOffBasisPoints: null }],
    monthsAtOfferPrice: 2,
    periods: [{ market: "DE", startsLocal: "2026-11-06T00:00", endsLocal: "2026-12-06T00:00" }],
    nonCombinabilityGroup: "release-offers",
    redemptionCap: 1500,
    pages: [{
      market: "DE",
      title: "Nordflur is out",
      text: "Two months of Individual for 1,99 € a month, for the listeners who kept Doppelfenster on repeat. Then 10,99 €, the usual Individual price.",
      terms: "For listeners on Free in Germany who played Doppelfenster for more than 3 hours in the last 30 days.",
      treatment: "standard",
    }],
  };
  const version = { version: 1, author: base.createdBy, createdAt: "2026-10-24T08:10:00Z", fingerprint, content };
  return {
    ...base,
    id: "12",
    title: "Nordflur release",
    currentVersion: 1,
    versions: [version],
    current: version,
    approvals: [],
    validation: {
      version: 1,
      valid: true,
      eligible: 3_840,
      findings: [
        { check: "floor", severity: "NEEDS_SIGNATURE", market: "DE", message: "Germany: €1.99 is below the floor of €5.95; the artists' minimum costs €1.99 a month per subscription.", facts: [] },
        { check: "signatures", severity: "NEEDS_SIGNATURE", market: null, message: "Finance must sign: conditions 2 and 4 of §7.3.", facts: [] },
      ],
    },
    requiredSignatures: [{ role: "FINANCE", conditions: [2, 4], why: "Finance must sign: conditions 2 and 4 of §7.3.", signed: false }],
    sentence: NORDFLUR_SENTENCE,
    authorReason: null,
  };
}
