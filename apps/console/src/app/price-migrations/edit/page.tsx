"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { MigrationEditor } from "../../../features/migration/form.tsx";

function EditMigration() {
  const id = useSearchParams().get("id");
  return <MigrationEditor changeId={id && /^\d+$/.test(id) ? id : "0"} />;
}

export default function EditPriceMigrationPage() {
  return (
    <Frame section="price-migrations">
      <Suspense>
        <EditMigration />
      </Suspense>
    </Frame>
  );
}
