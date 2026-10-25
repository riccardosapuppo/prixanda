// Where the site finds its API, decided when the site is built
// (NEXT_PUBLIC_SITE_API is written into the build). Without it, the gateway's
// public endpoint as `npm run gateway` starts it.
export const SITE_API_URL: string = process.env.NEXT_PUBLIC_SITE_API ?? "http://127.0.0.1:4622/graphql";

/**
 * The browser sends the API's own cookies: the demo listener's session lives
 * in an HttpOnly cookie of the gateway, which only "include" sends to the
 * API's origin. The gateway accepts it from the site's origins only.
 */
export const API_CREDENTIALS: RequestCredentials = "include";

/** How often an open page asks again for the offers on sale: a launch shows up within this. */
export const OFFERS_REFRESH_MS = 10_000;

/** How often the account is read again while the first month's payment is pending, and for how long at most. */
export const PAYMENT_POLL_MS = 1_000;
export const PAYMENT_POLL_LIMIT_MS = 30_000;

/**
 * Built for the browser demo's sandbox (SANDBOX=1, stage 8): the
 * requests go to the sandbox's worker in this browser, not to a gateway.
 */
export const SANDBOX_MODE: boolean = process.env.SITE_SANDBOX === "1";

/** The demo build's fingerprint (SANDBOX_BUILD): a tab whose worker belongs to another build reloads. */
export const SANDBOX_BUILD: string = process.env.SITE_SANDBOX_BUILD || "dev";
