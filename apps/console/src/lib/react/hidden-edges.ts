"use client";
// Which edges of a box that scrolls still hide some of what it holds: what a
// wide table has past its right edge, what the rail has below its fold. Read
// again when the box scrolls, when it changes size, and when what it holds
// does (the rows of a table come, the demo's steps appear).
import { type RefObject, useEffect, useState } from "react";

export type HiddenEdges = { readonly before: boolean; readonly after: boolean };

/** Along x: before is the left edge, after the right one; along y: the top and the bottom. */
export function useHiddenEdges(box: RefObject<HTMLElement | null>, axis: "x" | "y"): HiddenEdges {
  const [hidden, setHidden] = useState<HiddenEdges>({ before: false, after: false });

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const read = () => {
      const at = axis === "x" ? element.scrollLeft : element.scrollTop;
      const seen = axis === "x" ? element.clientWidth : element.clientHeight;
      const all = axis === "x" ? element.scrollWidth : element.scrollHeight;
      const before = at > 1;
      const after = at + seen < all - 1;
      setHidden((was) => (was.before === before && was.after === after ? was : { before, after }));
    };
    read();
    element.addEventListener("scroll", read, { passive: true });
    const sizes = new ResizeObserver(read);
    sizes.observe(element);
    for (const child of Array.from(element.children)) sizes.observe(child);
    // What it holds can change entirely (the demo's steps come once the demo has started).
    const changes = new MutationObserver(() => {
      for (const child of Array.from(element.children)) sizes.observe(child);
      read();
    });
    changes.observe(element, { childList: true });
    return () => {
      element.removeEventListener("scroll", read);
      sizes.disconnect();
      changes.disconnect();
    };
  }, [box, axis]);

  return hidden;
}
