import type { Metadata } from "next";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { LaunchRunScreen } from "../../../features/launches/run.tsx";

export const metadata: Metadata = { title: "Launch" };

export default function LaunchRunPage() {
  return (
    <Frame section="launches">
      <Suspense>
        <LaunchRunScreen />
      </Suspense>
    </Frame>
  );
}
