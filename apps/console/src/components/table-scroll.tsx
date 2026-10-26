"use client";
// A table wider than its box scrolls inside it, from the keyboard too (a
// region with a name, in the tab order). While columns stay hidden past an
// edge, a shadow on that edge says so; it goes once that end of the table is
// in sight, so a phone shows at a glance that the table goes on.
import { type ReactNode, useRef } from "react";
import { useHiddenEdges } from "../lib/react/hidden-edges.ts";

export function TableScroll({ labelledBy, children }: { readonly labelledBy: string; readonly children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const hidden = useHiddenEdges(box, "x");
  return (
    <div className="table-cue" {...(hidden.before ? { "data-hidden-start": "" } : {})} {...(hidden.after ? { "data-hidden-end": "" } : {})}>
      <div ref={box} className="table-scroll" tabIndex={0} role="region" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );
}
