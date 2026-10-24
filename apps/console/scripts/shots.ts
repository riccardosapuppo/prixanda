// Photos of the console, for looking at it: headless Chromium (no window),
// entering as one of the demo's people, then each page at each width.
//
//   node apps/console/scripts/shots.ts --as Marketing --out <folder> [--base http://127.0.0.1:4631]
//        [--widths 1440,1280,390] [--pages /,/campaigns/]
//
// Every request outside 127.0.0.1 is refused and counted: the console must
// not reach any other host. The photos go where --out says, never into the
// repository.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const base = option("base", `http://127.0.0.1:${process.env["CONSOLE_PORT"] ?? 4631}`);
const person = option("as", "Marketing");
const out = option("out", "");
const widths = option("widths", "1440,390").split(",").map(Number);
const pages = option("pages", "/").split(",");
if (!out) throw new Error("--out <folder> is required: photos never go into the repository");

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
let refused = 0;
try {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
      refused += 1;
      return route.abort();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${base}/sign-in/`);
    await page.getByRole("button", { name: `Enter as ${person}`, exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
    for (const path of pages) {
      await page.goto(`${base}${path}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
      const name = `${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home"}-${person.toLowerCase().replace(/\W+/g, "-")}-${width}.png`;
      await page.screenshot({ path: join(out, name), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      console.log(`${name}: ${overflow > 0 ? `scrolls sideways by ${overflow}px` : "no sideways scroll"}`);
    }
    if (errors.length) console.log(`errors at ${width}:\n  ${errors.join("\n  ")}`);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`requests to other hosts refused: ${refused}`);
