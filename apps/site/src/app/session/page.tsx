import type { Metadata } from "next";
import { Suspense } from "react";
import { SessionView } from "../../components/session/SessionView.tsx";
import { Loading } from "../../components/ui/States.tsx";

export const metadata: Metadata = { title: "Listening session" };

export default function SessionPage() {
  return (
    <Suspense fallback={<div className="wrap py-12"><Loading /></div>}>
      <SessionView />
    </Suspense>
  );
}
