// Runs a command and collects what it prints.
//
// It resolves when the pipes close, as usual, but at most two seconds after
// the process exits: `pg_ctl start` leaves the server running with copies of
// its pipes, which then never close, and waiting for them hung the first
// prototype until its timeout.
import { spawn } from "node:child_process";

export type Ran = { code: number | null; output: string; ms: number };

export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; echo?: boolean } = {},
): Promise<Ran> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let exitCode: number | null = null;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (grace) clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, output, ms: Math.round(performance.now() - started) });
    };
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (options.echo) process.stdout.write(text);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.once("error", (error) => {
      output += `\n${error.message}\n`;
      finish(-1);
    });
    child.once("exit", (code) => {
      exitCode = code;
      grace = setTimeout(() => finish(exitCode), 2000);
    });
    child.once("close", (code) => finish(code ?? exitCode));
  });
}

// The same, failing loudly: for steps whose failure leaves nothing to check.
export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; echo?: boolean } = {},
): Promise<Ran> {
  const ran = await run(command, args, options);
  if (ran.code !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(" ")} exited with ${ran.code}:\n${ran.output.trim()}`);
  }
  return ran;
}
