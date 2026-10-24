// Sessions of both APIs: DEMONSTRATION MODE, not authentication. The
// console's session holds a person of the demo; the site's holds one of the
// demo's listeners. They are two stores with two cookies, and neither API
// reads the other's.
//
// A session is kept in the gateway's memory under a random id; the browser
// holds the id in a cookie signed with HMAC-SHA256, HttpOnly (no script reads
// it) and SameSite=Strict (no other site sends it). A forged or altered cookie
// is ignored before any lookup. Signing in again replaces the session with a
// new id, so an id seen before signing in is worth nothing after. Each session
// also has a CSRF token, derived from its id with the same key, that mutations
// must carry in a header. Sessions end after a working day, or an hour
// without a request, by the injected clock; a restart ends them all.
//
// Browsers keep cookies by host, not by port: the console's and the site's
// APIs on one host each receive both cookies. So each store has its own
// cookie name, and its own scope in every signature: one key signs both, and
// a cookie or token of one store never verifies in the other.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionInfo, Sessions } from "../core/context.ts";

/** The console's session cookie. */
export const COOKIE = "gateway_session";
/** The site's session cookie. */
export const SITE_COOKIE = "site_session";

type Kept<W> = { viewer: W; created: number; seen: number };

export class SessionStore<W> {
  /** The cookie this store's sessions travel in. */
  readonly cookie: string;
  readonly #scope: string;
  readonly #secret: Uint8Array;
  readonly #clock: () => Date;
  readonly #absoluteMs: number;
  readonly #idleMs: number;
  readonly #maxSessions: number;
  readonly #sessions = new Map<string, Kept<W>>();

  constructor(options: {
    secret: Uint8Array;
    clock: () => Date;
    absoluteMs: number;
    idleMs: number;
    maxSessions?: number;
    /** The cookie's name, and the scope of the signatures: COOKIE by default. */
    cookie?: string;
  }) {
    if (options.secret.length < 32) throw new Error("the session key needs 32 bytes or more");
    this.cookie = options.cookie ?? COOKIE;
    this.#scope = this.cookie;
    this.#secret = options.secret;
    this.#clock = options.clock;
    this.#absoluteMs = options.absoluteMs;
    this.#idleMs = options.idleMs;
    this.#maxSessions = options.maxSessions ?? 10_000;
  }

  #mac(purpose: string, id: string): string {
    return createHmac("sha256", this.#secret).update(`${this.#scope}:${purpose}:${id}`).digest("base64url");
  }

  /** The session a cookie value names, if its signature holds and it has not expired; it counts as a request. */
  read(cookieValue: string | undefined): { id: string; info: SessionInfo<W> } | null {
    if (cookieValue === undefined) return null;
    const dot = cookieValue.indexOf(".");
    const id = cookieValue.slice(0, dot);
    const given = Buffer.from(cookieValue.slice(dot + 1));
    const expected = Buffer.from(this.#mac("session", id));
    if (dot <= 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const kept = this.#sessions.get(id);
    if (kept === undefined) return null;
    const now = this.#clock().getTime();
    if (now - kept.created >= this.#absoluteMs || now - kept.seen >= this.#idleMs) {
      this.#sessions.delete(id);
      return null;
    }
    kept.seen = now;
    return { id, info: this.#info(id, kept) };
  }

  create(viewer: W): { id: string; cookieValue: string; info: SessionInfo<W> } {
    const id = randomBytes(24).toString("base64url");
    const now = this.#clock().getTime();
    const kept = { viewer, created: now, seen: now };
    this.#sessions.set(id, kept);
    // The oldest sessions go first when the gateway holds too many.
    for (const old of this.#sessions.keys()) {
      if (this.#sessions.size <= this.#maxSessions) break;
      this.#sessions.delete(old);
    }
    return { id, cookieValue: `${id}.${this.#mac("session", id)}`, info: this.#info(id, kept) };
  }

  destroy(id: string): boolean {
    return this.#sessions.delete(id);
  }

  /** Whether a header carries this session's CSRF token, compared in constant time. */
  csrfMatches(id: string, header: string | undefined): boolean {
    if (header === undefined) return false;
    const given = Buffer.from(header);
    const expected = Buffer.from(this.#mac("csrf", id));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  #info(id: string, kept: Kept<W>): SessionInfo<W> {
    return {
      viewer: kept.viewer,
      csrfToken: this.#mac("csrf", id),
      expiresAt: new Date(Math.min(kept.created + this.#absoluteMs, kept.seen + this.#idleMs)),
    };
  }
}

/** The value of the cookie `name` in a Cookie header. */
export function cookieValueFrom(header: string | undefined, name = COOKIE): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export function sessionCookie(value: string, options: { secure: boolean; maxAgeSeconds: number; name?: string }): string {
  return `${options.name ?? COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${options.maxAgeSeconds}${options.secure ? "; Secure" : ""}`;
}

/** The core's view of one request's session; signing in or out leaves a Set-Cookie for the response. */
export function requestSessions<W>(
  store: SessionStore<W>,
  found: { id: string; info: SessionInfo<W> } | null,
  options: { secure: boolean; maxAgeSeconds: number },
  setCookie: (header: string) => void,
): Sessions<W> & { readonly id: () => string | null } {
  let current = found;
  const cookie = { ...options, name: store.cookie };
  return {
    id: () => current?.id ?? null,
    current: () => current?.info ?? null,
    start(viewer) {
      if (current !== null) store.destroy(current.id);
      const created = store.create(viewer);
      current = { id: created.id, info: created.info };
      setCookie(sessionCookie(created.cookieValue, cookie));
      return created.info;
    },
    end() {
      if (current === null) return false;
      store.destroy(current.id);
      current = null;
      setCookie(sessionCookie("", { ...cookie, maxAgeSeconds: 0 }));
      return true;
    },
  };
}
