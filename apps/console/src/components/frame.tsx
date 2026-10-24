"use client";
// The console's frame: the indigo rail with a predictable navigation, the
// demo person and what their role may do, and the head of each page with its
// title and the time the figures are read at. Pages that need a session wait
// for it here; without one they send the person to the demonstration entry.
import { BRAND, DISCLAIMER } from "design";
import { Icon } from "design/icon";
import type { IconName } from "design";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useId, useState } from "react";
import { PeopleDocument } from "../graphql/generated.ts";
import { primaryRole, ROLE_NAME, TEAM } from "../lib/permissions.ts";
import { useMinute } from "../lib/react/clock.tsx";
import { useGatewayQuery } from "../lib/react/gateway.tsx";
import { useSession } from "../lib/react/session.tsx";
import { nowLabel } from "../lib/time.ts";
import { ErrorPanel, SimulatedTag, Skeleton } from "./ui.tsx";

/** Where the team works: the console writes "now" in Rome, where the service has its office. */
export const CONSOLE_ZONE = "Europe/Rome";

export type Section = "home" | "campaigns" | "approvals" | "price-list" | "launches" | "audit";

const NAV: readonly { readonly section: Section; readonly label: string; readonly href: string; readonly icon: IconName }[] = [
  { section: "home", label: "Home", href: "/", icon: "house" },
  { section: "campaigns", label: "Campaigns", href: "/campaigns/", icon: "megaphone" },
  { section: "approvals", label: "Approvals", href: "/approvals/", icon: "seal-check" },
  { section: "price-list", label: "Price list", href: "/price-list/", icon: "tag" },
  { section: "launches", label: "Launches", href: "/launches/", icon: "rocket-launch" },
  { section: "audit", label: "Audit log", href: "/audit/", icon: "scroll" },
];

export function Frame({ section, children }: { readonly section: Section; readonly children: ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (session.status === "signed-out") {
      const here = `${pathname}${typeof window === "undefined" ? "" : window.location.search}`;
      router.replace(`/sign-in/?next=${encodeURIComponent(here)}`);
    }
  }, [pathname, router, session.status]);

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[14.5rem_minmax(0,1fr)]">
      <a className="skip" href="#main">Skip to the page</a>
      <Rail section={section} />
      <main id="main" tabIndex={-1} className="flex min-w-0 flex-col focus-visible:outline-none">
        {session.status === "signed-in" ? children : session.status === "error" ? (
          <div className="p-6"><ErrorPanel error={session.error} retry={() => window.location.reload()} /></div>
        ) : (
          <div className="grid gap-6 p-6" aria-busy="true">
            <p className="sr-only" role="status">Loading the demo session</p>
            <Skeleton lines={2} className="max-w-xl" />
            <Skeleton lines={6} />
          </div>
        )}
      </main>
    </div>
  );
}

function Rail({ section }: { readonly section: Section }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const navId = useId();
  const roleId = useId();
  const people = useGatewayQuery(PeopleDocument, {}, { staleTime: 5 * 60_000 });
  const viewer = session.viewer;
  const role = viewer ? primaryRole(viewer.roles) : null;

  return (
    <header className="rail">
      <div className="flex flex-row flex-wrap items-center gap-3 px-4 py-3 lg:sticky lg:top-0 lg:max-h-screen lg:min-h-screen lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-6 lg:overflow-y-auto lg:px-3 lg:py-6">
        <p className="grid gap-0.5 lg:px-2.5">
          <span className="font-archivo text-3xl font-bold leading-tight tracking-[-0.015em] [font-stretch:125%]">{BRAND.platform}</span>
          <span className="text-xs text-rail-ink-2">{BRAND.service}</span>
        </p>
        <button
          type="button"
          className="btn btn--small ml-auto border-rail-ink-2 bg-transparent text-rail-ink lg:hidden"
          aria-expanded={open}
          aria-controls={navId}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="list" size={18} />
          Menu
        </button>
        <nav id={navId} aria-label={BRAND.platform} className={`${open ? "block" : "hidden"} w-full lg:block`}>
          <ul role="list" className="grid gap-0.5">
            {NAV.map((item) => (
              <li key={item.section}>
                <Link className="rail-link" href={item.href} {...(item.section === section ? { "aria-current": "page" as const } : {})} onClick={() => setOpen(false)}>
                  <Icon name={item.icon} size={18} />
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="order-2 grid w-full gap-2 border-t border-rail-line pt-3 lg:order-none lg:mt-auto lg:px-2.5 lg:pt-4">
          <label htmlFor={roleId} className="text-xs text-rail-ink-2">Signed in as</label>
          <select
            id={roleId}
            className="rail-select"
            value={viewer?.personId ?? ""}
            disabled={session.busy || viewer === null}
            aria-describedby={`${roleId}-can`}
            onChange={(event) => void session.signIn(event.target.value)}
          >
            {viewer && !people.data ? <option value={viewer.personId}>{viewer.label}</option> : null}
            {(people.data?.people ?? []).map((person) => (
              <option key={person.id} value={person.id}>{person.label}</option>
            ))}
          </select>
          <p id={`${roleId}-can`} className={`${open ? "block" : "hidden"} text-xs leading-snug text-rail-ink-2 lg:block`}>
            Demo entry by role, not a login.
            {role ? (
              <>
                {" "}<b className="font-semibold text-rail-ink">Can</b> {TEAM.roles[role].can}. <b className="font-semibold text-rail-ink">Cannot</b> {TEAM.roles[role].cannot}.
              </>
            ) : null}
          </p>
          <div className={`${open ? "flex" : "hidden"} flex-wrap items-center gap-2 lg:flex`}>
            <button type="button" className="rail-link min-h-9 w-auto px-0 text-xs underline underline-offset-4" onClick={() => void session.signOut()}>
              <Icon name="sign-out" size={16} />
              Leave the demo
            </button>
          </div>
          <p className={`${open ? "block" : "hidden"} text-2xs leading-snug text-rail-ink-2 lg:block`}>{DISCLAIMER}</p>
          {role ? <span className="sr-only">Acting as {ROLE_NAME[role]}</span> : null}
        </div>
      </div>
    </header>
  );
}

export type Crumb = { readonly label: string; readonly href?: string };

export function PageHead({ title, sub, crumbs = [], simulated = false, actions }: {
  readonly title: ReactNode;
  readonly sub?: ReactNode;
  readonly crumbs?: readonly Crumb[];
  readonly simulated?: boolean;
  readonly actions?: ReactNode;
}) {
  const now = useMinute();
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-cord px-4 pt-4 pb-4 md:px-6 2xl:px-8">
      <div className="grid min-w-0 gap-1">
        {crumbs.length ? (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} className="flex gap-1.5">
                {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
                {index < crumbs.length - 1 ? <span aria-hidden="true">/</span> : null}
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className="page-title">{title}</h1>
        {sub ? <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-md text-ink-2">{sub}</div> : null}
      </div>
      <div className="grid justify-items-start gap-1.5 md:ml-auto md:justify-items-end">
        {actions}
        {simulated ? <SimulatedTag /> : null}
        <p className="inline-flex items-center gap-1.5 text-xs text-ink-2">
          <Icon name="clock" size={15} />
          {nowLabel(now, CONSOLE_ZONE)}
        </p>
      </div>
    </div>
  );
}

/** The body of a page, with the console's gutters. */
export function PageBody({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={["grid grid-cols-1 gap-8 px-4 pt-6 pb-16 md:px-6 2xl:px-8", className ?? ""].join(" ")}>{children}</div>;
}
