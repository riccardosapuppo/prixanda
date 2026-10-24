// Times as the console writes them (business book §3.7). Anything scheduled
// for a market is a wall-clock time in that market's zone ("2026-10-26T09:00"
// in Europe/Rome); an instant is ISO 8601 in UTC. The console shows both:
// "Mon 26 Oct 2026, 09:00 Rome (08:00 UTC)".
//
// Whether a local time falls in a gap or a repeat of the clocks is the
// engine's to decide (it refuses AMBIGUOUS_LOCAL_TIME); the console computes
// it here only to warn while a person types. Every function takes the time
// it needs: none of them reads the clock.

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** "2026-10-26T09:00" or "2026-10-26T09:00:30" as its parts; null when it is not a local time. */
export function parseLocal(text: string): LocalParts | null {
  const match = LOCAL.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return { year, month, day, hour, minute, second };
}

/** A local time written the contract's way: minutes, and seconds only when there are some. */
export function formatLocalValue(parts: LocalParts): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const base = `${parts.year}-${two(parts.month)}-${two(parts.day)}T${two(parts.hour)}:${two(parts.minute)}`;
  return parts.second ? `${base}:${two(parts.second)}` : base;
}

/** "Europe/Rome" as "Rome", the way the console names a zone. */
export function zoneCity(zone: string): string {
  return (zone.split("/").pop() ?? zone).replaceAll("_", " ");
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...options });
    formatters.set(key, found);
  }
  return found;
}

/** The wall-clock parts of an instant in a zone. */
export function partsIn(instant: Date, zone: string): LocalParts {
  const parts = formatter(zone, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

const wallMillis = (parts: LocalParts) => Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

/** The zone's offset from UTC at an instant, in minutes (Rome in summer: 120). */
export function offsetMinutes(instant: Date, zone: string): number {
  const seconds = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((wallMillis(partsIn(new Date(seconds), zone)) - seconds) / 60_000);
}

export type LocalInstant =
  | { readonly kind: "single"; readonly instant: Date }
  | { readonly kind: "skipped" }
  | { readonly kind: "repeated"; readonly earlier: Date; readonly later: Date };

/** The instant a wall-clock time of a zone falls on; the clocks may skip it or repeat it. */
export function localToInstant(local: LocalParts, zone: string): LocalInstant {
  const wall = wallMillis(local);
  const candidates = new Set<number>();
  // The offsets in force a day either side cover any clock change of the day.
  for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) {
    const offset = offsetMinutes(new Date(probe), zone);
    const instant = wall - offset * 60_000;
    if (wallMillis(partsIn(new Date(instant), zone)) === wall) candidates.add(instant);
  }
  const found = [...candidates].sort((a, b) => a - b);
  if (found.length === 0) return { kind: "skipped" };
  if (found.length > 1) return { kind: "repeated", earlier: new Date(found[0] ?? wall), later: new Date(found.at(-1) ?? wall) };
  return { kind: "single", instant: new Date(found[0] ?? wall) };
}

const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: "short", day: "2-digit", month: "short", year: "numeric" };

/** "Mon 26 Oct 2026, 09:00 Rome", from a local time of a zone. */
export function formatLocal(local: string, zone: string, options: { withYear?: boolean } = {}): string {
  const parts = parseLocal(local);
  if (parts === null) return local;
  const date = new Date(wallMillis(parts));
  const day = formatter("UTC", options.withYear === false ? { weekday: "short", day: "2-digit", month: "short" } : WEEKDAY).format(date).replace(",", "");
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}${parts.second ? `:${String(parts.second).padStart(2, "0")}` : ""}`;
  return `${day}, ${time} ${zoneCity(zone)}`;
}

/** "08:00 UTC" or "08:31:55 UTC". */
export function formatUtcTime(instant: string | Date, options: { seconds?: boolean } = {}): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return `${formatter("UTC", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(options.seconds ? { second: "2-digit" } : {}) }).format(date)} UTC`;
}

/** "Mon 26 Oct 2026, 09:00 Rome (08:00 UTC)", or a warning when the clocks skip or repeat the time. */
export function formatLocalWithUtc(local: string, zone: string): string {
  const parts = parseLocal(local);
  if (parts === null) return local;
  const at = localToInstant(parts, zone);
  if (at.kind === "skipped") return `${formatLocal(local, zone)} (the clocks skip this time)`;
  if (at.kind === "repeated") return `${formatLocal(local, zone)} (the clocks repeat this time)`;
  return `${formatLocal(local, zone)} (${formatUtcTime(at.instant)})`;
}

/** "24 Oct 10:31:55 Rome", an instant read in a zone. */
export function formatInstantIn(instant: string | Date, zone: string, options: { seconds?: boolean; year?: boolean } = {}): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  const day = formatter(zone, { day: "2-digit", month: "short", ...(options.year ? { year: "numeric" } : {}) }).format(date);
  const time = formatter(zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(options.seconds ? { second: "2-digit" } : {}) }).format(date);
  return `${day} ${time} ${zoneCity(zone)}`;
}

/** "10:31:55", the clock time of an instant in a zone. */
export function formatClockIn(instant: string | Date, zone: string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return formatter(zone, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
}

/** "Saturday 24 October", the day an instant falls on in a zone. */
export function dayHeading(instant: Date, zone: string): string {
  return formatter(zone, { weekday: "long", day: "numeric", month: "long" }).format(instant).replace(",", "");
}

/** "Saturday 24 October 2026, 10:42 in Rome". */
export function nowLabel(instant: Date, zone: string): string {
  const day = formatter(zone, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(instant).replace(",", "");
  const time = formatter(zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
  return `${day}, ${time} in ${zoneCity(zone)}`;
}

/** The local time of an instant in a zone, the contract's way. */
export function localValueOf(instant: Date, zone: string): string {
  return formatLocalValue({ ...partsIn(instant, zone), second: 0 });
}

/** Days added to a local time's date, the time of day kept. */
export function addLocalDays(parts: LocalParts, days: number): LocalParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { ...parts, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** The next given weekday (1 Monday ... 7 Sunday) strictly after a local date, at a time of day. */
export function nextWeekday(from: LocalParts, weekday: number, hour: number, minute = 0): LocalParts {
  const date = new Date(Date.UTC(from.year, from.month - 1, from.day));
  const today = ((date.getUTCDay() + 6) % 7) + 1;
  const ahead = ((weekday - today + 7) % 7) || 7;
  return { ...addLocalDays({ ...from, hour, minute, second: 0 }, ahead) };
}
