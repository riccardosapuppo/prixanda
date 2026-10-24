// Record covers, printed. The silks belong to the money (the price, the
// promise); covers are paper and ink, so they read as records and not as
// diagrams. Each label prints with its own technique, and every record varies
// its label's rule from its own seed, so two records of a label are kin
// without being twins:
//
//   Casa Lenta (Italy)          linocut: an arcade carved in one ink, the gouge marks left in
//   Disques Pareil (France)     pochoir: the same stencil cut once and printed twice, its bridges left open
//   Kellerlicht (Germany)       scraperboard: light scratched out of black ink below a high window
//   Coldframe Records (UK)      cyanotype: fronds laid on the paper and printed by the sun
//
// Every cover carries the grain of its paper. Flat inks, no gradients, nothing
// taken from outside: the same seed always prints the same cover. This is the
// approved mock-up's own drawing (direction C, third version), carried into
// TypeScript call for call, so a record looks the same here as it did there.
// Pure geometry: Cover.tsx draws it.
import { COLOR } from "design";

export type Technique = "linocut" | "pochoir" | "scraperboard" | "cyanotype";

export type Shape =
  | { readonly kind: "path"; readonly d: string; readonly fill?: string; readonly stroke?: string; readonly strokeWidth?: number;
    readonly round?: boolean; readonly dash?: string; readonly opacity?: number; readonly clipped?: boolean; readonly transform?: string }
  | { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number; readonly fill: string; readonly stroke?: string;
    readonly strokeWidth?: number; readonly opacity?: number }
  | { readonly kind: "rect"; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly fill: string }
  | { readonly kind: "ellipse"; readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number; readonly fill: string;
    readonly transform: string; readonly clipped?: boolean }
  | { readonly kind: "group"; readonly transform: string; readonly shapes: readonly Shape[] };

/** Where the record's words sit, so they never cross the print. */
export type Words = "bottom" | "top" | "strip" | "dark-left" | "dark-right";

export type CoverArt = {
  readonly technique: Technique;
  readonly ground: string;
  /** The colour of the words on this ground. */
  readonly ink: string;
  /** The outline the shapes marked `clipped` are cut to, when the technique has one. */
  readonly clip: string | null;
  readonly shapes: readonly Shape[];
  readonly grain: readonly Shape[];
  readonly words: Words;
};

export const TECHNIQUE: Readonly<Record<string, Technique>> = {
  "Casa Lenta": "linocut",
  "Disques Pareil": "pochoir",
  Kellerlicht: "scraperboard",
  "Coldframe Records": "cyanotype",
};

const PAPER = COLOR["stone-0"];
const STONE = COLOR.stone;
const INK = COLOR.ink;
const DEEP = { indigo: COLOR.indigo, madder: COLOR.madder, saffron: COLOR.saffron } as const;
const PALE = { indigo: COLOR["pig-indigo"], madder: COLOR["pig-madder"], saffron: COLOR["pig-saffron"] } as const;

type Random = () => number;

/** Deterministic randomness: the same seed, the same sequence (mulberry32). */
export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f1 = (n: number) => String(Math.round(n * 10) / 10);
const num = (n: number) => Math.round(n * 10) / 10;
const span = (r: Random, lo: number, hi: number) => lo + r() * (hi - lo);
function pick<T>(r: Random, list: readonly T[]): T {
  const item = list[Math.floor(r() * list.length)];
  if (item === undefined) throw new RangeError("pick from an empty list");
  return item;
}

/** The paper's grain: small specks, darker on light paper, lighter on dark ink. */
function grain(r: Random, onDark: boolean, n = 70): Shape[] {
  const tone = onDark ? STONE : INK;
  const out: Shape[] = [];
  for (let i = 0; i < n; i += 1) {
    const cx = num(span(r, 1, 99));
    const cy = num(span(r, 1, 99));
    const radius = Number(span(r, 0.12, 0.42).toFixed(2));
    const opacity = Number(span(r, 0.08, 0.22).toFixed(2));
    out.push({ kind: "circle", cx, cy, r: radius, fill: tone, opacity });
  }
  return out;
}

/** A wobbling line, as a gouge or a scratch leaves it. */
function wobble(r: Random, x0: number, y0: number, x1: number, y1: number, amp = 0.8, steps = 6): string {
  let d = `M${f1(x0)} ${f1(y0)}`;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const nx = -(y1 - y0);
    const ny = x1 - x0;
    const len = Math.hypot(nx, ny) || 1;
    const o = i === steps ? 0 : span(r, -amp, amp);
    d += ` L${f1(x + (nx / len) * o)} ${f1(y + (ny / len) * o)}`;
  }
  return d;
}

type Print = Omit<CoverArt, "grain">;

