// npm run photos -w site: the site's photos for the README, taken again
// whenever the pages change. Few and real: the opening of the home at 1440
// and at 390 pixels, the plans with where a price goes, a listening session.
// They are taken from the assembled demo (npm run demo:build, then npm run
// demo:serve), where the site runs on its own data in the browser; --base
// names another address that serves the site, such as the full system's.
//
//   node apps/site/scripts/photos.ts [--base http://127.0.0.1:4651]
//
// Headless Chromium, no window; motion reduced, so no picture catches a
// fade. The files go to docs/images/ at the repository's root.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { repoRoot } from "../../../tools/lib/paths.ts";

const at = process.argv.indexOf("--base");
const base = (at > 0 ? process.argv[at + 1] : undefined) ?? process.env["DEMO_URL"] ?? `http://127.0.0.1:${process.env["DEMO_PORT"] ?? 4651}`;
const out = join(repoRoot, "docs", "images");
const say = (line: string) => console.log(`[photos] ${line}`);

type Photo = { readonly name: string; readonly path: string; readonly width: number; readonly height: number; readonly at?: string };

const PHOTOS: readonly Photo[] = [
  { name: "site-home-1440", path: "/?market=IT", width: 1440, height: 900 },
  { name: "site-home-390", path: "/?market=IT", width: 390, height: 844 },
  { name: "site-plans-1440", path: "/?market=IT&plan=student", width: 1440, height: 900, at: "#plans" },
  { name: "site-session-1440", path: "/session/?label=casa-lenta", width: 1440, height: 900 },
];

/** The page is ready: the demo started (in the sandbox), the fonts are in, and what the photo shows is there. */
async function ready(page: Page, photo: Photo): Promise<void> {
  await page.locator("[data-sandbox='starting']").waitFor({ state: "detached", timeout: 180_000 });
  if (photo.path.startsWith("/session/")) await page.locator(".player").waitFor();
  else await page.locator(".plan").first().waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"] });
try {
  // One browser for every photo: in the demo, the first visit starts the sandbox, the others find it running.
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "en-GB", timezoneId: "Europe/Rome" });
  for (const photo of PHOTOS) {
    const page = await context.newPage();
    await page.setViewportSize({ width: photo.width, height: photo.height });
    await page.goto(`${base}${photo.path}`);
    await ready(page, photo);
    if (photo.at) await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: "start" }), photo.at);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${photo.name}.png`) });
    say(`${photo.name}.png`);
    await page.close();
  }
} finally {
  await browser.close();
}
