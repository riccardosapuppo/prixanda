"use client";
// The time the console reasons with, injected: the page's clock in the app,
// a fixed instant in stories and tests. Nothing else reads the machine's clock.
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export type Clock = { readonly now: () => Date };

export const systemClock: Clock = { now: () => new Date() };

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
    const timer = setInterval(() => setNow(clock.now()), 60_000);
    return () => clearInterval(timer);
  }, [clock]);
  return now;
}
