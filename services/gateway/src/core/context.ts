// What a resolver receives besides its parent and arguments: who is asking,
// the request's id, and the engine bound to that request.
import type { Change } from "contracts/commerce/v1/changes";
import type { Person } from "contracts/commerce/v1/overview";
import type DataLoader from "dataloader";
import { type Actor, type CallSettings, type EngineCalls, type EngineClient, engineCalls } from "./engine.ts";
import { createLoaders } from "./loaders.ts";
import type { RoleName } from "./roles.ts";

/** Who the console's session says is asking: a person of the demo and the roles the engine lists for them. */
export type Viewer = { readonly personId: string; readonly label: string; readonly roles: readonly RoleName[] };

/** Who the site's session says is asking: one of the demo's listeners, as the engine listed them at the entrance. */
export type Listener = { readonly subscriberId: string; readonly market: string; readonly title: string };

/** A session of either API: who it is for, the CSRF token its mutations carry, and when it ends. */
export type SessionInfo<W = Viewer> = { readonly viewer: W; readonly csrfToken: string; readonly expiresAt: Date };

/**
 * The session of the request, kept by the shell: a signed cookie in the Node
 * server, the page's own state in the browser of stage 8. DEMONSTRATION MODE:
 * start() takes a person of the demo, or one of the demo's listeners, and is
 * not authentication.
 */
export interface Sessions<W = Viewer> {
  current(): SessionInfo<W> | null;
  start(viewer: W): SessionInfo<W>;
  /** False when there was no session. */
  end(): boolean;
}

export type Loaders = {
  /** One BatchGetChanges for every change a request asks for in the same tick (or one GetChange each, without batching). */
  readonly change: DataLoader<string, Change>;
  /** The demo's people, listed once per request. */
  readonly people: () => Promise<ReadonlyMap<string, Person>>;
};

export type InternalContext = {
  readonly endpoint: "internal";
  readonly requestId: string;
  readonly sessions: Sessions;
  /** The engine acting as `actor`; null only for the public methods. */
  readonly engine: (actor: Actor | null) => EngineCalls;
  readonly loaders: Loaders;
};

export type PublicContext = {
  readonly endpoint: "public";
  readonly requestId: string;
  /** The listener chosen at the site's entrance; null where the site has no sessions (in production). */
  readonly sessions: Sessions<Listener> | null;
  /**
   * The engine's public methods, which act for nobody, and the subscriber's,
   * which act for the session's listener: their subscriber id is written from
   * the session at the moment of the call, never from the request.
   */
  readonly engine: EngineCalls;
};

export function createInternalContext(options: {
  client: EngineClient;
  settings: CallSettings;
  sessions: Sessions;
  /** False only to measure what the DataLoader saves. */
  batch?: boolean;
}): InternalContext {
  const { client, settings, sessions } = options;
  const engine = (actor: Actor | null) => engineCalls(client, settings, actor);
  // Reads act in the viewer's first role: every role may read changes (§12).
  const reader = (): EngineCalls => {
    const viewer = sessions.current()?.viewer;
    const role = viewer?.roles[0];
    return engine(viewer && role ? { id: viewer.personId, role } : null);
  };
  return {
    endpoint: "internal",
    requestId: settings.requestId,
    sessions,
    engine,
    loaders: createLoaders(reader, engine(null), options.batch ?? true),
  };
}

export function createPublicContext(options: { client: EngineClient; settings: CallSettings; sessions: Sessions<Listener> | null }): PublicContext {
  const { client, settings, sessions } = options;
  return {
    endpoint: "public",
    requestId: settings.requestId,
    sessions,
    // Read when each call starts: a listener who signs in during a request is the one the next call acts for.
    engine: engineCalls(client, settings, null, () => sessions?.current()?.viewer.subscriberId ?? null),
  };
}
