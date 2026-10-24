"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { Wizard } from "../../../features/wizard/wizard.tsx";

function EditCampaign() {
  const id = useSearchParams().get("id");
  return <Wizard changeId={id && /^\d+$/.test(id) ? id : "0"} />;
}

export default function EditCampaignPage() {
  return (
    <Frame section="campaigns">
      <Suspense>
        <EditCampaign />
      </Suspense>
    </Frame>
  );
}
