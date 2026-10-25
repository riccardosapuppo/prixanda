// What the end-to-end tests share: entering as a person of the demo,
// switching person from the rail, axe on the screen in front of us, the
// gateway called by hand from inside the page (with the page's own session
// cookie and CSRF token, the way a curious person with the devtools would),
// a guard that refuses every request leaving 127.0.0.1, and, for the tests'
// own setup, the console's API as a person of the team and the site's API as
// one of the demo's listeners.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Locator, type Page } from "@playwright/test";

export const GATEWAY_URL = process.env["GATEWAY_URL"] ?? `http://127.0.0.1:${process.env["GATEWAY_INTERNAL_PORT"] ?? 4621}/graphql`;
export const SITE_API_URL = process.env["GATEWAY_PUBLIC_URL"] ?? `http://127.0.0.1:${process.env["GATEWAY_PUBLIC_PORT"] ?? 4622}/graphql`;

/** Refuses every request to a host other than 127.0.0.1 or localhost, and counts them. */
export async function onlyLocal(context: BrowserContext): Promise<{ readonly refused: () => readonly string[] }> {
  const refused: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
    refused.push(url.href);
    return route.abort();
  });
  return { refused: () => refused };
}

/** Collects the page's uncaught errors and console errors, which every test expects to be none. */
export function watchErrors(page: Page): () => readonly string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return () => errors;
}

export async function enterAs(page: Page, label: string): Promise<void> {
  await page.goto("/sign-in/");
  await expect(page.getByRole("heading", { name: "Choose who you are in the demo" })).toBeVisible();
  await page.getByRole("button", { name: `Enter as ${label}`, exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
  await expect(page.getByLabel("Signed in as")).toHaveValue(/.+/);
}

/** Switches person from the rail's menu, as a person of the demo would: a new demo session, not a login. */
export async function switchTo(page: Page, label: string): Promise<void> {
  const menu = page.getByLabel("Signed in as");
  const toggle = page.getByRole("button", { name: "Menu" });
  if (await toggle.isVisible()) await toggle.click();
  await menu.selectOption({ label });
  await expect(menu.locator("option:checked")).toHaveText(label);
  await expect(page.getByText("Demo entry by role, not a login.")).toBeVisible();
}

export type AxeOutcome = { readonly serious: number; readonly moderate: number; readonly ids: readonly string[] };

/** axe on the page as it is now: WCAG 2.2 A and AA rules. Serious or critical violations fail the test. */
export async function axe(page: Page, where: string): Promise<AxeOutcome> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  const serious = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  const moderate = results.violations.filter((violation) => violation.impact === "moderate" || violation.impact === "minor");
  const detail = serious.map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(" | ")}`);
  expect(detail, `axe on ${where}`).toEqual([]);
  return { serious: serious.length, moderate: moderate.length, ids: moderate.map((violation) => violation.id) };
}

/** A GraphQL request sent by hand from the page: the page's session cookie, its CSRF token, a fresh idempotency key. */
export async function callByHand(page: Page, query: string, variables: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return page.evaluate(async ({ url, query, variables }) => {
    const send = async (text: string, vars: Record<string, unknown>, headers: Record<string, string>) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ query: text, variables: vars }),
      });
      return { status: response.status, body: await response.json() };
    };
    const session = await send("query { session { csrfToken } }", {}, {});
    const csrf = session.body?.data?.session?.csrfToken ?? "";
    return send(query, variables, { "x-csrf-token": csrf, "idempotency-key": `by-hand:${crypto.randomUUID()}`, "x-request-id": `by-hand:${crypto.randomUUID()}` });
  }, { url: GATEWAY_URL, query, variables });
}

/** Whether the page scrolls sideways, and which elements cut their text. */
export async function layoutProblems(page: Page): Promise<{ readonly sideways: number; readonly clipped: readonly string[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const clipped: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("main *, header *"))) {
      if (element.closest("[data-scrolls]") || element.closest(".table-scroll") || element.closest("[role=region]")) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) continue;
      // Text hidden on purpose for assistive technology (sr-only, at some widths or all) is not cut text.
      let hidden = false;
      for (let at: HTMLElement | null = element; at !== null && !hidden; at = at.parentElement) {
        const shown = getComputedStyle(at);
        hidden = shown.position === "absolute" && at.offsetWidth <= 1 && at.offsetHeight <= 1 && (shown.overflow === "hidden" || shown.clipPath === "inset(50%)");
      }
      if (hidden) continue;
      const hidesX = style.overflowX === "hidden" || style.overflowX === "clip";
      const ellipsis = style.textOverflow === "ellipsis";
      if ((hidesX || ellipsis) && element.scrollWidth > element.clientWidth + 1 && (element.textContent ?? "").trim() !== "") {
        clipped.push(`${element.tagName.toLowerCase()}.${element.className.toString().split(" ").slice(0, 2).join(".")}: ${(element.textContent ?? "").trim().slice(0, 40)}`);
      }
    }
    return { sideways: Math.max(0, root.scrollWidth - root.clientWidth), clipped };
  });
}

/** The next Monday after today in Rome, at 09:00, the contract's way. */
export function nextMondayAtNine(now = new Date()): string {
  const rome = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(now);
  const get = (type: string) => rome.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  const ahead = ((1 - weekday + 7) % 7) || 7;
  const date = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) + ahead));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T09:00`;
}

