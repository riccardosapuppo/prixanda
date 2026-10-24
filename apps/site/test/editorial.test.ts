// The editorial catalogue and the generated data name the same labels,
// artists and records, with the same ids: the fan campaigns aim at these
// artists' listeners in the database, and the site shows these records. The
// generator's lists are read from the generator itself, in the engine's
// Python environment (npm run setup makes it).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EDITORIAL_NOTE, LABELS, labelOf, RELEASES, releasesOf, runningTime } from "../src/content/editorial.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const python = join(repoRoot, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");

type Generated = { labels: [number, string, string][]; artists: [number, string, number, string, string][] };

function generated(): Generated {
  assert.ok(existsSync(python), `the engine's Python environment is missing (${python}): npm run setup`);
  const output = execFileSync(python, ["-c", [
    "import json",
    "from commerce.generate import LABELS, NAMED_ARTISTS",
    "print(json.dumps({'labels': LABELS, 'artists': NAMED_ARTISTS}))",
  ].join("\n")], { env: { ...process.env, PYTHONPATH: join(repoRoot, "services", "commerce", "src"), PYTHONIOENCODING: "utf-8" }, encoding: "utf8" });
  return JSON.parse(output) as Generated;
}

describe("the editorial catalogue", () => {
  const data = generated();

  it("has the generator's labels, with their ids and countries", () => {
    assert.deepEqual(LABELS.map((label) => [label.id, label.name, label.country]), data.labels);
  });

  it("has one record for each artist the generator names, with the same artist, label and title", () => {
    const fromGenerator = data.artists.map(([id, artist, labelId, , title]) => ({ id, artist, labelId, title })).sort((a, b) => a.id - b.id);
    const fromSite = RELEASES.map((release) => ({ id: release.artistId, artist: release.artist, labelId: release.labelId, title: release.title }))
      .sort((a, b) => a.id - b.id);
    assert.deepEqual(fromSite, fromGenerator);
    // The generator writes one release per named artist, with the artist's id.
    for (const release of RELEASES) assert.equal(release.id, release.artistId);
  });

  it("places every artist in the country of their label", () => {
    for (const [, artist, labelId, country] of data.artists) {
      const label = LABELS.find((candidate) => candidate.id === labelId);
      assert.equal(label?.country, country, `${artist}`);
    }
  });

  it("gives every record a cover seed of its own, a running time and a note", () => {
    assert.equal(new Set(RELEASES.map((release) => release.seed)).size, RELEASES.length);
    for (const release of RELEASES) {
      assert.ok(release.tracks > 0 && release.minutes > 0, release.title);
      assert.ok(release.note.length > 20, release.title);
      assert.doesNotMatch(release.note, /—/, "no long dashes in the site's text");
    }
    assert.match(EDITORIAL_NOTE, /invented/);
  });

  it("finds each record's label, and each label's records", () => {
    assert.equal(labelOf(RELEASES[3] ?? RELEASES[0]!).name, "Kellerlicht");
    assert.deepEqual(releasesOf(LABELS[0]!).map((release) => release.title), ["Stanze al piano terra", "Binario Morto"]);
    assert.equal(LABELS.reduce((sum, label) => sum + releasesOf(label).length, 0), RELEASES.length);
  });

  it("writes running times as the site does", () => {
    assert.equal(runningTime(47), "47 min");
    assert.equal(runningTime(60), "1 h");
    assert.equal(runningTime(90), "1 h 30 min");
    assert.throws(() => runningTime(-1), RangeError);
  });
});
