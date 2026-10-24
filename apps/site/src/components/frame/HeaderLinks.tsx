"use client";
// The header's links: the plans, the records and the listening sessions of
// the home, and the account. On a phone they fold behind a Menu button.
import { Icon } from "design/icon";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { copy } from "../../content/copy.ts";

export function HeaderLinks() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const onHome = pathname === "/";
  const onAccount = pathname.startsWith("/account");

  // A link followed closes the menu.
  useEffect(() => setOpen(false), [pathname]);

  const links: { href: Route; label: string; current: boolean }[] = [
    { href: "/" as Route, label: copy.nav.plans, current: onHome },
    { href: "/#releases" as Route, label: copy.nav.releases, current: false },
    { href: "/#sessions" as Route, label: copy.nav.sessions, current: pathname.startsWith("/session") },
  ];
  return (
    <>
      <nav aria-label={copy.nav.label} id="site-nav" className={open ? "site-nav is-open" : "site-nav"}>
        <ul role="list">
          {links.map((link) => (
            <li key={link.href}>
              <Link href={link.href} {...(link.current ? { "aria-current": "page" as const } : {})} onClick={() => setOpen(false)}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <Link
          href={"/account/" as Route}
          {...(onAccount ? { "aria-current": "page" as const } : {})}
          className="inline-flex min-h-11 items-center gap-[0.45rem] rounded-control border border-edge px-3 font-semibold text-ink no-underline hover:bg-stone-2 aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-stone-0"
        >
          <Icon name="user-circle" size={20} />
          <span className="max-md:sr-only">{copy.nav.account}</span>
        </Link>
        <button type="button" className="btn menu-toggle" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen((was) => !was)}>
          <Icon name="list" size={18} />
          {copy.nav.menu}
        </button>
      </div>
    </>
  );
}