type Client = {
  signIn(): Promise<void>;
  query(query: string, variables?: Record<string, unknown>): Promise<any>;
  mutate(query: string, variables?: Record<string, unknown>): Promise<any>;
};

/** The gateway as one person of the demo, from Node (no browser): for the tests' own setup. */
export function asPerson(personId: string): Client {
  let cookie = "";
  let csrf = "";
  const origin = process.env["CONSOLE_URL"] ?? `http://127.0.0.1:${process.env["CONSOLE_PORT"] ?? 4631}`;
  const send = async (query: string, variables: Record<string, unknown>, mutation: boolean) => {
    const headers: Record<string, string> = { "content-type": "application/json", origin, "x-request-id": `test:${crypto.randomUUID()}` };
    if (cookie) headers["cookie"] = cookie;
    if (mutation && csrf) headers["x-csrf-token"] = csrf;
    if (mutation) headers["idempotency-key"] = `test:${crypto.randomUUID()}`;
    const response = await fetch(GATEWAY_URL, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0] ?? "";
    const body = (await response.json()) as { data?: any; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`${body.errors[0]?.message}`);
    return body.data;
  };
  return {
    async signIn() {
      const data = await send("mutation ($id: ID!) { signIn(personId: $id) { csrfToken } }", { id: personId }, true);
      csrf = data.signIn.csrfToken;
    },
    query: (query, variables = {}) => send(query, variables, false),
    mutate: (query, variables = {}) => send(query, variables, true),
  };
}

/** An offer written, checked and submitted by Marketing through the gateway: something to look at. */
export async function submittedOffer(title: string, group: string): Promise<string> {
  const marketing = asPerson("marketing-1");
  await marketing.signIn();
  const offer = {
    title,
    plan: "student",
    audience: { segment: "NEVER_PAID", needsStudentCheck: true },
    prices: [{ market: "IT", fixed: { amountMinor: "299", currency: "EUR" } }],
    monthsAtOfferPrice: 3,
    periods: [{ market: "IT", startsLocal: nextMondayAtNine() }],
    nonCombinabilityGroup: group,
    pages: [{ market: "IT", title, text: "Three months of Student for 2,99 € a month.", terms: "New subscribers only.", treatment: "standard" }],
  };
  const created = await marketing.mutate("mutation ($offer: OfferInput!) { createOffer(offer: $offer) { __typename ... on Change { id } } }", { offer });
  const id = String(created.createOffer.id);
  await marketing.mutate("mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { __typename } }", { id });
  const submitted = await marketing.mutate(
    "mutation ($id: ID!, $why: String) { submitChange(changeId: $id, version: 1, authorReason: $why) { __typename ... on Change { state } ... on Refusal { code reason } } }",
    { id, why: "A campaign written by the tests." },
  );
  if (submitted.submitChange.state !== "IN_APPROVAL") throw new Error(`the test offer was not submitted: ${JSON.stringify(submitted.submitChange)}`);
  return id;
}

