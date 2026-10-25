// Stopping the processes a tool started (npm start, the console's stack),
// and waiting for them to exit.
//
// A child that a signal ended has no exit code, only the signal: on Linux and
// macOS, Ctrl+C reaches the whole process group, so a child can be gone
// before the tool comes to stop it. Either one says it has exited. And the
// wait has a limit: a process that cannot be stopped is left, and said so,
// so that the rest of the shutdown still runs.
import type { ChildProcess } from "node:child_process";
import { run } from "./run.ts";

/** Whether a child has exited: with a code, or ended by a signal. */
export function hasExited(child: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Waits for a child to exit, at most ms: whether it did. */
export function exitWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    child.once("exit", onExit);
  });
}

export type StopOptions = {
  /** Asks the child to finish its own way (the engine: its standard input closed) instead of a signal. */
  readonly gentle?: () => void;
  /** How long the child has to exit once asked, before it is forced. */
  readonly graceMs?: number;
  /** How long to wait once it is forced; a child still running then is left. */
  readonly waitMs?: number;
  /** How a child is asked (force false) and forced (force true) to stop: the platform's way, unless a test gives one. */
  readonly terminate?: (child: ChildProcess, force: boolean) => void;
};

/**
 * Stops a child and the ones it started (Next.js starts workers of its own): asks it, gives it graceMs, forces
 * it, gives it waitMs. Resolves whether it exited; it never waits longer than the two.
 */
export async function stopTree(child: ChildProcess | null, options: StopOptions = {}): Promise<boolean> {
  if (child === null || hasExited(child) || child.pid === undefined) return true;
  const { gentle, graceMs = 10_000, waitMs = 10_000, terminate = terminateTree } = options;
  if (gentle) gentle();
  else terminate(child, false);
  if (await exitWithin(child, graceMs)) return true;
  terminate(child, true);
  return exitWithin(child, waitMs);
}

/**
 * On Windows, taskkill ends the whole tree, forced (a console program has no gentler way to be asked).
 * Elsewhere SIGTERM, which Next.js passes to its workers, then SIGKILL.
 */
function terminateTree(child: ChildProcess, force: boolean): void {
  if (process.platform === "win32") {
    void run("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    return;
  }
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Not ours to signal: the wait's limit ends the stop.
  }
}
