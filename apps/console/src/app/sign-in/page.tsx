import type { Metadata } from "next";
import { Suspense } from "react";
import { Entry } from "../../features/entry/entry.tsx";

export const metadata: Metadata = { title: "Choose a person" };

export default function SignInPage() {
  return (
    <Suspense>
      <Entry />
    </Suspense>
  );
}