/**
 * The first clock change of a zone between two instants: a minute after
 * which its wall clock does not read one minute later (the clocks go forward:
 * the local times between do not exist), or a wall-clock time that an
 * instant an hour away reads too (the clocks go back: it repeats). Null when
 * the clocks run straight.
 */
export function clockChange(zone: string, from: Date, to: Date): { readonly kind: "repeat" | "skip"; readonly at: Date } | null {
  const hour = 3_600_000;
  const start = Math.floor(from.getTime() / 60_000) * 60_000;
  for (let at = start; at <= to.getTime(); at += 60_000) {
    const wall = wallTime(new Date(at), zone);
    if (wallTime(new Date(at - hour), zone) === wall || wallTime(new Date(at + hour), zone) === wall) return { kind: "repeat", at: new Date(at) };
    const next = new Date(Date.parse(`${wall}:00Z`) + 60_000).toISOString().slice(0, 16);
    if (wallTime(new Date(at + 60_000), zone) !== next) return { kind: "skip", at: new Date(at + 60_000) };
  }
  return null;
}

const utcWords = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Whether a test that schedules a real launch minutes from now can run in a
 * market. On the night its clocks go back (or forward) the local times there
 * repeat (or do not exist), and the console and the engine rightly refuse a
 * start at such a time (§3.7): a launch minutes away cannot be scheduled.
 * Then the test is not run, and says why and from when (UTC) it can run again;
 * null when nothing stands in the way in the next minutes.
 */
export function launchClockGuard(zone: string, minutes = 20, now = new Date()): string | null {
  const ahead = (at: Date) => new Date(at.getTime() + minutes * 60_000);
  const change = clockChange(zone, now, ahead(now));
  if (change === null) return null;
  let retry = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  for (let tries = 0; tries < 6 * 60 && clockChange(zone, retry, ahead(retry)) !== null; tries++) retry = new Date(retry.getTime() + 60_000);
  return `Not run for the clocks: ${zone} ${change.kind === "repeat" ? "repeats" : "skips"} its local times at ${utcWords(change.at)}, and a launch `
    + `minutes from now cannot be scheduled there (the console and the engine refuse a time the clocks ${change.kind} there, §3.7). It can run again from ${utcWords(retry)}.`;
}

/** The tests not run for the clocks in this run: a later test that needs their launch is not run either, for the same reason. */
export const notRunForTheClocks: string[] = [];

/** Records a test not run for the clocks, where e2e/run.ts reads it, and keeps it for the tests after it. */
export function recordNotRun(test: string, reason: string): void {
  notRunForTheClocks.push(reason);
  const reports = process.env["E2E_REPORTS"];
  if (!reports) return;
  mkdirSync(reports, { recursive: true });
  appendFileSync(join(reports, "console-e2e-not-run.jsonl"), `${JSON.stringify({ test, reason })}\n`);
}

/** An instant's wall-clock time in a zone, the contract's way: 2026-10-25T10:45. */
function wallTime(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * A local time at least a number of minutes ahead in a zone, at a whole
 * minute, the contract's way. A time the clocks repeat that night (between
 * 02:00 and 03:00 when they go back) is no time to start anything: the
 * console and the engine refuse it, so the next unambiguous minute is taken.
 */
export function minutesAhead(minutes: number, zone: string, from = new Date()): string {
  const wanted = Math.ceil((from.getTime() + minutes * 60_000) / 60_000) * 60_000;
  const hour = 3_600_000;
  for (let at = wanted; at < wanted + 3 * hour; at += 60_000) {
    const wall = wallTime(new Date(at), zone);
    if (wallTime(new Date(at - hour), zone) === wall || wallTime(new Date(at + hour), zone) === wall) continue;
    // A test that waits for a launch cannot wait hours: on the night the clocks go back, it says why instead.
    if (at - wanted > 10 * 60_000) {
      throw new Error(`${zone} repeats its local times tonight until ${wall}: a launch minutes from now cannot be scheduled there. Run the end-to-end tests after the clocks went back.`);
    }
    return wall;
  }
  throw new Error(`no unambiguous local time in ${zone} in the next three hours`);
}

