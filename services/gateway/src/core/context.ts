// What a resolver receives besides its parent and arguments: who is asking,
// the request's id, and the engine bound to that request.
import type { Change } from "contracts/commerce/v1/changes";
import type { Person } from "contracts/commerce/v1/overview";
import type DataLoader from "dataloader";
import { type Actor, type CallSettings, type EngineCalls, type EngineClient, engineCalls } from "./engine.ts";
import { createLoaders } from "./loaders.ts";
import type { RoleName } from "./roles.ts";

/** Who the session says is asking: a person of the demo and the roles the engine lists for them. */
export type Viewer = { readonly personId: string; readonly label: string; readonly roles: readonly RoleName[] };

export type SessionInfo = { readonly viewer: Viewer; readonly csrfToken: string; readonly expiresAt: Date };

/**
 * The session of the request, kept by the shell: a signed cookie in the Node
 * server, the page's own state in the browser of stage 8. DEMONSTRATION MODE:
 * start() takes a person of the demo and is not authentication.
 */
export interface Sessions {
  current(): SessionInfo | null;
  start(viewer: Viewer): SessionInfo;
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
  /** The site acts for nobody: only the engine's public methods answer it. */
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

export function createPublicContext(options: { client: EngineClient; settings: CallSettings }): PublicContext {
  return { endpoint: "public", requestId: options.settings.requestId, engine: engineCalls(options.client, options.settings, null) };
}
