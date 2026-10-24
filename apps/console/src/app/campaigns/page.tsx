import type { Metadata } from "next";
import { Frame } from "../../components/frame.tsx";
import { CampaignsScreen } from "../../features/campaigns/list.tsx";

export const metadata: Metadata = { title: "Campaigns" };

export default function CampaignsPage() {
  return (
    <Frame section="campaigns">
      <CampaignsScreen />
    </Frame>
  );
}
