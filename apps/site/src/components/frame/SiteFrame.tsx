// The frame of every page: a skip link, the pair that says what this site is
// (a personal project, simulated data), the header with the service's
// wordmark, and the footer's one sentence. The disclaimer about payments is
// not repeated here: it stands where a visitor could take a step for a
// purchase, and only there.
import { Icon } from "design/icon";
import Link from "next/link";
import type { ReactNode } from "react";
import { copy } from "../../content/copy.ts";
import { HeaderLinks } from "./HeaderLinks.tsx";

export function ProjectTags() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="tag">
        <Icon name="info" size={14} />
        {copy.frame.project}
      </span>
      <span className="tag tag-simulated">
        <Icon name="flask" size={14} />
        {copy.frame.simulated}
      </span>
    </div>
  );
}

function Wordmark({ label }: { readonly label?: string }) {
  return (
    <Link
      href="/"
      className="text-ink no-underline [font-stretch:125%] text-[1.5rem] leading-none font-[760] tracking-[-0.02em]"
      {...(label ? { "aria-label": label } : {})}
    >
      {copy.service}
    </Link>
  );
}

export function SiteFrame({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="absolute left-4 -top-24 z-60 rounded-control bg-ink px-4 py-2 text-stone-0 focus:top-2"
      >
        {copy.nav.skip}
      </a>
      <div className="border-b border-cord bg-stone-0">
        <div className="wrap py-[0.4rem]">
          <ProjectTags />
        </div>
      </div>
      <header className="border-b border-cord">
        <div className="wrap flex min-h-[4.25rem] items-center gap-8 max-md:min-h-[3.75rem] max-md:gap-3">
          <Wordmark />
          <HeaderLinks />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 focus-visible:outline-none">
        {children}
      </main>
      <footer className="border-t border-ink bg-stone-0">
        <div className="wrap grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-8 gap-y-4 py-8 max-md:grid-cols-1">
          <Wordmark label={`${copy.service}: ${copy.nav.plans.toLowerCase()}`} />
          <p className="m-0 max-w-[72ch] text-md text-ink-2">{copy.frame.footer}</p>
        </div>
      </footer>
    </>
  );
}
