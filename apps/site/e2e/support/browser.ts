// What the site's end-to-end tests do with the browser, shared by them: a
// visitor of its own that counts what must not happen (a request to another
// host, an error in the console), axe on a page as it stands, the keyboard's
// way to an element, and the check that a page fits its window.
import assert from "node:assert/strict";
import { AxeBuilder } from "@axe-core/playwright";
import type { Browser, BrowserContext, Locator, Page, Request } from "playwright";
import { PUBLIC_API } from "./stack.ts";

/** The widths every page must fit: desktop, laptop, 1440 at 200 % zoom, phone, narrow phone. */
export const WIDTHS = [1440, 1280, 720, 390, 320] as const;

export type Seen = { operation: string; requestId: string; idempotencyKey: string; variables: Record<string, unknown> };

/** The page's main text, with the no-break spaces a price is written with read as spaces. */
export const text = async (page: Page) => (await page.locator("main").innerText()).replace(/[  ]/g, " ");

/** The operation a request of the site to the API names. */
export const operationOf = (request: Request) => (request.postDataJSON() as { operationName?: string } | null)?.operationName ?? "";

/**
 * An answer of the API that says something failed on its side, for a test
 * to give a request instead of the real one (route.fulfill), with the
 * headers the site's origin needs to read it. Unlike a network out of reach,
 * it is not asked again by itself.
 */
export function failedAnswer(request: Request) {
  const headers = request.headers();
  return {
    status: 200,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": headers["origin"] ?? "",
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "X-Request-Id, Retry-After",
      "x-request-id": headers["x-request-id"] ?? "",
    },
    body: JSON.stringify({ data: null, errors: [{ message: "Internal server error", extensions: { code: "INTERNAL" } }] }),
  };
}

/**
 * Waits for the animations under way on the page that end by themselves (a
 * step fading in, a record cross-fading, a button giving under the press) to
 * end, so that axe reads the page at rest: a colour read halfway through a
 * fade has a contrast it does not keep. An animation that repeats without
 * end is not waited for, and one cancelled meanwhile is let go.
 */
export async function animationsDone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const ending = document.getAnimations().filter((animation) =>
      animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().iterations ?? Number.POSITIVE_INFINITY));
    await Promise.all(ending.map((animation) => animation.finished.then(() => undefined, () => undefined)));
  });
}

/** Presses Tab until the target has the focus, as a visitor on the keyboard would. */
export async function tabTo(page: Page, target: Locator, most = 80): Promise<void> {
  for (let presses = 0; presses < most; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  assert.fail(`${String(target)} is not reached with Tab in ${most} presses`);
}

/** What does not fit the window: a sideways scroll, text past its edge, text cut off by its box. */
export async function misfits(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const found: string[] = [];
    if (root.scrollWidth > root.clientWidth) found.push(`the page scrolls sideways by ${root.scrollWidth - root.clientWidth} px`);
    const name = (element: Element) => `${element.tagName.toLowerCase()}${[...element.classList].map((each) => `.${each}`).join("")}`;
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      if (element.closest("svg, [class*='sr-only']")) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const words = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
      if (!words) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > root.clientWidth + 1 || box.left < -1) found.push(`past the edge: ${name(element)}`);
      const hidesX = style.overflowX === "hidden" || style.overflowX === "clip";
      const hidesY = style.overflowY === "hidden" || style.overflowY === "clip";
      if ((hidesX && element.scrollWidth > element.clientWidth + 1) || (hidesY && element.scrollHeight > element.clientHeight + 1)) {
        found.push(`cut off: ${name(element)}`);
      }
    }
    return found;
  });
}

/**
 * One test's watch over its browsers: every visitor it opens counts requests
 * to other hosts and console errors, and remembers the site's own requests to
 * the API with their request ids, to be found again in the audit log.
 */
export class Watch {
  externalRequests = 0;
  readonly pageErrors: string[] = [];
  pagesChecked = 0;
  seriousViolations = 0;
  otherViolations = 0;
  layoutChecks = 0;
  readonly siteRequests: Seen[] = [];
  readonly #browser: () => Browser;

  constructor(browser: () => Browser) {
    this.#browser = browser;
  }

  /** A browser of its own (cookies included). */
  async visitor(width = 1280): Promise<{ context: BrowserContext; page: Page }> {
    const context = await this.context(width);
    return { context, page: await this.tab(context) };
  }

  /** A browser of its own whose requests to another host are counted and refused; its tabs come from tab(). */
  async context(width = 1280): Promise<BrowserContext> {
    const context = await this.#browser().newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, locale: "en-GB", timezoneId: "Europe/Rome" });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol !== "data:" && url.protocol !== "blob:" && url.hostname !== "127.0.0.1") {
        this.externalRequests += 1;
        await route.abort();
        return;
      }
      await route.continue();
    });
    return context;
  }

  /** A new tab of a browser, watched like the others. */
  async tab(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") this.pageErrors.push(message.text());
    });
    page.on("pageerror", (error) => this.pageErrors.push(error.message));
    page.on("request", (request) => {
      if (request.url() !== PUBLIC_API || request.method() !== "POST") return;
      const body = request.postDataJSON() as { operationName?: string; variables?: Record<string, unknown> } | null;
      const headers = request.headers();
      this.siteRequests.push({
        operation: body?.operationName ?? "", requestId: headers["x-request-id"] ?? "", idempotencyKey: headers["idempotency-key"] ?? "",
        variables: body?.variables ?? {},
      });
    });
    return page;
  }

  /** axe on the page as it is now, once its animations have ended: serious and critical violations fail the test. */
  async accessible(page: Page, where: string): Promise<void> {
    await animationsDone(page);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    this.pagesChecked += 1;
    const serious = result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
    this.seriousViolations += serious.length;
    this.otherViolations += result.violations.length - serious.length;
    assert.deepEqual(serious.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`), [], `axe on ${where}`);
  }

  /** The page at every width, read again at each: what does not fit, by width. */
  async fits(page: Page, ready: string): Promise<string[]> {
    const found: string[] = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      await page.reload();
      await page.locator(ready).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      for (const problem of await misfits(page)) found.push(`${width} px, ${new URL(page.url()).pathname}: ${problem}`);
      this.layoutChecks += 1;
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    return found;
  }

  /** The request ids the site sent for an operation, in order. */
  sent(operation: string): string[] {
    return this.siteRequests.filter((seen) => seen.operation === operation).map((seen) => seen.requestId);
  }
}
