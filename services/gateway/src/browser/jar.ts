// The sessions of the demo in the browser (stage 8): DEMONSTRATION MODE, not
// authentication, as on Node. The sandbox's worker keeps them as a browser
// keeps the cookies of an origin: one per API, shared by every tab of the
// origin. Signing in on one tab signs every tab in, and signing out on one
// signs every tab out, as a cookie would. Nothing leaves the worker, so no
// signature is needed: the id and the CSRF token are random, and a session
// ends after a working day, or an hour without a request, by the injected
// clock; a reset of the demo ends them all.
import type { SessionInfo, Sessions } from "../core/context.ts";

type Kept<W> = { readonly id: string; readonly viewer: W; readonly csrfToken: string; readonly created: number; seen: number };

/** Random bytes as base64url, from Web Crypto: the browser's and Node 24's own. */
function randomText(bytes: number): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of random) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export class SessionJar<W> {
  readonly #clock: () => Date;
  readonly #absoluteMs: number;
  readonly #idleMs: number;
  #kept: Kept<W> | null = null;

  constructor(options: { clock: () => Date; absoluteMs: number; idleMs: number }) {
    this.#clock = options.clock;
    this.#absoluteMs = options.absoluteMs;
    this.#idleMs = options.idleMs;
  }

  /** The session, as a browser would send its cookie: null when there is none or it has expired; reading it counts as a request. */
  read(): { id: string; info: SessionInfo<W> } | null {
    const kept = this.#kept;
    if (kept === null) return null;
    const now = this.#clock().getTime();
    if (now - kept.created >= this.#absoluteMs || now - kept.seen >= this.#idleMs) {
      this.#kept = null;
      return null;
    }
    kept.seen = now;
    return { id: kept.id, info: this.#info(kept) };
  }

  /** A new session for a viewer, with a new id and a new token: the one before ends. */
  start(viewer: W): { id: string; info: SessionInfo<W> } {
    const now = this.#clock().getTime();
    const kept: Kept<W> = { id: randomText(24), viewer, csrfToken: randomText(24), created: now, seen: now };
    this.#kept = kept;
    return { id: kept.id, info: this.#info(kept) };
  }

  /** Ends the session `id`, if it is still the jar's; false otherwise. */
  end(id: string): boolean {
    if (this.#kept?.id !== id) return false;
    this.#kept = null;
    return true;
  }

  /** Every session ends, as the cookies of an origin cleared. */
  clear(): void {
    this.#kept = null;
  }

  /** Whether a header carries the session `id`'s CSRF token. */
  csrfMatches(id: string, header: string | undefined): boolean {
    return header !== undefined && this.#kept?.id === id && this.#kept.csrfToken === header;
  }

  #info(kept: Kept<W>): SessionInfo<W> {
    return {
      viewer: kept.viewer,
      csrfToken: kept.csrfToken,
      expiresAt: new Date(Math.min(kept.created + this.#absoluteMs, kept.seen + this.#idleMs)),
    };
  }
}

/** The core's view of one request's session in a jar: what start() and end() do, every tab sees at its next request. */
export function jarSessions<W>(jar: SessionJar<W>, found: { id: string; info: SessionInfo<W> } | null): Sessions<W> {
  let current = found;
  return {
    current: () => current?.info ?? null,
    start(viewer) {
      current = jar.start(viewer);
      return current.info;
    },
    end() {
      if (current === null) return false;
      jar.end(current.id);
      current = null;
      return true;
    },
  };
}
