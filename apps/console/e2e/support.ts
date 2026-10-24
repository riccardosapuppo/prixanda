// What the end-to-end tests share: entering as a person of the demo,
// switching person from the rail, axe on the screen in front of us, the
// gateway called by hand from inside the page (with the page's own session
// cookie and CSRF token, the way a curious person with the devtools would),
// and a guard that refuses every request leaving 127.0.0.1.
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Locator, type Page } from "@playwright/test";

export const GATEWAY_URL = process.env["GATEWAY_URL"] ?? `http://127.0.0.1:${process.env["GATEWAY_INTERNAL_PORT"] ?? 4621}/graphql`;

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

/** Presses Tab until the element has the focus: the keyboard's own way there. */
export async function tabTo(page: Page, target: Locator, limit = 150): Promise<void> {
  for (let presses = 0; presses < limit; presses++) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`the keyboard did not reach the element in ${limit} presses of Tab`);
}
