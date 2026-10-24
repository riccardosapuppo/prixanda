// The console's small vocabulary, shared by every screen: buttons, labels,
// states, callouts, the locked line that says why an action is not offered,
// errors, loading shapes and empty states.
import { formatCount, formatMoney, type MoneyLike, SIMULATED_LABEL } from "design";
import { Icon } from "design/icon";
import type { IconName } from "design";
import Link from "next/link";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { explain } from "../lib/gateway.ts";

type Weight = "default" | "primary" | "quiet";

function buttonClass(weight: Weight, size: "normal" | "small" | "big", extra?: string): string {
  return ["btn", weight === "primary" ? "btn--primary" : weight === "quiet" ? "btn--quiet" : "", size === "small" ? "btn--small" : size === "big" ? "btn--big" : "", extra ?? ""]
    .filter(Boolean)
    .join(" ");
}

export type ButtonProps = ComponentPropsWithRef<"button"> & {
  readonly weight?: Weight;
  readonly size?: "normal" | "small" | "big";
  readonly icon?: IconName;
  readonly iconAfter?: IconName;
  readonly busy?: boolean;
};

export function Button({ weight = "default", size = "normal", icon, iconAfter, busy = false, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClass(weight, size, className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {icon ? <Icon name={busy ? "circle-notch" : icon} size={18} /> : null}
      {children}
      {iconAfter ? <Icon name={iconAfter} size={18} /> : null}
    </button>
  );
}

export function ButtonLink({ href, weight = "default", size = "normal", icon, iconAfter, children, className }: {
  readonly href: string;
  readonly weight?: Weight;
  readonly size?: "normal" | "small" | "big";
  readonly icon?: IconName;
  readonly iconAfter?: IconName;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <Link href={href} className={buttonClass(weight, size, className)}>
      {icon ? <Icon name={icon} size={18} /> : null}
      {children}
      {iconAfter ? <Icon name={iconAfter} size={18} /> : null}
    </Link>
  );
}

/** The label every simulated figure carries (§13.3). */
export function SimulatedTag({ children = SIMULATED_LABEL }: { readonly children?: ReactNode }) {
  return (
    <span className="tag tag--sim">
      <Icon name="flask" size={14} />
      {children}
    </span>
  );
}

export const STATE_LOOK: Readonly<Record<string, { readonly word: string; readonly look: string; readonly icon: IconName }>> = {
  DRAFT: { word: "Draft", look: "state--draft", icon: "pencil-simple" },
  VALIDATED: { word: "Checked, not submitted", look: "state--draft", icon: "check" },
  IN_APPROVAL: { word: "In approval", look: "state--waiting", icon: "hourglass-medium" },
  APPROVED: { word: "Approved", look: "state--approved", icon: "seal-check" },
  SCHEDULED: { word: "Scheduled", look: "state--scheduled", icon: "calendar-check" },
  ACTIVE: { word: "Live", look: "state--live", icon: "check-circle" },
  ENDED: { word: "Ended", look: "state--ended", icon: "circle-dashed" },
  SUSPENDED: { word: "Suspended", look: "state--stopped", icon: "pause" },
  CANCELLED: { word: "Cancelled", look: "state--ended", icon: "x-circle" },
};

/** A change's state: a word, an icon and an edge, never the colour alone. */
export function StateChip({ state, children }: { readonly state: string; readonly children?: ReactNode }) {
  const look = STATE_LOOK[state] ?? { word: state.toLowerCase(), look: "state--draft", icon: "info" as const };
  return (
    <span className={`state ${look.look}`}>
      <Icon name={look.icon} size={15} />
      {children ?? look.word}
    </span>
  );
}

/** A chip of any other kind: waiting for a role, rejected, done. */
export function Chip({ look, icon, children }: { readonly look: "waiting" | "rejected" | "done" | "approved" | "draft" | "ended"; readonly icon: IconName; readonly children: ReactNode }) {
  return (
    <span className={`state state--${look}`}>
      <Icon name={icon} size={15} />
      {children}
    </span>
  );
}

export function Callout({ tone = "plain", icon, children, className, role }: {
  readonly tone?: "plain" | "quiet" | "error" | "good";
  readonly icon: IconName;
  readonly children: ReactNode;
  readonly className?: string;
  readonly role?: "status" | "alert";
}) {
  const toneClass = tone === "plain" ? "" : `callout--${tone}`;
  return (
    <div className={["callout", toneClass, className ?? ""].filter(Boolean).join(" ")} {...(role ? { role } : {})}>
      <Icon name={icon} size={18} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Where an action would be, for a role that cannot do it: a lock and the reason, never a button that would be refused. */
export function Locked({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <p className={["locked", className ?? ""].filter(Boolean).join(" ")} data-locked="">
      <Icon name="lock-simple" size={18} />
      <span className="py-1.5 font-semibold">{children}</span>
    </p>
  );
}

export function FieldError({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <p className="field-error" id={id}>
      <Icon name="warning-circle" size={16} />
      <span>{children}</span>
    </p>
  );
}

/** A request that failed: what happened, what to do, and the request id to find it in the gateway's log. */
export function ErrorPanel({ error, retry, className }: { readonly error: unknown; readonly retry?: () => void; readonly className?: string }) {
  const said = explain(error);
  return (
    <Callout tone="error" icon="warning" role="alert" {...(className ? { className } : {})}>
      <p className="font-bold">{said.title}</p>
      <p>{said.detail}</p>
      {said.requestId ? <p className="hint mt-1">Request id {said.requestId}</p> : null}
      {retry ? (
        <Button size="small" icon="arrows-clockwise" className="mt-2" onClick={retry}>
          Try again
        </Button>
      ) : null}
    </Callout>
  );
}

/** A still shape where the content will be: no spinner over the page, and the layout does not jump when it arrives. */
export function Skeleton({ lines = 3, className }: { readonly lines?: number; readonly className?: string }) {
  return (
    <div className={["grid gap-2", className ?? ""].join(" ")} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="skeleton h-4" style={{ width: `${92 - ((index * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

/** Loading, said once for assistive technology, shown as still shapes. */
export function Loading({ what, lines = 4 }: { readonly what: string; readonly lines?: number }) {
  return (
    <div aria-busy="true">
      <p className="sr-only" role="status">Loading {what}</p>
      <Skeleton lines={lines} />
    </div>
  );
}

export function Empty({ icon = "info", children }: { readonly icon?: IconName; readonly children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-3 text-ink-2">
      <Icon name={icon} size={18} className="mt-0.5 text-indigo" />
      <div>{children}</div>
    </div>
  );
}

/** An amount the way the console writes every amount: €1,877.51, with a real minus sign. */
export function Money({ value, className }: { readonly value: MoneyLike | null | undefined; readonly className?: string }) {
  if (value === null || value === undefined) return <span className={className}>none</span>;
  return <span className={["whitespace-nowrap", className ?? ""].join(" ")}>{formatMoney(value)}</span>;
}

export function Count({ value, className }: { readonly value: number; readonly className?: string }) {
  return <span className={className}>{formatCount(value)}</span>;
}
