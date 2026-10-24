// The clock of a simulated listening session: where a number of seconds into
// the session falls, record by record and track by track. Pure functions, so
// a test can hold them to their arithmetic.
//
// The catalogue gives a record's length and its number of tracks, not each
// track's length, so a record's time is split evenly among its tracks; the
// tracks have no titles, since none were written.

export type SessionRecord = { readonly minutes: number; readonly tracks: number };

export type Timeline = {
  /** Where each record starts, in seconds from the start of the session. */
  readonly starts: readonly number[];
  /** The whole session, in seconds. */
  readonly total: number;
};

export type Position = {
  /** The record playing, by its place in the running order. */
  readonly index: number;
  /** Seconds into that record. */
  readonly into: number;
  /** The track playing, from 1. */
  readonly track: number;
};

export function timeline(records: readonly SessionRecord[]): Timeline {
  if (records.length === 0) throw new RangeError("a session has at least one record");
  const starts: number[] = [];
  let total = 0;
  for (const record of records) {
    if (!Number.isInteger(record.minutes) || record.minutes <= 0) throw new RangeError(`not a record's length: ${record.minutes}`);
    if (!Number.isInteger(record.tracks) || record.tracks <= 0) throw new RangeError(`not a number of tracks: ${record.tracks}`);
    starts.push(total);
    total += record.minutes * 60;
  }
  return { starts, total };
}

/** Keeps a position inside the session. */
export function clamp(at: number, line: Timeline): number {
  return Number.isFinite(at) ? Math.min(line.total, Math.max(0, Math.floor(at))) : 0;
}

export function positionAt(records: readonly SessionRecord[], line: Timeline, at: number): Position {
  const seconds = clamp(at, line);
  let index = records.length - 1;
  while (index > 0 && seconds < (line.starts[index] ?? 0)) index -= 1;
  const record = records[index];
  if (record === undefined) throw new RangeError("a session has at least one record");
  const into = seconds - (line.starts[index] ?? 0);
  const trackLength = (record.minutes * 60) / record.tracks;
  return { index, into, track: Math.min(record.tracks, Math.floor(into / trackLength) + 1) };
}

/** Previous record: the start of this one, or of the one before when this one has barely begun. */
export function previousStart(line: Timeline, position: Position): number {
  const here = line.starts[position.index] ?? 0;
  return position.into > 5 || position.index === 0 ? here : (line.starts[position.index - 1] ?? 0);
}

/** Next record: its start, or the end of the session after the last one. */
export function nextStart(line: Timeline, position: Position): number {
  return line.starts[position.index + 1] ?? line.total;
}

/** Seconds the way a player writes them: 0:00, 12:40, 1:30:00. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
