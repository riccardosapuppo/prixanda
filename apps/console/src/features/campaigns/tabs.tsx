"use client";
// The three views of a campaign: write it, simulate it, approve it.
import { Icon } from "design/icon";
import type { IconName } from "design";
import Link from "next/link";

export type CampaignTab = "campaign" | "simulation" | "approval";

const TABS: readonly { readonly id: CampaignTab; readonly label: string; readonly icon: IconName; readonly path: string }[] = [
  { id: "campaign", label: "Campaign", icon: "pen-nib", path: "/campaigns/edit/" },
  { id: "simulation", label: "Simulation", icon: "calculator", path: "/campaigns/simulation/" },
  { id: "approval", label: "Approval", icon: "seal-check", path: "/campaigns/approval/" },
];

export function CampaignTabs({ changeId, current }: { readonly changeId: string | null; readonly current: CampaignTab }) {
  return (
    <nav aria-label="This campaign" className="flex flex-wrap gap-1 border-b border-cord">
      {TABS.map((tab) => {
        const here = tab.id === current;
        const className = `inline-flex min-h-10 items-center gap-1.5 px-3.5 font-semibold no-underline ${here ? "text-ink shadow-[inset_0_-3px_0_var(--color-ink)]" : "text-ink-2 hover:bg-stone-2 hover:text-ink"}`;
        if (changeId === null && !here) {
          return (
            <span key={tab.id} className={`${className} cursor-not-allowed opacity-80`} title="Save the draft first">
              <Icon name={tab.icon} size={16} />
              {tab.label}
              <span className="sr-only"> (after the first save)</span>
            </span>
          );
        }
        return (
          <Link key={tab.id} href={changeId === null ? tab.path : `${tab.path}?id=${changeId}`} className={className} {...(here ? { "aria-current": "page" as const } : {})}>
            <Icon name={tab.icon} size={16} />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
