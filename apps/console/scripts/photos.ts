// npm run photos -w console: the console's photos for the README, taken again
// whenever its screens change. Few and real: Marketing's home with "Try this"
// at 1440 and at 390 pixels, the guided creation with the page beside it, and
// a launch's timeline after a simulated fault, the way the recruiter's path
// gets there. They are taken from the assembled demo (npm run demo:build,
// then npm run demo:serve), where the console runs on its own data in the
// browser; --base names another address that serves it, such as the full
// system's console.
//
//   node apps/console/scripts/photos.ts [--base http://127.0.0.1:4651/console]
//
// Headless Chromium, no window; motion reduced, so no picture catches a
// fade. The files go to docs/images/ at the repository's root.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { repoRoot } from "../../../tools/lib/paths.ts";

const at = process.argv.indexOf("--base");
const base = (at > 0 ? process.argv[at + 1] : undefined) ?? `${process.env["DEMO_URL"] ?? `http://127.0.0.1:${process.env["DEMO_PORT"] ?? 4651}`}/console`;
const out = join(repoRoot, "docs", "images");
const say = (line: string) => console.log(`[photos] ${line}`);

/** The page is ready: the demo started (in the sandbox), the fonts are in, and nothing is loading. */
async function settled(page: Page): Promise<void> {
  await page.locator("[data-sandbox='starting']").waitFor({ state: "detached", timeout: 180_000 });
  await page.locator("[aria-busy='true']").first().waitFor({ state: "detached", timeout: 60_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function photo(page: Page, name: string): Promise<void> {
  await settled(page);
  await page.screenshot({ path: join(out, `${name}.png`) });
  say(`${name}.png`);
}

async function enterAs(page: Page, label: string): Promise<void> {
  await page.goto(`${base}/sign-in/`);
  await page.getByRole("heading", { name: "Choose who you are in the demo" }).waitFor({ timeout: 180_000 });
  await page.getByRole("button", { name: `Enter as ${label}`, exact: true }).click();
  await page.waitForURL((url) => !url.pathname.includes("/sign-in"));
}

async function switchTo(page: Page, label: string): Promise<void> {
  const menu = page.getByLabel("Signed in as");
  await menu.selectOption({ label });
  for (let tries = 0; tries < 300 && ((await menu.locator("option:checked").textContent()) !== label || (await menu.isDisabled())); tries++) await page.waitForTimeout(100);
}

/** The Student Autumn Pass through its path: written and submitted, approved, scheduled, launched through a simulated fault. */
async function launchThroughAFault(page: Page): Promise<void> {
  await page.goto(`${base}/campaigns/new/`);
  await page.getByRole("button", { name: "Fill in the Student Autumn Pass" }).click();
  for (const heading of ["Price", "Dates", "Page", "Check and submit"]) {
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: heading, level: 2 }).waitFor();
  }
  await page.getByRole("button", { name: "Save v1 and check it" }).click();
  await page.getByLabel("The change in business words").waitFor({ timeout: 60_000 });
  await page.getByLabel(/Why is it worth running\?/).fill("Students who join in the autumn stay: the pass pays for itself in the second year.");
  await page.getByRole("button", { name: "Submit v1 for approval" }).click();
  await page.getByRole("link", { name: "Open the approval page" }).click();
  await switchTo(page, "Finance");
  await page.getByRole("button", { name: "Approve v1 as Finance" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve v1" }).click();
  await page.getByText(/Approved v1 as Finance/).waitFor();
  await switchTo(page, "Marketing");
  await page.getByRole("button", { name: "Schedule the launch" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Schedule the launch" }).click();
  await page.getByText(/^Scheduled\./).waitFor();
  const controls = page.getByRole("region", { name: "Demo controls" });
  await controls.getByLabel("Cause a fault at the step").selectOption("publish");
  await controls.getByRole("button", { name: "Arm" }).click();
  await controls.getByText("Fault armed at publish.").waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Skip to the launch") && !button.disabled), null, { timeout: 30_000 });
  await controls.getByRole("button", { name: "Skip to the launch" }).click();
  await controls.getByText(/and recovered/).waitFor({ timeout: 120_000 });
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"] });
try {
  // One browser for every photo: in the demo, the first visit starts the sandbox, the others find it running.
  const context: BrowserContext = await browser.newContext({ reducedMotion: "reduce", locale: "en-GB", timezoneId: "Europe/Rome", viewport: { width: 1440, height: 900 } });
  // A second tab of the same address keeps the demo's worker, and the console's session with it, while the first one moves from page to page.
  const keeper = await context.newPage();
  await keeper.goto(new URL("/", base).href);
  const page = await context.newPage();
  await enterAs(page, "Marketing");
  await photo(page, "console-home-1440");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await photo(page, "console-home-390");
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${base}/campaigns/new/`);
  await page.getByRole("button", { name: "Fill in the Student Autumn Pass" }).click();
  await photo(page, "console-campaign-1440");

  // The first step of "Try this", as the recruiter takes it: the site opens in a tab of its own.
  const [site] = await Promise.all([context.waitForEvent("page"), page.getByRole("region", { name: "Try this" }).getByRole("link", { name: "Open the site" }).click()]);
  await site.close();
  await launchThroughAFault(page);
  await page.goto(`${base}/launches/`);
  await page.getByRole("link", { name: /^launch-/ }).first().click();
  await page.getByRole("heading", { name: /^Launch timeline: / }).waitFor();
  await photo(page, "console-timeline-1440");
} finally {
  await browser.close();
}
