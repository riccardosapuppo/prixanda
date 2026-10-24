// The console's static export: `next build` (output: "export"), then the
// segment files put where the client router asks for them.
//
// Next.js 16.4.0 names each segment's prefetch file from a path it collects
// with the system's separator (export/index.js, collectSegmentPaths uses
// path.relative): on Windows `campaigns\__PAGE__` keeps its backslash, so the
// file lands in a folder, out/campaigns/__next.campaigns/__PAGE__.txt, while
// the client asks for /campaigns/__next.campaigns.__PAGE__.txt and gets 404s
// it reports in the console, and falls back to reloading the page. On Linux
// and macOS the build writes the flat names already, and this step finds
// nothing to move.
//
//   node apps/console/scripts/build.ts     (npm run build -w console)
import { readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { repoRoot } from "../../../tools/lib/paths.ts";
import { run } from "../../../tools/lib/run.ts";

const appDir = join(repoRoot, "apps", "console");
const say = (line: string) => console.log(`[build] ${line}`);

/** Every file below a folder. */
async function filesBelow(folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(path)));
    else found.push(path);
  }
  return found;
}

/** Moves every segment file written in a folder (`__next.a/b/__PAGE__.txt`) to its flat name (`__next.a.b.__PAGE__.txt`); returns how many moved. */
export async function flattenSegmentFiles(outDir: string): Promise<number> {
  let moved = 0;
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(folder, entry.name);
      if (!entry.name.startsWith("__next.")) {
        await visit(path);
        continue;
      }
      for (const file of await filesBelow(path)) {
        await rename(file, join(folder, `${entry.name}.${relative(path, file).split(sep).join(".")}`));
        moved += 1;
      }
      await rm(path, { recursive: true, force: true });
    }
  };
  await visit(outDir);
  return moved;
}

export type Built = { readonly code: number | null; readonly pages: number; readonly moved: number; readonly output: string };

/** next build with the environment given (the gateway's address goes in NEXT_PUBLIC_GATEWAY_URL), then the segment files flattened. */
export async function buildStatic(env: Readonly<Record<string, string>> = {}): Promise<Built> {
  await rm(join(appDir, "out"), { recursive: true, force: true });
  const built = await run(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "build"], {
    cwd: appDir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...env },
  });
  const pages = (built.output.match(/^[├└┌] ○ \//gm) ?? []).length;
  if (built.code !== 0) return { code: built.code, pages, moved: 0, output: built.output };
  const moved = await flattenSegmentFiles(join(appDir, "out"));
  return { code: built.code, pages, moved, output: built.output };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(appDir, "scripts", "build.ts")) {
  const built = await buildStatic();
  console.log(built.output);
  if (built.code === 0) say(`${built.pages} pages exported to apps/console/out; ${built.moved} segment files moved to the names the client asks for`);
  process.exitCode = built.code === 0 ? 0 : 1;
}
