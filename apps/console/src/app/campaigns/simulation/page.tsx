import type { Metadata } from "next";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { SimulationScreen } from "../../../features/simulation/simulation.tsx";

export const metadata: Metadata = { title: "Simulation" };

export default function SimulationPage() {
  return (
    <Frame section="campaigns">
      <Suspense>
        <SimulationScreen />
      </Suspense>
    </Frame>
  );
}
