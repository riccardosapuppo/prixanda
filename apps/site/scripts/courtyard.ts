// node scripts/courtyard.ts: writes src/app/courtyard.svg, the site's ground.
//
// The courtyard of the approved design: large flagstones of white stone in
// the sun, thin joints barely darker than the stone, a little grit. One tile
// of 1440 by 1080 px, so on the widest screens it repeats at most once across;
// its rows run at different heights and its joints never line up, so the
// repeat does not show. Generated from a seed: the same seed, the same tile.
// The page draws it under everything except the header, the panels and the
// footer, which keep the plain stone.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "courtyard.svg");
const WIDTH = 1440;
const HEIGHT = 1080;
const JOINT = "#e9e9e2";
const GRIT = "#1b1f33";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = mulberry32(5900);
const between = (lo: number, hi: number) => Math.round(lo + r() * (hi - lo));

// Rows of stones: each row a height of its own, each stone a width of its own.
const joints: string[] = [];
let y = 0;
while (y < HEIGHT) {
  const rowHeight = Math.min(between(150, 230), HEIGHT - y);
  joints.push(`M0 ${y}H${WIDTH}`);
  let x = between(40, 260);
  while (x < WIDTH - 60) {
    joints.push(`M${x} ${y}V${y + rowHeight}`);
    x += between(220, 380);
  }
  y += rowHeight;
}
const grit: string[] = [];
for (let i = 0; i < 520; i += 1) {
  grit.push(`<circle cx="${between(0, WIDTH)}" cy="${between(0, HEIGHT)}" r="${(0.4 + r() * 0.9).toFixed(1)}"/>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`
  + `<path d="${joints.join("")}" stroke="${JOINT}" stroke-width="1.2" fill="none"/>`
  + `<g fill="${GRIT}" opacity="0.045">${grit.join("")}</g></svg>\n`;
await writeFile(out, svg);
console.log(`[site] wrote src/app/courtyard.svg (${svg.length} bytes)`);
