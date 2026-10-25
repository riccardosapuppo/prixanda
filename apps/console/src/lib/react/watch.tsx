"use client";
// How a page that watches the platform keeps up with it: the home (what
// waits for a signature, what launches in the next days, what broke today)
// and the launches. In the demo's sandbox the worker says what changed, and
// those pages are read again then (app/providers.tsx). With the gateway
// nothing tells the console, so they are read again every half minute while
// the page is in front, and at once when its tab comes back to the front:
// TanStack Query pauses the interval while the tab is hidden.
import { createContext, type ReactNode, useContext } from "react";
import { SANDBOX_MODE } from "../sandbox.ts";

/** How often a page that watches is read again with the gateway. */
export const WATCH_EVERY_MS = 30_000;

const WatchContext = createContext<number | false>(SANDBOX_MODE ? false : WATCH_EVERY_MS);

/** Another pace for the pages that watch: the stories', so that the next reading comes in a moment. */
export function WatchEvery({ ms, children }: { readonly ms: number | false; readonly children: ReactNode }) {
  return <WatchContext.Provider value={ms}>{children}</WatchContext.Provider>;
}

/** A query that watches: read again at the page's pace, and when its tab comes back; nothing of the kind in the sandbox. */
export function useWatch(): { readonly refetchInterval?: number; readonly refetchOnWindowFocus?: boolean } {
  const every = useContext(WatchContext);
  return every === false ? {} : { refetchInterval: every, refetchOnWindowFocus: true };
}
