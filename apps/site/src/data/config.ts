// Where the site finds its API, decided when the site is built
// (NEXT_PUBLIC_SITE_API is written into the build). Without it, the gateway's
// public endpoint as `npm run gateway` starts it.
export const SITE_API_URL: string = process.env.NEXT_PUBLIC_SITE_API ?? "http://127.0.0.1:4622/graphql";

/**
 * The public API keeps no session yet, and the gateway does not accept the
 * site's cookies: the browser sends none. The demo listener's session (stage
 * 5) lives in an HttpOnly cookie of the API, and this becomes "include".
 */
export const API_CREDENTIALS: RequestCredentials = "omit";

/** How often an open page asks again for the offers on sale: a launch shows up within this. */
export const OFFERS_REFRESH_MS = 10_000;
