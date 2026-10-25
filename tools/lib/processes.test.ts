// node --test tools/lib/processes.test.ts: stopping the processes npm start
// and the console's stack started, with real child processes of Node.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { hasExited, stopTree } from "./processes.ts";

/** A child that does nothing until it is stopped; with stdin, it also ends when its standard input closes. */
function idle(stdin = false): ChildProcess {
  const code = stdin ? "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);"
    : "setInterval(() => {}, 1000);";
  return spawn(process.execPath, ["-e", code], { stdio: [stdin ? "pipe" : "ignore", "ignore", "ignore"], windowsHide: true });
}

/** What the stop resolved, or "still waiting" after ms. */
async function within(stopping: Promise<boolean>, ms: number): Promise<boolean | "still waiting"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"still waiting">((resolve) => { timer = setTimeout(() => resolve("still waiting"), ms); });
  try {
    return await Promise.race([stopping, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function ended(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
}

test("a child a signal ended has exited without an exit code, and stopping it returns at once", async () => {
  // As the site after Ctrl+C on Linux and macOS, where the signal reaches the whole process group.
  const child = idle();
  await once(child, "spawn");
  child.kill("SIGTERM");
  await once(child, "exit");
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(await within(stopTree(child), 2_000), true);
  assert.equal(hasExited(child), true);
});

test("a running child is stopped", async () => {
  const child = idle();
  await once(child, "spawn");
  try {
    assert.equal(await within(stopTree(child), 30_000), true);
    assert.equal(hasExited(child), true);
  } finally {
    await ended(child);
  }
});

test("a gentle stop asks the child its own way, and forces it only after the grace", async () => {
  const child = idle(true);
  await once(child, "spawn");
  const forced: boolean[] = [];
  try {
    const stopped = stopTree(child, { gentle: () => child.stdin?.end(), graceMs: 20_000, terminate: (_, force) => forced.push(force) });
    assert.equal(await within(stopped, 30_000), true);
    assert.deepEqual(forced, []);
    assert.equal(child.exitCode, 0);
  } finally {
    await ended(child);
  }
});

test("a child that cannot be stopped does not hold the stop for ever: asked, forced, then left", async () => {
  const child = idle();
  await once(child, "spawn");
  const asked: boolean[] = [];
  try {
    const began = Date.now();
    const stopped = stopTree(child, { graceMs: 200, waitMs: 200, terminate: (_, force) => asked.push(force) });
    assert.equal(await within(stopped, 5_000), false);
    assert.deepEqual(asked, [false, true]);
    assert.ok(Date.now() - began < 2_000, `${Date.now() - began} ms`);
    assert.equal(hasExited(child), false);
  } finally {
    await ended(child);
  }
});
