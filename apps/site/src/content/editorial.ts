// The service's editorial catalogue: its labels, their new records and the
// listening sessions built from them (business book §1.1). It is static
// content of the fictional service, written for the site, not data of the
// platform: the platform governs what is sold, at what price and with whose
// signature, and has no say over liner notes. It reaches the pages through
// the data layer (useLabels, useReleases), like everything else, so serving
// it from elsewhere one day changes the data layer and no page.
//
// Everything here is invented. Labels, artists and titles are the ones the
// data generator writes into the database (services/commerce/src/commerce/
// generate.py), with the same ids: the fan campaigns of §14.2 aim at the
// listeners of these artists, and a test holds the two lists together. Names
// were checked against existing acts on 24 October 2026.
import type { SiteMarket } from "../data/markets.ts";

export type Label = {
  readonly id: number;
  readonly name: string;
  readonly country: SiteMarket;
};

export type Release = {
  /** The release's id in the generated data (one record per artist). */
  readonly id: number;
  readonly artistId: number;
  readonly artist: string;
  readonly title: string;
  readonly labelId: number;
  readonly tracks: number;
  readonly minutes: number;
  /** The seed its cover is drawn from: the same seed, the same cover. */
  readonly seed: number;
  /** The liner note, in the label's voice. */
  readonly note: string;
};

export const LABELS: readonly Label[] = [
  { id: 1, name: "Casa Lenta", country: "IT" },
  { id: 2, name: "Disques Pareil", country: "FR" },
  { id: 3, name: "Kellerlicht", country: "DE" },
  { id: 4, name: "Coldframe Records", country: "GB" },
];

export const RELEASES: readonly Release[] = [
  {
    id: 1, artistId: 1, artist: "Velluto Basso", title: "Stanze al piano terra", labelId: 1, tracks: 9, minutes: 41, seed: 11,
    note: "Bass clarinet, upright piano and a radiator ticking in the left channel. Recorded in a ground-floor flat over four winter weekends.",
  },
  {
    id: 2, artistId: 2, artist: "Ottoline Marr", title: "Low Tide Hymns", labelId: 4, tracks: 10, minutes: 44, seed: 23,
    note: "Hymn tunes slowed until they come apart, sung over a harmonium bought at a seaside auction.",
  },
  {
    id: 3, artistId: 3, artist: "Ciel Fendu", title: "Lumière de service", labelId: 2, tracks: 11, minutes: 47, seed: 37,
    note: "Night-shift synth pop: a drum machine, a borrowed cello, songs about the lights left on in empty offices.",
  },
  {
    id: 4, artistId: 4, artist: "Doppelfenster", title: "Nordflur", labelId: 3, tracks: 8, minutes: 52, seed: 41,
    note: "Two brothers, one corridor. Patient grooves with pop hooks, recorded in a stairwell.",
  },
  {
    id: 5, artistId: 5, artist: "Pinewire", title: "Signal Fires", labelId: 4, tracks: 9, minutes: 31, seed: 53,
    note: "Math rock in odd metres that still makes you nod.",
  },
  {
    id: 6, artistId: 6, artist: "Corale Ferrovia", title: "Binario Morto", labelId: 1, tracks: 12, minutes: 49, seed: 67,
    note: "A railway workers' choir and one modular synth. Work songs, rewired.",
  },
  {
    id: 7, artistId: 7, artist: "Halde", title: "Abraum", labelId: 3, tracks: 6, minutes: 58, seed: 79,
    note: "Slow guitar drone with field recordings from a closed mine.",
  },
];

export const EDITORIAL_NOTE = "Artists, labels and releases are invented for this project; names were checked against existing acts on 24 October 2026.";

export function labelOf(release: Release): Label {
  const label = LABELS.find((candidate) => candidate.id === release.labelId);
  if (label === undefined) throw new Error(`release ${release.id} names no known label`);
  return label;
}

/** The records of a label, in the catalogue's order. */
export function releasesOf(label: Label): readonly Release[] {
  return RELEASES.filter((release) => release.labelId === label.id);
}

/** Minutes as the site writes a running time: 47 min, 1 h 30 min. */
export function runningTime(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError(`not a running time: ${minutes}`);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}
