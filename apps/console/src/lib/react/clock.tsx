"use client";
// The time the console reasons with, injected: the page's clock in the app,
// the demo's clock in the demo's sandbox (the story's time, which runs at the
// machine's pace and jumps forward when the demo skips to a launch), a fixed
// instant in stories and tests. Nothing else reads the machine's clock.
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export type Clock = { readonly now: () => Date };

export const systemClock: Clock = { now: () => new Date() };

/** A clock some milliseconds ahead of (or behind) the machine's: the demo's, as its worker last said where it stands. */
export function offsetClock(offsetMs: number): Clock {
  return { now: () => new Date(Date.now() + offsetMs) };
}

const ClockContext = createContext<Clock>(systemClock);

export function ClockProvider({ clock, children }: { readonly clock: Clock; readonly children: ReactNode }) {
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

export function useClock(): Clock {
  return useContext(ClockContext);
}

/** The current time, read again every minute: enough for labels that name the minute. */
export function useMinute(): Date {
  const clock = useClock();
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    // A clock that changed (the demo's, after a skip) is read at once, not a minute later.
    setNow(clock.now());
    const timer = setInterval(() => setNow(clock.now()), 60_000);
    return () => clearInterval(timer);
  }, [clock]);
  return now;
}
