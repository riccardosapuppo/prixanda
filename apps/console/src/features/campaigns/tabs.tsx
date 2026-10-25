"use client";
// The views of one change, by its kind: a campaign is written, simulated and
// approved; a price migration also has its progress, once its requests went
// out (§8); a prepaid pass is written and approved (§9).
import { Icon } from "design/icon";
import type { IconName } from "design";
import Link from "next/link";
import { type ChangeKind, kindOf } from "../../lib/kinds.ts";

export type ChangeTab = "edit" | "simulation" | "approval" | "progress";
export type CampaignTab = "campaign" | "simulation" | "approval";

type Tab = { readonly id: ChangeTab; readonly label: string; readonly icon: IconName; readonly path: string };

const TABS: Readonly<Record<string, readonly Tab[]>> = {
  OFFER: [
    { id: "edit", label: "Campaign", icon: "pen-nib", path: "/campaigns/edit/" },
    { id: "simulation", label: "Simulation", icon: "calculator", path: "/campaigns/simulation/" },
    { id: "approval", label: "Approval", icon: "seal-check", path: "/campaigns/approval/" },
  ],
  PRICE_MIGRATION: [
    { id: "edit", label: "Migration", icon: "pen-nib", path: "/price-migrations/edit/" },
    { id: "simulation", label: "Simulation", icon: "calculator", path: "/price-migrations/simulation/" },
    { id: "approval", label: "Approval", icon: "seal-check", path: "/price-migrations/approval/" },
    { id: "progress", label: "Progress", icon: "users", path: "/price-migrations/progress/" },
  ],
  PREPAID: [
    { id: "edit", label: "Pass", icon: "pen-nib", path: "/passes/edit/" },
    { id: "approval", label: "Approval", icon: "seal-check", path: "/passes/approval/" },
  ],
};

const APPROVAL_ONLY: readonly Tab[] = [{ id: "approval", label: "Approval", icon: "seal-check", path: "/campaigns/approval/" }];

export function ChangeTabs({ kind, changeId, current }: { readonly kind: ChangeKind | string; readonly changeId: string | null; readonly current: ChangeTab }) {
  const tabs = TABS[kind] ?? APPROVAL_ONLY;
  return (
    <nav aria-label={`This ${kindOf(kind).word.toLowerCase()}`} className="flex flex-wrap gap-1 border-b border-cord">
      {tabs.map((tab) => {
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

/** The three views of a campaign: write it, simulate it, approve it. */
export function CampaignTabs({ changeId, current }: { readonly changeId: string | null; readonly current: CampaignTab }) {
  return <ChangeTabs kind="OFFER" changeId={changeId} current={current === "campaign" ? "edit" : current} />;
}
