import type { Metadata } from "next";
import { Suspense } from "react";
import { PlansView } from "../components/plans/PlansView.tsx";
import { Loading } from "../components/ui/States.tsx";

export const metadata: Metadata = { title: "Plans and prices" };

export default function HomePage() {
  return (
    <Suspense fallback={<div className="wrap py-12"><Loading /></div>}>
      <PlansView />
    </Suspense>
  );
}
