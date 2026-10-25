// The snapshot's tar without the WAL segments PostgreSQL does not need: after
// the build's last checkpoint, only the segment holding it is read again
// when the browser starts the cluster (its redo point); the others are
// segments recycled for later writes, full of what the build wrote before,
// which would weigh on every first visit and compress badly.
const BLOCK = 512;

function text(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? length : end).toString("utf8");
}

/** The tar's entries, by name and size, in order (ustar, as PGlite writes it). */
export function entries(tar: Buffer): Array<{ name: string; size: number; offset: number; length: number }> {
  const found = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const prefix = text(header, 345, 155);
    const name = prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100);
    const size = parseInt(text(header, 124, 12).trim() || "0", 8);
    const length = BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    found.push({ name, size, offset, length });
    offset += length;
  }
  return found;
}

export function withoutWal(tar: Buffer, keep: string): { tar: Buffer; dropped: string[] } {
  if (!/^[0-9A-F]{24}$/.test(keep)) throw new Error(`not a WAL segment: ${keep}`);
  const parts: Buffer[] = [];
  const dropped: string[] = [];
  let kept = false;
  for (const entry of entries(tar)) {
    const segment = /(?:^|\/)pg_wal\/([0-9A-F]{24})$/.exec(entry.name)?.[1];
    if (segment !== undefined && segment !== keep) {
      dropped.push(segment);
      continue;
    }
    if (segment === keep) kept = true;
    parts.push(tar.subarray(entry.offset, entry.offset + entry.length));
  }
  if (!kept) throw new Error(`the snapshot has no WAL segment ${keep}, where its last checkpoint is`);
  parts.push(Buffer.alloc(BLOCK * 2));
  return { tar: Buffer.concat(parts), dropped };
}
