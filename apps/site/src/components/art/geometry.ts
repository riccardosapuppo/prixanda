// The site's drawings as geometry, computed from the figures the API gives:
// pure functions, no DOM, so a test can hold them to their rules.
//
// The language is the approved design's: translucent silk sails tied along a
// rope, pulled taut so their free edges curve inwards, which is what makes
// them read as cloth and not as bars. Widths and counts come from the data;
// the drops vary only to look like hanging cloth, never to carry a value.

const f1 = (n: number) => String(Math.round(n * 10) / 10);

export type Dye = "madder" | "saffron" | "indigo";

// ---------------------------------------------------------------------------
// The months of an offer: one saffron sail per month at the offer price, then
// the list price as one indigo sheet that runs on past the edge.

export type MonthSail = { readonly path: string; readonly hem: readonly [number, number]; readonly bottom: number; readonly a: number; readonly b: number };

export type MonthsScene = {
  readonly width: number;
  readonly height: number;
  readonly rope: number;
  /** Columns of the caption under the drawing: the months, then the list price's wider share. */
  readonly columns: number;
  readonly sails: readonly MonthSail[];
  readonly list: { readonly path: string; readonly hem: readonly [number, number] };
  readonly ties: readonly number[];
};

const DROPS = [0.86, 0.94, 0.8, 0.9, 0.84, 0.92] as const;

export function monthsScene(months: number): MonthsScene {
  if (!Number.isInteger(months) || months < 1) throw new RangeError(`an offer lasts at least one month, not ${months}`);
  const width = 720;
  const height = 214;
  const rope = 30;
  const columns = Math.max(months + 2, 5);
  const step = (width - 40) / columns;
  const x0 = 20;
  const sails: MonthSail[] = [];
  for (let i = 0; i < months; i += 1) {
    const a = x0 + i * step + 4;
    const b = a + step - 8;
    const bottom = rope + (height - rope - 26) * (DROPS[i % DROPS.length] ?? 0.86);
    const sag = 16 + (i % 3) * 5;
    const middle = (rope + bottom) / 2;
    sails.push({
      a,
      b,
      bottom,
      hem: [a, b],
      path: `M${f1(a)} ${rope}L${f1(b)} ${rope}Q${f1(b - 5)} ${f1(middle)} ${f1(b)} ${f1(bottom)}`
        + `Q${f1((a + b) / 2)} ${f1(bottom - sag)} ${f1(a)} ${f1(bottom)}Q${f1(a + 5)} ${f1(middle)} ${f1(a)} ${rope}Z`,
    });
  }
  const la = x0 + months * step + 4;
  const lb = width;
  const lbottom = rope + (height - rope - 26) * 0.62;
  const list = {
    hem: [la, lb] as const,
    path: `M${f1(la)} ${rope}L${lb} ${rope}L${lb} ${f1(lbottom)}Q${f1((la + lb) / 2)} ${f1(lbottom - 10)} ${f1(la)} ${f1(lbottom + 4)}`
      + `Q${f1(la + 5)} ${f1((rope + lbottom) / 2)} ${f1(la)} ${rope}Z`,
  };
  const ties = Array.from({ length: months + 1 }, (_, i) => x0 + i * step);
  return { width, height, rope, columns, sails, list, ties };
}

// ---------------------------------------------------------------------------
// The canopy: where a month of money goes, as sails tied along one rope from
// zero to the largest figure. Widths are the amounts. Two sails that overlap
// show the overlap as their product (the chord): the artists' sail and the
// service's top-up overlap by exactly the top-up.

export type CanopyPart = { readonly from: bigint; readonly to: bigint; readonly dye: Dye };

export type CanopySail = {
  readonly dye: Dye;
  readonly path: string;
  readonly hem: readonly [number, number];
  /** The corner ties, when the sail is wide enough to show them. */
  readonly guys: readonly (readonly [number, number])[];
};

export type Canopy = {
  readonly width: number;
  readonly height: number;
  readonly rope: number;
  readonly ropeFrom: number;
  readonly ropeTo: number;
  readonly sails: readonly CanopySail[];
  readonly joints: readonly number[];
  /** Where the cord of the minimum hangs, when one is given. */
  readonly cord: number | null;
};

export function canopy(parts: readonly CanopyPart[], max: bigint, options: { readonly minimum?: bigint; readonly width?: number; readonly height?: number } = {}): Canopy {
  if (max <= 0n) throw new RangeError("a canopy needs a positive length");
  const width = options.width ?? 640;
  const height = options.height ?? 118;
  const padX = 12;
  const rope = 14;
  const usable = width - padX * 2;
  // Minor units are integers, and well inside a double's exact range for a month's money.
  const x = (value: bigint) => padX + (Number(value) / Number(max)) * usable;
  const drop: Record<Dye, number> = { madder: height - 30, saffron: height - 50, indigo: height - 58 };
  const sails: CanopySail[] = [];
  for (const part of parts) {
    if (part.to <= part.from) continue;
    const a = x(part.from);
    const b = x(part.to);
    const bottom = rope + drop[part.dye];
    const w = b - a;
    const sag = Math.min(11, Math.max(2, w * 0.07));
    const side = Math.min(3, w * 0.06);
    const middle = (rope + bottom) / 2;
    sails.push({
      dye: part.dye,
      hem: [a, b],
      guys: w > 18 ? [[a, bottom], [b, bottom]] : [],
      path: `M${f1(a)} ${rope}L${f1(b)} ${rope}Q${f1(b - side)} ${f1(middle)} ${f1(b)} ${f1(bottom)}`
        + `Q${f1((a + b) / 2)} ${f1(bottom - sag * 2)} ${f1(a)} ${f1(bottom)}Q${f1(a + side)} ${f1(middle)} ${f1(a)} ${rope}Z`,
    });
  }
  const joints = [...new Set(sails.flatMap((sail) => [sail.hem[0], sail.hem[1]]).map((value) => Math.round(value * 10) / 10))];
  const cord = options.minimum !== undefined && options.minimum > 0n ? x(options.minimum) : null;
  return { width, height, rope, ropeFrom: padX - 8, ropeTo: x(max) + 8, sails, joints, cord };
}
