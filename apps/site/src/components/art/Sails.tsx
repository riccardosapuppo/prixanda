// The two drawings of a campaign page, from geometry.ts: the months of the
// offer as sails, and the canopy of where the money goes. Each sail is its
// dye's pigment multiplied over the stone inside an isolated group, so two
// sails that overlap show their product. The drawings are decorative: the
// figures they stand for are always written next to them.
import { COLOR } from "design";
import type { Canopy, Dye, MonthsScene } from "./geometry.ts";

const PIGMENT: Record<Dye, string> = { madder: COLOR["pig-madder"], saffron: COLOR["pig-saffron"], indigo: COLOR["pig-indigo"] };
const DEEP: Record<Dye, string> = { madder: COLOR.madder, saffron: COLOR.saffron, indigo: COLOR.indigo };
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
  return (
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false" className="block h-auto w-full overflow-visible">
      <g style={{ isolation: "isolate" }}>
        {canopy.sails.map((sail) => <path key={`${sail.dye}-${sail.path}`} d={sail.path} fill={PIGMENT[sail.dye]} style={multiply} />)}
      </g>
      {canopy.sails.flatMap((sail) => sail.guys.map(([x, y], index) => (
        <g key={`${sail.dye}-guy-${index}`}>
          <path d={index === 0 ? `M${x} ${y}l-5 9` : `M${x} ${y}l5 9`} stroke={DEEP[sail.dye]} strokeWidth={1} />
          <circle cx={x} cy={y} r={2} fill={COLOR.stone} stroke={DEEP[sail.dye]} strokeWidth={1} />
        </g>
      )))}
      <line x1={canopy.ropeFrom} y1={rope} x2={canopy.ropeTo} y2={rope} stroke={COLOR.ink} strokeWidth={1.3} />
      {canopy.sails.map((sail) => (
        <line key={`${sail.dye}-hem`} x1={sail.hem[0]} y1={rope} x2={sail.hem[1]} y2={rope} stroke={DEEP[sail.dye]} strokeWidth={2.4} />
      ))}
      {canopy.cord !== null ? <line x1={canopy.cord} y1={2} x2={canopy.cord} y2={height - 2} stroke={DEEP.madder} strokeWidth={2} /> : null}
      {canopy.joints.map((x) => <circle key={x} cx={x} cy={rope} r={3.2} fill={COLOR.stone} stroke={COLOR.ink} strokeWidth={1.3} />)}
    </svg>
  );
}
