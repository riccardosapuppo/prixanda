import type { Metadata } from "next";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { ApprovalScreen } from "../../../features/approval/approval.tsx";

export const metadata: Metadata = { title: "Approval of a prepaid pass" };

export default function PassApprovalPage() {
  return (
    <Frame section="approvals">
      <Suspense>
        <ApprovalScreen />
      </Suspense>
    </Frame>
  );
}
