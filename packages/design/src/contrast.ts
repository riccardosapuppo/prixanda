// Contrast as WCAG 2.2 measures it: the relative luminance of two sRGB
// colours, and their ratio from 1 to 21. The tests hold every pair of
// tokens.json to the contrast written beside it.

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The relative luminance of a colour written #rrggbb. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new TypeError(`not a colour written #rrggbb: ${hex}`);
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => channel(Number.parseInt(part ?? "0", 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** The contrast ratio of two colours, from 1 to 21. */
export function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}
