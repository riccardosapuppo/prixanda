import type { Metadata } from "next";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { Wizard } from "../../../features/wizard/wizard.tsx";

export const metadata: Metadata = { title: "New campaign" };

export default function NewCampaignPage() {
  return (
    <Frame section="campaigns">
      <Suspense>
        <Wizard changeId={null} />
      </Suspense>
    </Frame>
  );
}
