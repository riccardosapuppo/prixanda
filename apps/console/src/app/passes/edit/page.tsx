"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Frame } from "../../../components/frame.tsx";
import { PassEditor } from "../../../features/passes/form.tsx";

function EditPass() {
  const id = useSearchParams().get("id");
  return <PassEditor changeId={id && /^\d+$/.test(id) ? id : "0"} />;
}

export default function EditPassPage() {
  return (
    <Frame section="passes">
      <Suspense>
        <EditPass />
      </Suspense>
    </Frame>
  );
}
