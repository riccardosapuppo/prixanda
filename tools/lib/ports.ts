// Who is listening on a port, asked to the system.
//
// Trying to bind is not enough on Windows: binding 127.0.0.1:N succeeds even
// while another process listens on 0.0.0.0:N or [::]:N, and the requests then
// reach that other process. Listening rows are recognised by their remote
// address (0.0.0.0:0, [::]:0), because Windows translates the state word.
import { run } from "./run.ts";

export async function listenerOn(port: number): Promise<string | null> {
  if (process.platform === "win32") {
    const { output } = await run("netstat", ["-a", "-n", "-o"]);
    for (const line of output.split(/\r?\n/)) {
      const [proto, local, remote, , pid] = line.trim().split(/\s+/);
      if (proto !== "TCP" || !local?.endsWith(`:${port}`)) continue;
      if (remote !== "0.0.0.0:0" && remote !== "[::]:0") continue;
      const name = pid ? await processName(pid) : "an unknown process";
      return `${name} (PID ${pid ?? "?"}) on ${local}`;
    }
    return null;
  }
  const { code, output } = await run("ss", ["-ltnpH"]);
  if (code !== 0) throw new Error(`cannot ask the system who listens on port ${port}: ss exited with ${code}`);
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const local = fields[3];
    if (local?.endsWith(`:${port}`)) return `${fields.slice(5).join(" ") || "a process"} on ${local}`;
  }
  return null;
}

async function processName(pid: string): Promise<string> {
  const { output } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  const name = output.trim().split(",")[0]?.replaceAll('"', "");
  return name && !name.includes(" ") ? name : "a process";
}

export async function assertFree(port: number, what: string): Promise<void> {
  const holder = await listenerOn(port);
  if (holder) throw new Error(`port ${port}, needed for ${what}, is taken by ${holder}`);
}