/** A local date some days after a local time of the contract, at a time of day: "2026-11-02T09:00" + 30 days at 00:00. */
export function daysAfter(local: string, days: number, time: string): string {
  const date = new Date(`${local.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.toISOString().slice(0, 10)}T${time}`;
}

/** A price migration written, checked and submitted by the commercial lead through the gateway: something to look at. */
export async function submittedMigration(title: string, plan: string, market: string, amount: { readonly amountMinor: string; readonly currency: string }): Promise<string> {
  const lead = asPerson("commercial-lead-1");
  await lead.signIn();
  const noticesLocal = nextMondayAtNine();
  const migration = { title, plan, market, amount, noticesLocal, startsLocal: daysAfter(noticesLocal, 30, "00:00") };
  const created = await lead.mutate("mutation ($m: PriceMigrationInput!) { createPriceMigration(migration: $m) { __typename ... on Change { id } ... on Refusal { code reason } } }", { m: migration });
  if (created.createPriceMigration.__typename !== "Change") throw new Error(`the test migration was not created: ${JSON.stringify(created.createPriceMigration)}`);
  const id = String(created.createPriceMigration.id);
  await lead.mutate("mutation ($id: ID!) { validateChange(changeId: $id, version: 1) { __typename } }", { id });
  const submitted = await lead.mutate("mutation ($id: ID!) { submitChange(changeId: $id, version: 1) { __typename ... on Change { state } ... on Refusal { code reason } } }", { id });
  if (submitted.submitChange.state !== "IN_APPROVAL") throw new Error(`the test migration was not submitted: ${JSON.stringify(submitted.submitChange)}`);
  return id;
}

type Listener = {
  signIn(): Promise<void>;
  query(query: string, variables?: Record<string, unknown>): Promise<any>;
  mutate(query: string, variables?: Record<string, unknown>): Promise<any>;
};

/** The site's API as one of the demo's listeners, named by their title at the entrance (DEMONSTRATION MODE, not a sign-in). */
export function asListener(title: string): Listener {
  let cookie = "";
  let csrf = "";
  const send = async (query: string, variables: Record<string, unknown>, mutation: boolean) => {
    const headers: Record<string, string> = { "content-type": "application/json", "x-request-id": `test:${crypto.randomUUID()}` };
    if (cookie) headers["cookie"] = cookie;
    if (mutation && csrf) headers["x-csrf-token"] = csrf;
    if (mutation) headers["idempotency-key"] = `test:${crypto.randomUUID()}`;
    const response = await fetch(SITE_API_URL, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0] ?? "";
    const body = (await response.json()) as { data?: any; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`${body.errors[0]?.message}`);
    return body.data;
  };
  return {
    async signIn() {
      const listeners = (await send("query { demoListeners { id title } }", {}, false)).demoListeners as { id: string; title: string }[];
      const found = listeners.find((listener) => listener.title === title);
      if (found === undefined) throw new Error(`no demo listener "${title}": ${listeners.map((listener) => listener.title).join(", ")}`);
      const me = await send("mutation ($id: ID!) { signInAsListener(listenerId: $id) { csrfToken } }", { id: found.id }, true);
      csrf = me.signInAsListener.csrfToken;
    },
    query: (query, variables = {}) => send(query, variables, false),
    mutate: (query, variables = {}) => send(query, variables, true),
  };
}

/** Presses Tab until the element has the focus: the keyboard's own way there. */
export async function tabTo(page: Page, target: Locator, limit = 150): Promise<void> {
  for (let presses = 0; presses < limit; presses++) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`the keyboard did not reach the element in ${limit} presses of Tab`);
}
