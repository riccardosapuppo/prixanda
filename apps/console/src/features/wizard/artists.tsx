"use client";
// The artist of a campaign for an album release (business book §14.2),
// found in the catalog by a part of the name as the engine lists it, with
// the label, the country and the latest record that tell two names apart.
// Marketing, the commercial lead and finance read the catalog's artists
// (§12): a role that does not reads the artist by number, and the campaign's
// sentence, in the engine's words, names them.
import { Icon } from "design/icon";
import { useEffect, useState } from "react";
import { ErrorPanel, FieldError } from "../../components/ui.tsx";
import { ArtistsDocument, type ArtistsQuery } from "../../graphql/generated.ts";
import { can, whoDoes } from "../../lib/permissions.ts";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";
import { useViewer } from "../../lib/react/session.tsx";
import { formatDay } from "../../lib/time.ts";

export type Artist = ArtistsQuery["artists"]["nodes"][number];

/** How many artists a search shows: enough to choose from, few enough to read. */
const SHOWN = 6;

/** The artists a version aims at, by id, for the roles that read the catalog's artists; empty for the others. */
export function useArtists(ids: readonly number[]): ReadonlyMap<number, Artist> {
  const viewer = useViewer();
  const wanted = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  const read = useGatewayQuery(ArtistsDocument, { ids: wanted, first: Math.max(wanted.length, 1) }, {
    enabled: wanted.length > 0 && can(viewer.roles, "readArtists"),
    staleTime: 5 * 60_000,
  });
  return new Map((read.data?.artists.nodes ?? []).map((artist) => [artist.id, artist]));
}

/** The names of the artists a version aims at, for the words that describe it ("who played Doppelfenster ..."). */
export function useArtistNames(ids: readonly number[]): ReadonlyMap<number, string> {
  const artists = useArtists(ids);
  return new Map([...artists].map(([id, artist]) => [id, artist.name]));
}

/** "Kellerlicht · Germany · Nordflur, 6 November 2026": what tells an artist apart from another. */
export function artistDetail(artist: Artist, markets: readonly { readonly code: string; readonly name: string }[]): string {
  const country = markets.find((market) => market.code === artist.country)?.name ?? artist.country;
  const record = artist.latestRelease ? ` · ${artist.latestRelease.title}, ${formatDay(artist.latestRelease.releasedOn)}` : "";
  return `${artist.label} · ${country}${record}`;
}

/** A search typed, read once the person stops typing for a moment. */
function useSettled(text: string, ms = 250): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), ms);
    return () => clearTimeout(timer);
  }, [text, ms]);
  return settled;
}

export function ArtistPicker({ value, disabled, error, markets, onChange, onBlur }: {
  /** The chosen artist's id, as text; empty when none is chosen. */
  readonly value: string;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly markets: readonly { readonly code: string; readonly name: string }[];
  readonly onChange: (id: string) => void;
  readonly onBlur: () => void;
}) {
  const viewer = useViewer();
  const readsArtists = can(viewer.roles, "readArtists");
  const [typed, setTyped] = useState("");
  const search = useSettled(typed.trim());
  const chosenId = value === "" ? null : Number(value);
  const chosen = useArtists(chosenId === null ? [] : [chosenId]).get(chosenId ?? 0) ?? null;
  const found = useGatewayQuery(ArtistsDocument, { search, first: SHOWN }, { enabled: readsArtists && !disabled, keepPrevious: true, staleTime: 60_000 });

  if (!readsArtists) {
    return (
      <p className="grid gap-0.5 text-sm">
        <span className="label">Artist</span>
        <span>{chosenId === null ? "None chosen yet." : `Artist #${chosenId}.`} {whoDoes("readArtists", { one: "reads the catalog's artists", many: "read the catalog's artists" })}; the campaign's sentence in step 5 names them.</span>
      </p>
    );
  }
  if (disabled) {
    return (
      <p className="grid gap-0.5 text-sm">
        <span className="label">Artist</span>
        <span>{chosen ? <><b>{chosen.name}</b> <span className="text-ink-2">{artistDetail(chosen, markets)}</span></> : chosenId === null ? "None chosen yet." : `Artist #${chosenId}`}</span>
      </p>
    );
  }

  const nodes = found.data?.artists.nodes ?? [];
  // The chosen artist stays in view, first, while another search shows other names.
  const kept = chosen && !nodes.some((artist) => artist.id === chosen.id) ? chosen : null;
  const shown = kept ? [kept, ...nodes] : nodes;
  const more = found.data?.artists.next !== null && found.data?.artists.next !== undefined;
  const status = found.isPending
    ? "Reading the catalog's artists."
    : (nodes.length === 0
      ? `No artist of the catalog has “${search}” in their name.`
      : more
        ? `The first ${nodes.length} by name${search ? ` with “${search}”` : ""}: type more of the name to find another.`
        : `${nodes.length} ${nodes.length === 1 ? "artist" : "artists"}${search ? ` with “${search}” in their name` : " in the catalog"}.`)
      + (kept ? ` The one chosen, ${kept.name}, stays first.` : "");

  return (
    <div className="grid content-start gap-2">
      <label htmlFor="artist" className="label">Artist</label>
      <p id="artist-hint" className="hint">Type a part of the name; the catalog's artists come by name, with their label and latest record.</p>
      <span className="relative block max-w-md">
        <Icon name="magnifying-glass" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-2" />
        <input
          id="artist"
          className="input pl-8"
          type="search"
          value={typed}
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          aria-invalid={error ? true : undefined}
          aria-describedby={["artist-hint", "artist-found", error ? "artist-error" : null].filter(Boolean).join(" ")}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={onBlur}
        />
      </span>
      {found.isError ? <ErrorPanel error={found.error} retry={() => void found.refetch()} /> : null}
      {shown.length ? (
        <fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0">
          <legend className="sr-only">The artist whose fans it is for</legend>
          {shown.map((artist) => (
            <label key={artist.id} className="choice-card grid-cols-[auto_minmax(0,1fr)] py-2">
              <input type="radio" name="artist-choice" value={artist.id} checked={chosenId === artist.id} onChange={() => onChange(String(artist.id))} onBlur={onBlur} />
              <span>
                {artist.name}
                <small className="block text-xs text-ink-2">{artistDetail(artist, markets)}</small>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <p id="artist-found" className="text-xs text-ink-2" role="status">{status}</p>
      {error ? <FieldError id="artist-error">{error}</FieldError> : null}
    </div>
  );
}
