// Finding the event a link names (`/audit/?seq=12`) in a list the engine
// gives newest first, a page at a time (the audit log, §11). The list is read
// on until the event is among the events read; it is not there when the
// events read already go older than it, or when the engine has no more.
export type Seek =
  /** No event named. */
  | "none"
  /** Not read yet: read the next page. */
  | "seeking"
  | "found"
  | "not-found";

/** Where the search for `target` stands, from the sequence numbers read so far (newest first) and whether the engine has more. */
export function seek(target: string | null, read: { readonly loaded: boolean; readonly seqs: readonly string[]; readonly more: boolean }): Seek {
  if (target === null) return "none";
  if (!/^\d+$/.test(target)) return "not-found";
  if (!read.loaded) return "seeking";
  if (read.seqs.includes(target)) return "found";
  const oldest = read.seqs.at(-1);
  if (oldest !== undefined && BigInt(oldest) < BigInt(target)) return "not-found";
  return read.more ? "seeking" : "not-found";
}
