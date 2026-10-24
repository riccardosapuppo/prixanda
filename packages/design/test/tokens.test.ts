// The tokens: every pair of colours reaches the contrast written beside it,
// the motion stays short, and the icons the applications ask for exist.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { contrast, luminance } from "../src/contrast.ts";
import { ICONS } from "../src/icons.ts";
import { COLOR, DURATION_MS, PAIRS } from "../src/tokens.ts";

describe("contrast, as WCAG measures it", () => {
  it("gives the known extremes", () => {
    assert.equal(contrast("#000000", "#ffffff"), 21);
    assert.equal(contrast("#777777", "#777777"), 1);
    assert.equal(luminance("#ffffff"), 1);
  });

  it("refuses a colour that is not #rrggbb", () => {
    assert.throws(() => luminance("blue"), TypeError);
  });
});

describe("every pair the pages put together reaches its contrast", () => {
  for (const [foreground, background, floor, where] of PAIRS) {
    it(`${foreground} on ${background}, at least ${floor}:1 (${where})`, () => {
      const ratio = contrast(COLOR[foreground], COLOR[background]);
      assert.ok(ratio >= floor, `${foreground} ${COLOR[foreground]} on ${background} ${COLOR[background]} is ${ratio.toFixed(2)}:1`);
    });
  }

  it("names at least the pairs the approved design measured", () => {
    assert.ok(PAIRS.length >= 27, `only ${PAIRS.length} pairs`);
  });
});

describe("motion and icons", () => {
  it("keeps every duration under 300 ms", () => {
    for (const [name, ms] of Object.entries(DURATION_MS)) assert.ok(ms > 0 && ms < 300, `${name} is ${ms} ms`);
  });

  it("draws every icon with at least one path on the 256 grid", () => {
    assert.ok(Object.keys(ICONS).length >= 80);
    for (const [name, paths] of Object.entries(ICONS)) {
      assert.ok(paths.length > 0, name);
      for (const d of paths) assert.match(d, /^M[\d.,\s-]/, name);
    }
  });

  it("the theme declares every colour of tokens.json, and clears Tailwind's own", async () => {
    const theme = await readFile(new URL("../css/theme.css", import.meta.url), "utf8");
    assert.match(theme, /--color-\*: initial;/);
    for (const [name, value] of Object.entries(COLOR)) assert.ok(theme.includes(`--color-${name}: ${value};`), name);
  });
});
