import type { Metadata } from "next";
import { Frame } from "../../components/frame.tsx";
import { ApprovalsScreen } from "../../features/campaigns/list.tsx";

export const metadata: Metadata = { title: "Approvals" };

export default function ApprovalsPage() {
  return (
    <Frame section="approvals">
      <ApprovalsScreen />
    </Frame>
  );
}
