"use client";
// The demo's sandbox for the console's components (stage 8): the sandbox the
// providers opened (null on the console served with a gateway), its status as
// it changes, where the demo stands (the next launch due, the fault armed),
// and the "Try this" record this browser keeps for every tab.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Status } from "sandbox/protocol";
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import { clearGuide, EMPTY_GUIDE, GUIDE_KEY, type GuideRecord, nextGuide, readGuide, writeGuide } from "../guide.ts";
import { runCommand, type Sandbox, type SandboxStatus } from "../sandbox.ts";

const SandboxContext = createContext<Sandbox | null>(null);

export function SandboxProvider({ sandbox, children }: { readonly sandbox: Sandbox | null; readonly children: ReactNode }) {
  return <SandboxContext.Provider value={sandbox}>{children}</SandboxContext.Provider>;
}

/** The demo's sandbox, in a sandbox build; null on the console served with a gateway. */
export function useSandbox(): Sandbox | null {
  return useContext(SandboxContext);
}

const STARTING: SandboxStatus = { state: "starting", step: null, done: 0, of: 0 };

/** The sandbox's status as it changes: starting with its steps, ready, failed, or another build's worker. */
export function useSandboxStatus(sandbox: Sandbox): SandboxStatus {
  return useSyncExternalStore(sandbox.subscribe, sandbox.status, () => STARTING);
}

/** The query key of where the demo stands: read again whenever the worker says something changed. */
export const DEMO_STATUS_KEY = ["sandbox-status"] as const;

/** Where the demo stands, from the worker's status command, once it is ready. */
export function useDemoStatus(sandbox: Sandbox, ready: boolean): UseQueryResult<Status, Error> {
  return useQuery<Status, Error>({
    queryKey: DEMO_STATUS_KEY,
    enabled: ready,
    staleTime: 2_000,
    queryFn: async () => {
      const answer = await runCommand(sandbox, "status");
      if (!answer.ok) throw new Error(answer.error);
      return answer.result;
    },
  });
}

// The "Try this" record: one per browser, read by every component of the tab,
// and by the other tabs when it changes (the storage event).
const listeners = new Set<() => void>();
let cached: GuideRecord | null = null;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function current(): GuideRecord {
  cached ??= readGuide(storage());
  return cached;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== GUIDE_KEY && event.key !== null) return;
    cached = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** What this browser recorded for "Try this". */
export function useGuideRecord(): GuideRecord {
  return useSyncExternalStore(subscribe, current, () => EMPTY_GUIDE);
}

/** Records a step that only this browser can see happen. */
export function recordGuide(patch: Partial<GuideRecord>): void {
  const next = nextGuide(current(), patch);
  cached = next;
  writeGuide(storage(), next);
  notify();
}

/** The demo started over: "Try this" starts over too. */
export function forgetGuide(): void {
  clearGuide(storage());
  cached = EMPTY_GUIDE;
  notify();
}
