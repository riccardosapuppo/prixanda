// The build's own correction: the prefetch files of nested routes moved to
// the names the router asks for (scripts/segments.ts), on a build laid out the
// way the static export of Next.js 16.4.0 lays it out on Windows.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import { flattenSegmentFiles, nestedSegmentFiles } from "../scripts/segments.ts";

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")).sort();
}

describe("the prefetch files of nested routes", () => {
  let out = "";

  before(async () => {
    out = await mkdtemp(join(tmpdir(), "site-segments-"));
    const files: Record<string, string> = {
      "index.html": "home",
      "__next.__PAGE__.txt": "root page",
      "campaign/index.html": "campaign",
      "campaign/__next._tree.txt": "tree",
      "campaign/__next.campaign/__PAGE__.txt": "campaign page",
      "account/listen/__next.account/listen/__PAGE__.txt": "deep page",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(out, ...path.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(out, ...path.split("/")), content);
    }
  });

  after(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it("finds the nested ones, moves them to the dotted names, and leaves the rest alone", async () => {
    assert.deepEqual(await nestedSegmentFiles(out), [join("account", "listen", "__next.account"), join("campaign", "__next.campaign")].sort());
    assert.equal(await flattenSegmentFiles(out), 2);
    assert.deepEqual(await tree(out), [
      "__next.__PAGE__.txt",
      "account/listen/__next.account.listen.__PAGE__.txt",
      "campaign/__next._tree.txt",
      "campaign/__next.campaign.__PAGE__.txt",
      "campaign/index.html",
      "index.html",
    ]);
    assert.equal(await readFile(join(out, "campaign", "__next.campaign.__PAGE__.txt"), "utf8"), "campaign page");
    assert.deepEqual(await nestedSegmentFiles(out), []);
  });

  it("moves nothing the second time", async () => {
    assert.equal(await flattenSegmentFiles(out), 0);
  });
});
