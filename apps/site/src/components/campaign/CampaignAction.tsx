"use client";
// The campaign's action: the button opens the steps of taking the offer in
// its place, and Back closes them and gives the focus back to the button.
import { Icon } from "design/icon";
import { useRef, useState } from "react";
import { copy } from "../../content/copy.ts";
import type { Offer } from "../../data/hooks.ts";
import type { SiteMarket } from "../../data/markets.ts";
import { Named } from "../ui/States.tsx";
import { Checkout } from "./Checkout.tsx";

export function CampaignAction({ offer, market, marketName, planName }: {
  readonly offer: Offer;
  readonly market: SiteMarket;
  readonly marketName: string | null;
  readonly planName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const cta = useRef<HTMLButtonElement>(null);
  const label = offer.needsStudentCheck ? copy.campaign.checkStudent : copy.campaign.take(planName ?? offer.plan);
  const named = offer.needsStudentCheck || planName !== null;

  if (open) {
    return (
      <Checkout
        target={{
          plan: offer.plan,
          planName: planName ?? offer.plan,
          market,
          marketName: marketName ?? market,
          offer: { id: offer.id, title: offer.title, audience: offer.audience },
          needsStudentCheck: offer.needsStudentCheck,
          listPrice: offer.listPrice,
        }}
        onClose={() => {
          setOpen(false);
          requestAnimationFrame(() => cta.current?.focus());
        }}
      />
    );
  }
  return (
    <div className="mt-2 grid justify-items-start gap-3">
      <button ref={cta} type="button" className="btn btn-primary btn-big cta" onClick={() => setOpen(true)}>
        <Named ready={named}>{label}</Named>
        <Icon name="arrow-right" size={20} />
      </button>
    </div>
  );
}
