// A record's cover, drawn from covers.ts. Its words (artist and title) are
// part of the image: the cover is an image with a name that says what it is,
// and the same words are always written in text beside it.
import { COLOR } from "design";
import { type ReactNode, useId } from "react";
import { type CoverArt, coverArt, type Shape } from "./covers.ts";

const DESCRIBE: Readonly<Record<CoverArt["technique"], string>> = {
  linocut: "a linocut",
  pochoir: "a pochoir",
  scraperboard: "a scraperboard",
  cyanotype: "a cyanotype",
};

type CoverRecord = { readonly seed: number; readonly artist: string; readonly title: string; readonly label: string };

function draw(shape: Shape, clipId: string, key: string): ReactNode {
  switch (shape.kind) {
    case "path":
      return (
        <path
          key={key}
          d={shape.d}
          fill={shape.fill ?? "none"}
          {...(shape.stroke ? { stroke: shape.stroke, strokeWidth: shape.strokeWidth } : {})}
          {...(shape.round ? { strokeLinecap: "round" as const, strokeLinejoin: "round" as const } : {})}
          {...(shape.dash ? { strokeDasharray: shape.dash } : {})}
          {...(shape.opacity !== undefined ? { opacity: shape.opacity } : {})}
          {...(shape.transform ? { transform: shape.transform } : {})}
          {...(shape.clipped ? { clipPath: `url(#${clipId})` } : {})}
        />
      );
    case "circle":
      return <circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} fill={shape.fill} {...(shape.opacity !== undefined ? { opacity: shape.opacity } : {})} />;
    case "rect":
      return <rect key={key} x={shape.x} y={shape.y} width={shape.width} height={shape.height} fill={shape.fill} />;
    case "ellipse":
      return (
        <ellipse
          key={key}
          cx={shape.cx}
          cy={shape.cy}
          rx={shape.rx}
          ry={shape.ry}
          fill={shape.fill}
          transform={shape.transform}
          {...(shape.clipped ? { clipPath: `url(#${clipId})` } : {})}
        />
      );
    case "group":
      return <g key={key} transform={shape.transform}>{shape.shapes.map((inner, index) => draw(inner, clipId, `${key}-${index}`))}</g>;
  }
}

function Print({ art, clipId }: { readonly art: CoverArt; readonly clipId: string }) {
  return (
    <>
      <rect width="100" height="100" fill={art.ground} />
      {art.clip ? (
        <defs>
          <clipPath id={clipId}>
            <path d={art.clip} />
          </clipPath>
        </defs>
      ) : null}
      {art.shapes.map((shape, index) => draw(shape, clipId, `s${index}`))}
      {art.grain.map((shape, index) => draw(shape, clipId, `g${index}`))}
    </>
  );
}

function Words({ art, artist, title }: { readonly art: CoverArt; readonly artist: string; readonly title: string }) {
  const ink = art.ink;
  switch (art.words) {
    case "bottom":
      return (
        <>
          <text x="6" y="88" fontSize="6.6" fontWeight="760" style={{ fontStretch: "112%" }} fill={ink}>{artist}</text>
          <text x="6" y="95.5" fontSize="5.8" fontStyle="italic" fill={ink}>{title}</text>
        </>
      );
    case "top":
      return (
        <>
          <text x="50" y="11" textAnchor="middle" fontSize="6" fontWeight="300" style={{ fontStretch: "125%" }} fill={ink}>{artist}</text>
          <text x="50" y="93" textAnchor="middle" fontSize="5.8" fontStyle="italic" fill={ink}>{title}</text>
        </>
      );
    case "strip":
      return (
        <>
          <text x="7" y="90" fontSize="6.2" fontWeight="700" fill={ink}>{artist}</text>
          <text x="93" y="90" textAnchor="end" fontSize="5.8" fontStyle="italic" fill={ink}>{title}</text>
        </>
      );
    default: {
      const left = art.words === "dark-left";
      const x = left ? 6 : 94;
      const anchor = left ? "start" : "end";
      return (
        <>
          <text x={x} y="13" textAnchor={anchor} fontSize="5.8" fontWeight="400" style={{ fontStretch: "112%" }} fill={ink}>{artist}</text>
          <text x={x} y="20" textAnchor={anchor} fontSize="5.4" fontStyle="italic" fill={ink}>{title}</text>
        </>
      );
    }
  }
}

/**
 * The cover of a record, as an image named for what it shows; decorative
 * (hidden from assistive technology) where the record's words stand right
 * next to it and the image would only say them again.
 */
export function Cover({ record, className, words = true, decorative = false }: {
  readonly record: CoverRecord;
  readonly className?: string;
  readonly words?: boolean;
  readonly decorative?: boolean;
}) {
  const art = coverArt(record);
  const clipId = `cover-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const label = `Cover of ${record.title} by ${record.artist}: ${DESCRIBE[art.technique]} in the ${record.label} house style, generated from its seed`;
  const named = decorative ? { "aria-hidden": true as const, focusable: "false" as const } : { role: "img", "aria-label": label };
  return (
    <svg viewBox="0 0 100 100" {...named} className={className} style={{ fontFamily: "var(--font-archivo)" }}>
      <Print art={art} clipId={clipId} />
      {words ? <Words art={art} artist={record.artist} title={record.title} /> : null}
    </svg>
  );
}

/** A label's records as sleeves fanned like records in a crate; decorative, without words. */
export function Sleeves({ records, className }: { readonly records: readonly CoverRecord[]; readonly className?: string }) {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const n = records.length;
  const dx = 38;
  const dy = 6;
  const width = 100 + dx * (n - 1);
  const height = 100 + dy * (n - 1);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false" className={className}>
      {records.map((record, index) => ({ record, index })).reverse().map(({ record, index }) => (
        <svg key={record.seed} x={(n - 1 - index) * dx} y={index * dy} width="100" height="100" viewBox="0 0 100 100" overflow="hidden">
          <Print art={coverArt(record)} clipId={`sleeve-${base}-${index}`} />
          <rect x="0.25" y="0.25" width="99.5" height="99.5" fill="none" stroke={COLOR.cord} strokeWidth="0.5" />
        </svg>
      ))}
    </svg>
  );
}
