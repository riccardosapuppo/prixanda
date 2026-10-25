import type { Metadata } from "next";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { MigrationEditor } from "../../../features/migration/form.tsx";

export const metadata: Metadata = { title: "New price migration" };

export default function NewPriceMigrationPage() {
  return (
    <Frame section="price-migrations">
      <Suspense>
        <MigrationEditor changeId={null} />
      </Suspense>
    </Frame>
  );
}