// ---- Casa Lenta: a linocut arcade ------------------------------------------------------------
function linocut(r: Random): Print {
  const ink = pick(r, [DEEP.madder, DEEP.madder, INK, DEEP.indigo]);
  const n = 2 + Math.floor(r() * 3);
  const top = span(r, 16, 26);
  const floor = 74;
  const gap = span(r, 2.5, 4.5);
  const w = (88 - gap * (n - 1)) / n;
  const block = `M4 ${f1(top - 8)}H96V${floor + 8}H4Z`;
  const arches: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const x0 = 6 + i * (w + gap);
    const rad = w / 2;
    arches.push(`M${f1(x0)} ${floor}V${f1(top + rad)}A${f1(rad)} ${f1(rad)} 0 0 1 ${f1(x0 + w)} ${f1(top + rad)}V${floor}Z`);
  }
  const shapes: Shape[] = [
    { kind: "path", d: block, fill: ink },
    { kind: "path", d: arches.join(""), fill: PAPER },
  ];
  // the carving: gouge lines across the arches' openings
  for (let y = top + 3; y < floor - 1; y += span(r, 2.6, 4.2)) {
    const d = wobble(r, 4, y, 96, y + span(r, -1, 1), 0.7, 9);
    shapes.push({ kind: "path", d, stroke: ink, strokeWidth: num(span(r, 0.5, 1.3)), round: true, clipped: true });
  }
  // the steps under the arcade, cut in paper
  for (let y = floor + 2; y < floor + 8; y += 2.2) {
    shapes.push({ kind: "path", d: wobble(r, 6, y, 94, y, 0.5, 8), stroke: PAPER, strokeWidth: 0.7 });
  }
  return { technique: "linocut", ground: PAPER, ink: INK, clip: arches.join(""), shapes, words: "bottom" };
}

// ---- Disques Pareil: pochoir twins -----------------------------------------------------------
function pochoir(r: Random): Print {
  // one stencil: a bulb of light on its stem, cut with bridges (strips of the stencil left whole)
  const h = span(r, 40, 50);
  const bw = span(r, 18, 23);
  const shape = (cx: number, cy: number) => {
    const top = cy - h / 2;
    return `M${f1(cx)} ${f1(top)}C${f1(cx + bw)} ${f1(top)} ${f1(cx + bw)} ${f1(top + h * 0.62)} ${f1(cx + bw * 0.32)} ${f1(top + h * 0.78)}`
      + `L${f1(cx + bw * 0.32)} ${f1(top + h)}L${f1(cx - bw * 0.32)} ${f1(top + h)}L${f1(cx - bw * 0.32)} ${f1(top + h * 0.78)}`
      + `C${f1(cx - bw)} ${f1(top + h * 0.62)} ${f1(cx - bw)} ${f1(top)} ${f1(cx)} ${f1(top)}Z`;
  };
  const a = pick(r, ["madder", "indigo"] as const);
  const b = "saffron" as const;
  const tiltA = span(r, -9, -2);
  const tiltB = span(r, 2, 9);
  const yA = span(r, 50, 58);
  const yB = yA + span(r, -6, 6);
  const bridges = (cx: number, cy: number): Shape[] => {
    const out: Shape[] = [];
    const k = 2 + Math.floor(r() * 2);
    for (let i = 0; i < k; i += 1) {
      const y = cy - h / 2 + h * (0.22 + i * 0.2);
      out.push({ kind: "rect", x: num(cx - bw - 2), y: num(y), width: num(bw * 2 + 4), height: 1.1, fill: PAPER });
    }
    return out;
  };
  const twin = (cx: number, cy: number, dye: "madder" | "indigo" | "saffron", tilt: number): Shape => ({
    kind: "group",
    transform: `rotate(${f1(tilt)} ${f1(cx)} ${f1(cy)})`,
    shapes: [
      { kind: "path", d: shape(cx, cy), fill: dye === "saffron" ? PALE.saffron : DEEP[dye] },
      ...bridges(cx, cy),
      { kind: "path", d: shape(cx, cy), stroke: INK, strokeWidth: 0.35, dash: "1.5 1.2", opacity: 0.5 },
    ],
  });
  // the stencil's own mark: a thin line from the top edge down to each print
  const cord = (cx: number, cy: number, tilt: number): Shape => {
    const topY = cy - h / 2;
    const rad = (tilt * Math.PI) / 180;
    return { kind: "path", d: `M${f1(cx + Math.sin(rad) * (topY - 15) * -1)} 15L${f1(cx)} ${f1(topY + 1)}`, stroke: INK, strokeWidth: 0.6 };
  };
  const shapes = [cord(31, yA, tiltA), cord(69, yB, tiltB), twin(31, yA, a, tiltA), twin(69, yB, b, tiltB)];
  return { technique: "pochoir", ground: PAPER, ink: INK, clip: null, shapes, words: "top" };
}

