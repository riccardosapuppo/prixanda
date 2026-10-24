// A correction to the static export of Next.js 16.4.0 on Windows.
//
// For each page the export writes the router's prefetch data, one file per
// segment, named after the segment's path with its slashes turned into dots:
// the router asks for /campaign/__next.campaign.__PAGE__.txt. On Windows the
// export takes the segment's path from path.relative, which joins with
// backslashes that the renaming does not touch, and writes
// campaign/__next.campaign/__PAGE__.txt instead: the router's request then
// finds nothing. On Linux the files are already right, and this moves
// nothing.
//
// This moves every file found under a folder named __next.<something> up to
// the flat name the router asks for. It runs after every build, and a test
// checks the result on the build it is given.
import { readdir, rename, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else found.push(path);
  }
  return found;
}

/** Moves nested segment files to their flat names; returns how many it moved. */
export async function flattenSegmentFiles(out: string): Promise<number> {
  let moved = 0;
  const nested: string[] = [];
  for (const entry of await readdir(out, { withFileTypes: true, recursive: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("__next.")) continue;
    nested.push(join(entry.parentPath, entry.name));
  }
  // The deepest first, so a folder inside another is emptied before its parent.
  nested.sort((a, b) => b.length - a.length);
  for (const folder of nested) {
    for (const file of await filesUnder(folder)) {
      // campaign/__next.campaign/__PAGE__.txt -> campaign/__next.campaign.__PAGE__.txt
      const parent = join(folder, "..");
      const flat = relative(parent, file).split(sep).join(".");
      await rename(file, join(parent, flat));
      moved += 1;
    }
    await rm(folder, { recursive: true, force: true });
  }
  return moved;
}

/** Segment files a router would not find: anything still inside a __next.* folder. */
export async function nestedSegmentFiles(out: string): Promise<string[]> {
  const left: string[] = [];
  for (const entry of await readdir(out, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory() && entry.name.startsWith("__next.")) left.push(relative(out, join(entry.parentPath, entry.name)));
  }
  return left;
}
