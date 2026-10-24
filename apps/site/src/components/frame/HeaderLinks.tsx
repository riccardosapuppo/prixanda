"use client";
// The header's links, marked as the current page where they lead to it.
import { Icon } from "design/icon";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { copy } from "../../content/copy.ts";

export function HeaderLinks() {
  const pathname = usePathname();
  const onPlans = pathname === "/";
  const onAccount = pathname.startsWith("/account");
  return (
    <>
      <nav aria-label={copy.nav.label}>
        <ul role="list" className="m-0 flex list-none gap-1 p-0">
          <li>
            <Link
              href="/"
              {...(onPlans ? { "aria-current": "page" as const } : {})}
              className="inline-flex min-h-11 items-center rounded-control px-3 text-[0.96875rem] font-[550] text-ink-2 no-underline hover:bg-stone-2 hover:text-ink aria-[current=page]:rounded-none aria-[current=page]:text-ink aria-[current=page]:shadow-[inset_0_-2px_0_var(--color-ink)]"
            >
              {copy.nav.plans}
            </Link>
          </li>
        </ul>
      </nav>
      <Link
        href={"/account/" as Route}
        {...(onAccount ? { "aria-current": "page" as const } : {})}
        className="ml-auto inline-flex min-h-11 items-center gap-[0.45rem] rounded-control border border-edge px-3 font-semibold text-ink no-underline hover:bg-stone-2 aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-stone-0"
      >
        <Icon name="user-circle" size={20} />
        <span className="max-sm:sr-only">{copy.nav.account}</span>
      </Link>
    </>
  );
}
