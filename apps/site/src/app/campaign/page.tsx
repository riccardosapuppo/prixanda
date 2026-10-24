import type { Metadata } from "next";
import { Suspense } from "react";
import { CampaignView } from "../../components/campaign/CampaignView.tsx";
import { Loading } from "../../components/ui/States.tsx";

export const metadata: Metadata = { title: "Campaign" };

export default function CampaignPage() {
  return (
    <Suspense fallback={<div className="wrap py-12"><Loading /></div>}>
      <CampaignView />
    </Suspense>
  );
}