// ---- Kellerlicht: scraperboard ----------------------------------------------------------------
function scraperboard(r: Random): Print {
  const left = r() < 0.5; // the window keeps to one side; the words take the dark corner opposite
  const wx = left ? span(r, 10, 24) : span(r, 62, 76);
  const ww = span(r, 9, 14);
  const lean = left ? span(r, 4, 22) : span(r, -22, -4);
  const spread = span(r, 1.8, 2.6);
  const shapes: Shape[] = [
    { kind: "rect", x: num(wx), y: 6, width: num(ww), height: 8, fill: STONE },
    { kind: "path", d: `M${f1(wx + ww / 2)} 6V14M${f1(wx)} 10H${f1(wx + ww)}`, stroke: INK, strokeWidth: 0.8 },
  ];
  const n = 26;
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const sx = wx + ww * t;
    const ex = wx + lean + ww * spread * t - (ww * (spread - 1)) / 2;
    const reach = span(r, 0.55, 1); // the scratch stops short: the light fades into the dark
    const ey = 14 + (96 - 14) * reach;
    const exr = sx + (ex - sx) * reach;
    const d = wobble(r, sx, 14, exr, ey, 0.25, 5);
    shapes.push({ kind: "path", d, stroke: STONE, strokeWidth: num(span(r, 0.25, 0.7)), round: true });
  }
  // stairs scratched across the beam, the way down to the cellar
  for (let k = 0; k < 4; k += 1) {
    const y = 70 + k * 6;
    shapes.push({ kind: "path", d: wobble(r, wx + lean - 10 + k * 3, y, wx + lean + ww * spread + 6 - k * 2, y, 0.3, 6), stroke: STONE, strokeWidth: 0.5, opacity: 0.7 });
  }
  return { technique: "scraperboard", ground: INK, ink: STONE, clip: null, shapes, words: left ? "dark-right" : "dark-left" };
}

// ---- Coldframe Records: cyanotype -------------------------------------------------------------
function cyanotype(r: Random): Print {
  // the brushed sheet: indigo where the coating was, paper where the brush missed
  const edge = (x0: number, y0: number, x1: number, y1: number, amp: number) => wobble(r, x0, y0, x1, y1, amp, 10).replace(/^M/, "L");
  const top = edge(7, 7, 93, 6, 1.4);
  const right = edge(93, 6, 94, 79, 1.4);
  const bottom = edge(94, 79, 6, 80, 1.4);
  const leftEdge = edge(6, 80, 7, 7, 1.4);
  const sheet = `M7 7${top}${right}${bottom}${leftEdge}Z`;
  const shapes: Shape[] = [{ kind: "path", d: sheet, fill: DEEP.indigo }];
  const k = 2 + Math.floor(r() * 2);
  for (let i = 0; i < k; i += 1) {
    const bx = span(r, 22, 78);
    const by = 84;
    const tx = bx + span(r, -26, 26);
    const ty = span(r, 12, 28);
    const cx = (bx + tx) / 2 + span(r, -18, 18);
    const cy = (by + ty) / 2;
    shapes.push({ kind: "path", d: `M${f1(bx)} ${by}Q${f1(cx)} ${f1(cy)} ${f1(tx)} ${f1(ty)}`, stroke: STONE, strokeWidth: 0.9, clipped: true });
    const leaves = 9 + Math.floor(r() * 5);
    for (let j = 1; j < leaves; j += 1) {
      const t = j / leaves;
      const px = (1 - t) * (1 - t) * bx + 2 * (1 - t) * t * cx + t * t * tx;
      const py = (1 - t) * (1 - t) * by + 2 * (1 - t) * t * cy + t * t * ty;
      const dx = 2 * (1 - t) * (cx - bx) + 2 * t * (tx - cx);
      const dy = 2 * (1 - t) * (cy - by) + 2 * t * (ty - cy);
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const len = 7 * (1 - t * 0.6);
      const lifted = r() < 0.18; // a leaf that lifted off the paper prints pale
      const fill = lifted ? PALE.indigo : STONE;
      for (const turn of [angle + 58, angle - 58]) {
        shapes.push({
          kind: "ellipse", cx: num(px), cy: num(py), rx: num(len), ry: num(len * 0.32), fill, clipped: true,
          transform: `rotate(${f1(turn)} ${f1(px)} ${f1(py)}) translate(${f1(len * 0.9)} 0)`,
        });
      }
    }
  }
  return { technique: "cyanotype", ground: PAPER, ink: INK, clip: sheet, shapes, words: "strip" };
}

const PRINT: Readonly<Record<Technique, (r: Random) => Print>> = { linocut, pochoir, scraperboard, cyanotype };

/** A record's cover, printed in its label's technique from the record's own seed. */
export function coverArt(release: { readonly seed: number; readonly label: string }): CoverArt {
  const r = mulberry32(release.seed * 7919 + 101);
  const printed = PRINT[TECHNIQUE[release.label] ?? "linocut"](r);
  return { ...printed, grain: grain(r, printed.ground === INK) };
}
