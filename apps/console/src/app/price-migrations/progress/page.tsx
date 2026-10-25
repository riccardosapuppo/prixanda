import type { Metadata } from "next";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { MigrationProgressScreen } from "../../../features/migration/progress.tsx";

export const metadata: Metadata = { title: "Progress of a price migration" };

export default function PriceMigrationProgressPage() {
  return (
    <Frame section="price-migrations">
      <Suspense>
        <MigrationProgressScreen />
      </Suspense>
    </Frame>
  );
}
