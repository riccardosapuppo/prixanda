import type { Metadata } from "next";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { PassEditor } from "../../../features/passes/form.tsx";

export const metadata: Metadata = { title: "New prepaid pass" };

export default function NewPassPage() {
  return (
    <Frame section="passes">
      <Suspense>
        <PassEditor changeId={null} />
      </Suspense>
    </Frame>
  );
}
