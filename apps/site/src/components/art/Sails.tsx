// The site's drawings of money, from geometry.ts: the months of an offer as
// sails, the canopy of where a price goes, and the promise plan by plan. Each
// sail is its dye's pigment multiplied over the stone inside an isolated
// group, so two sails that overlap show their product. The drawings are
// decorative: the figures they stand for are always written next to them.
import { COLOR } from "design";
import { useId } from "react";
import type { Canopy, MonthsScene, Part, PassScene, PromiseFigure } from "./geometry.ts";

const PIGMENT: Record<Part, string> = {
  madder: COLOR["pig-madder"], saffron: COLOR["pig-saffron"], indigo: COLOR["pig-indigo"], neutral: COLOR["stone-2"],
};
const DEEP: Record<Part, string> = { madder: COLOR.madder, saffron: COLOR.saffron, indigo: COLOR.indigo, neutral: COLOR["ink-3"] };
const multiply = { mixBlendMode: "multiply" } as const;

export function MonthsDrawing({ scene }: { readonly scene: MonthsScene }) {
  const { width, height, rope } = scene;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false" className="block h-auto w-full">
      <g style={{ isolation: "isolate" }}>
        {scene.sails.map((sail) => <path key={sail.path} d={sail.path} fill={PIGMENT.saffron} style={multiply} />)}
        <path d={scene.list.path} fill={PIGMENT.indigo} style={multiply} />
      </g>
      {scene.sails.map((sail) => (
        <g key={`hem-${sail.path}`}>
          <line x1={sail.hem[0]} y1={rope} x2={sail.hem[1]} y2={rope} stroke={DEEP.saffron} strokeWidth={2.6} />
          <path d={`M${sail.a} ${sail.bottom}l-5 12M${sail.b} ${sail.bottom}l5 12`} stroke={DEEP.saffron} strokeWidth={1.2} />
          <circle cx={sail.a} cy={sail.bottom} r={2.4} fill={COLOR.stone} stroke={DEEP.saffron} strokeWidth={1.2} />
          <circle cx={sail.b} cy={sail.bottom} r={2.4} fill={COLOR.stone} stroke={DEEP.saffron} strokeWidth={1.2} />
        </g>
      ))}
      <line x1={scene.list.hem[0]} y1={rope} x2={scene.list.hem[1]} y2={rope} stroke={DEEP.indigo} strokeWidth={2.6} />
      <line x1={4} y1={rope} x2={width} y2={rope} stroke={COLOR.ink} strokeWidth={1.4} />
      {scene.ties.map((x) => <circle key={x} cx={x} cy={rope} r={4.2} fill={COLOR.stone} stroke={COLOR.ink} strokeWidth={1.4} />)}
    </svg>
  );
}

export function CanopyDrawing({ canopy }: { readonly canopy: Canopy }) {
  const { width, height, rope } = canopy;
  const hatch = `hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false" className="block h-auto w-full overflow-visible">
      <defs>
        <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill={COLOR["stone-2"]} />
          <path d="M0 6L6 0" stroke={DEEP.neutral} strokeWidth="0.9" />
        </pattern>
      </defs>
      <g style={{ isolation: "isolate" }}>
        {canopy.sails.map((sail) => sail.dye === "neutral"
          ? <path key={`${sail.dye}-${sail.path}`} d={sail.path} fill={`url(#${hatch})`} stroke={DEEP.neutral} strokeWidth={0.8} />
          : <path key={`${sail.dye}-${sail.path}`} d={sail.path} fill={PIGMENT[sail.dye]} style={multiply} />)}
      </g>
      {canopy.sails.flatMap((sail) => sail.guys.map(([x, y], index) => (
        <g key={`${sail.dye}-guy-${index}`}>
          <path d={index === 0 ? `M${x} ${y}l-5 9` : `M${x} ${y}l5 9`} stroke={DEEP[sail.dye]} strokeWidth={1} />
          <circle cx={x} cy={y} r={2} fill={COLOR.stone} stroke={DEEP[sail.dye]} strokeWidth={1} />
        </g>
      )))}
      <line x1={canopy.ropeFrom} y1={rope} x2={canopy.ropeTo} y2={rope} stroke={COLOR.ink} strokeWidth={1.3} />
      {canopy.sails.filter((sail) => sail.dye !== "neutral").map((sail) => (
        <line key={`${sail.dye}-hem`} x1={sail.hem[0]} y1={rope} x2={sail.hem[1]} y2={rope} stroke={DEEP[sail.dye]} strokeWidth={2.4} />
      ))}
      {canopy.cord !== null ? <line x1={canopy.cord} y1={2} x2={canopy.cord} y2={height - 2} stroke={DEEP.madder} strokeWidth={2} /> : null}
      {canopy.joints.map((x) => <circle key={x} cx={x} cy={rope} r={3.2} fill={COLOR.stone} stroke={COLOR.ink} strokeWidth={1.3} />)}
    </svg>
  );
}

