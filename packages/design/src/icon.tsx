// An icon of the shared set, drawn in currentColor. Decorative by default
// (hidden from assistive technology): the words next to it carry the meaning.
// With a label it becomes an image with that name.
import type { SVGProps } from "react";
import { ICONS, type IconName } from "./icons.ts";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  readonly name: IconName;
  /** In pixels; 16 when absent. */
  readonly size?: number;
  /** Set it only when the icon stands alone and means something. */
  readonly label?: string;
};

export function Icon({ name, size = 16, label, className, ...rest }: IconProps) {
  const labelled = label !== undefined && label !== "";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill="currentColor"
      focusable="false"
      className={["icon", className].filter(Boolean).join(" ")}
      {...(labelled ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...rest}
    >
      {ICONS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
