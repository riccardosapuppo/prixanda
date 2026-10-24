import type { Metadata } from "next";
import { Suspense } from "react";
import { HomeView } from "../components/home/HomeView.tsx";
import { Loading } from "../components/ui/States.tsx";

export const metadata: Metadata = { title: "Plans and prices" };

export default function HomePage() {
  return (
    <Suspense fallback={<div className="wrap py-12"><Loading /></div>}>
      <HomeView />
    </Suspense>
  );
}
