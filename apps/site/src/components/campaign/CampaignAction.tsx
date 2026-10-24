"use client";
// The campaign's action: the button opens the steps of taking the offer in
// its place, and Back closes them and gives the focus back to the button.
import { Icon } from "design/icon";
import { useRef, useState } from "react";
import { copy } from "../../content/copy.ts";
import type { Offer } from "../../data/hooks.ts";
import type { SiteMarket } from "../../data/markets.ts";
import { Checkout } from "./Checkout.tsx";

export function CampaignAction({ offer, market, planName }: { readonly offer: Offer; readonly market: SiteMarket; readonly planName: string }) {
  const [open, setOpen] = useState(false);
  const cta = useRef<HTMLButtonElement>(null);
  const label = offer.needsStudentCheck ? copy.campaign.checkStudent : copy.campaign.take(planName);

  if (open) {
    return (
      <Checkout
        offer={offer}
        market={market}
        planName={planName}
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
        {label}
        <Icon name="arrow-right" size={20} />
      </button>
    </div>
  );
}
