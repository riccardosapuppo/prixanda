import type { Metadata } from "next";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { MigrationSimulationScreen } from "../../../features/migration/simulation.tsx";

export const metadata: Metadata = { title: "Simulation of a price migration" };

export default function PriceMigrationSimulationPage() {
  return (
    <Frame section="price-migrations">
      <Suspense>
        <MigrationSimulationScreen />
      </Suspense>
    </Frame>
  );
}
