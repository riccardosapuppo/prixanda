// The interaction tests of the console's stories: every story with a play
// function runs in headless Chromium (Playwright 1.62.1, already installed;
// no window opens), from Storybook's static build served on 127.0.0.1 at
// STORYBOOK_PORT (4633). A story passes when Storybook reports it finished
// with success; then axe looks at what it drew. Requests leaving 127.0.0.1
// are refused and counted.
//
//   node apps/console/scripts/storybook-test.ts [--build]   (--build runs storybook build first)
//
// Writes reports/console-storybook.json and exits 1 when a story failed.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { repoRoot } from "../../../tools/lib/paths.ts";
import { run } from "../../../tools/lib/run.ts";
import { appDir, serveStatic } from "./stack.ts";

const say = (line: string) => console.log(`[storybook] ${line}`);
export const STORYBOOK_PORT = Number(process.env["STORYBOOK_PORT"] || 4633);
const staticDir = join(appDir, "storybook-static");

export type StoryOutcome = { readonly id: string; readonly passed: boolean; readonly error: string | null; readonly axeSerious: readonly string[] };
export type StorybookReport = { readonly stories: number; readonly withPlay: number; readonly passed: number; readonly failed: readonly StoryOutcome[]; readonly axeSerious: number; readonly refused: number };

export async function buildStorybook(): Promise<{ code: number | null; output: string }> {
  return run(process.execPath, [join(repoRoot, "node_modules", "storybook", "dist", "bin", "dispatcher.js"), "build", "--disable-telemetry", "--quiet", "-o", "storybook-static"], {
    cwd: appDir,
    env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: "1", NEXT_TELEMETRY_DISABLED: "1" },
  });
}

type IndexEntry = { readonly id: string; readonly type: string; readonly tags?: readonly string[] };

export async function testStories(): Promise<StorybookReport> {
  if (!existsSync(join(staticDir, "index.json"))) throw new Error("apps/console/storybook-static has no build: run with --build");
  const index = JSON.parse(await readFile(join(staticDir, "index.json"), "utf8")) as { entries: Record<string, IndexEntry> };
  const stories = Object.values(index.entries).filter((entry) => entry.type === "story");
  const withPlay = stories.filter((entry) => entry.tags?.includes("play-fn"));
  const server = await serveStatic(staticDir, STORYBOOK_PORT);
  const browser = await chromium.launch({ headless: true });
  const outcomes: StoryOutcome[] = [];
  let refused = 0;
  try {
    for (const story of withPlay) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      await context.route("**/*", (route) => {
        const host = new URL(route.request().url()).hostname;
        if (host === "127.0.0.1" || host === "localhost") return route.continue();
        refused += 1;
        return route.abort();
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        const state = window as unknown as { __outcome?: { status: string; error?: string } };
        const attach = () => {
          const channel = (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__?: { on(event: string, listener: (payload: any) => void): void } }).__STORYBOOK_ADDONS_CHANNEL__;
          if (!channel) {
            setTimeout(attach, 10);
            return;
          }
          channel.on("playFunctionThrewException", (error) => {
            state.__outcome = { status: "error", error: String(error?.message ?? error) };
          });
          channel.on("storyThrewException", (error) => {
            state.__outcome = { status: "error", error: String(error?.message ?? error) };
          });
          channel.on("storyErrored", (error) => {
            state.__outcome = { status: "error", error: String(error?.title ?? "the story errored") };
          });
          channel.on("storyFinished", (event) => {
            state.__outcome ??= { status: String(event?.status ?? "error") };
          });
        };
        attach();
      });
      let error: string | null = null;
      let axeSerious: string[] = [];
      try {
        await page.goto(`${server.url}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`);
        const outcome = await page.waitForFunction(() => (window as unknown as { __outcome?: unknown }).__outcome, null, { timeout: 45_000 })
          .then((handle) => handle.jsonValue() as Promise<{ status: string; error?: string }>);
        if (outcome.status !== "success") error = outcome.error ?? `finished with ${outcome.status}`;
        const results = await new AxeBuilder({ page }).include("#storybook-root").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        axeSerious = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => violation.id);
      } catch (caught) {
        error = caught instanceof Error ? caught.message.split("\n")[0] ?? caught.message : String(caught);
      }
      outcomes.push({ id: story.id, passed: error === null && axeSerious.length === 0, error, axeSerious });
      say(`${error === null && axeSerious.length === 0 ? "ok  " : "FAIL"} ${story.id}${error ? `: ${error}` : ""}${axeSerious.length ? ` (axe: ${axeSerious.join(", ")})` : ""}`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return {
    stories: stories.length,
    withPlay: withPlay.length,
    passed: outcomes.filter((outcome) => outcome.passed).length,
    failed: outcomes.filter((outcome) => !outcome.passed),
    axeSerious: outcomes.reduce((sum, outcome) => sum + outcome.axeSerious.length, 0),
    refused,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(appDir, "scripts", "storybook-test.ts")) {
  if (process.argv.includes("--build")) {
    say("building Storybook");
    const built = await buildStorybook();
    if (built.code !== 0) {
      console.log(built.output.slice(-3000));
      process.exitCode = 1;
    }
  }
  if (process.exitCode !== 1) {
    const report = await testStories();
    await mkdir(join(repoRoot, "reports"), { recursive: true });
    await writeFile(join(repoRoot, "reports", "console-storybook.json"), `${JSON.stringify(report, null, 2)}\n`);
    say(`${report.passed} of ${report.withPlay} stories with interaction tests passed (${report.stories} stories in all); requests refused: ${report.refused}`);
    process.exitCode = report.failed.length === 0 && report.withPlay > 0 && report.refused === 0 ? 0 : 1;
  }
}
