import type { Metadata } from "next";
import { Suspense } from "react";
import { Frame } from "../../components/frame.tsx";
import { AuditScreen } from "../../features/audit/audit.tsx";

export const metadata: Metadata = { title: "Audit log" };

export default function AuditPage() {
  return (
    <Frame section="audit">
      <Suspense>
        <AuditScreen />
      </Suspense>
    </Frame>
  );
}
