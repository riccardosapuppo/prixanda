import type { Metadata } from "next";
import { Frame } from "../../components/frame.tsx";
import { LaunchesScreen } from "../../features/launches/launches.tsx";

export const metadata: Metadata = { title: "Launches" };

export default function LaunchesPage() {
  return (
    <Frame section="launches">
      <LaunchesScreen />
    </Frame>
  );
}
