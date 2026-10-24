import type { Metadata } from "next";
import { Frame } from "../../components/frame.tsx";
import { MigrationsScreen } from "../../features/campaigns/list.tsx";

export const metadata: Metadata = { title: "Price migrations" };

export default function PriceMigrationsPage() {
  return (
    <Frame section="price-migrations">
      <MigrationsScreen />
    </Frame>
  );
}
