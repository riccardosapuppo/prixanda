import type { Metadata } from "next";
import { Frame } from "../../components/frame.tsx";
import { PriceListScreen } from "../../features/pricelist/pricelist.tsx";

export const metadata: Metadata = { title: "Price list" };

export default function PriceListPage() {
  return (
    <Frame section="price-list">
      <PriceListScreen />
    </Frame>
  );
}