export function PromiseDrawing({ figure }: { readonly figure: PromiseFigure }) {
  const { width, height, rope } = figure;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false" className="block h-auto w-full">
      <line x1={0} y1={rope} x2={width} y2={rope} stroke={COLOR.ink} strokeWidth={1.3} />
      <g style={{ isolation: "isolate" }}>
        {figure.sails.map((sail) => <path key={sail.path} d={sail.path} fill={PIGMENT.madder} style={multiply} />)}
        {figure.sails.map((sail) => (sail.chord ? <path key={`chord-${sail.path}`} d={sail.chord} fill={COLOR["chord-ms"]} /> : null))}
      </g>
      {figure.sails.map((sail) => (
        <g key={`tie-${sail.path}`}>
          <line x1={sail.a} y1={rope} x2={sail.b} y2={rope} stroke={DEEP.madder} strokeWidth={2.6} />
          <path d={`M${sail.a} ${sail.bottom}l-4 9M${sail.b} ${sail.bottom}l4 9`} stroke={DEEP.madder} strokeWidth={1} />
          <circle cx={sail.a} cy={rope} r={3} fill={COLOR.stone} stroke={COLOR.ink} strokeWidth={1.2} />
          <circle cx={sail.b} cy={rope} r={3} fill={COLOR.stone} stroke={COLOR.ink} strokeWidth={1.2} />
        </g>
      ))}
      <line x1={0} y1={figure.cordY} x2={figure.cordTo} y2={figure.cordY} stroke={DEEP.madder} strokeWidth={2} strokeDasharray="7 4" />
    </svg>
  );
}

/** A prepaid pass's months, paid once: saffron sails on a rope that stops, with a dashed end. */
export function PassDrawing({ scene }: { readonly scene: PassScene }) {
  const { width, height, rope, ropeTo } = scene;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false" className="block h-auto w-full">
      <g style={{ isolation: "isolate" }}>
        {scene.sails.map((sail) => <path key={sail.path} d={sail.path} fill={PIGMENT.saffron} style={multiply} />)}
      </g>
      {scene.sails.map((sail) => (
        <line key={`hem-${sail.a}`} x1={sail.a} y1={rope} x2={sail.b} y2={rope} stroke={DEEP.saffron} strokeWidth={2.4} />
      ))}
      <line x1={0} y1={rope} x2={ropeTo} y2={rope} stroke={COLOR.ink} strokeWidth={1.3} />
      {scene.sails.map((sail) => <circle key={`tie-${sail.a}`} cx={sail.a} cy={rope} r={3.2} fill={COLOR.stone} stroke={COLOR.ink} strokeWidth={1.3} />)}
      <circle cx={ropeTo} cy={rope} r={3.2} fill={COLOR.stone} stroke={COLOR.ink} strokeWidth={1.3} />
      <path d={`M${ropeTo + 4} ${rope}h10M${ropeTo + 24} ${rope}h6`} stroke={COLOR.ink} strokeWidth={1.3} strokeDasharray="2 3" />
    </svg>
  );
}

/** A sheet over a period of a subscription, as deep as its price; the free plan leaves the rope bare. */
export function PeriodSheet({ depth, free }: { readonly depth: number; readonly free: boolean }) {
  return (
    <svg className="path-sheet" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {depth > 0 ? <path d={`M0 1H100V${depth.toFixed(2)}Q50 ${(depth - 6).toFixed(2)} 0 ${depth.toFixed(2)}Z`} fill={COLOR["silk-indigo"]} /> : null}
      <line x1={0} y1={1} x2={100} y2={1} stroke={free ? COLOR["ink-2"] : COLOR.indigo} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
