import type { Metadata } from "next";
import { Frame } from "../../components/frame.tsx";
import { PassesScreen } from "../../features/campaigns/list.tsx";

export const metadata: Metadata = { title: "Prepaid passes" };

export default function PassesPage() {
  return (
    <Frame section="passes">
      <PassesScreen />
    </Frame>
  );
}
