// The messages between a tab of the demo, the site's or the console's, and
// the sandbox's worker, both ways (stage 8, the demo in the browser). The
// gateway's side of the package writes this file, the engine's side and the
// apps read it: a change to it is made on every side at once.
//
// One worker for the whole origin. A SharedWorker is the same instance only
// for the same script address and the same name: the worker is built on its
// own, served at WORKER_URL, and every app opens it under WORKER_NAME
// (openBackend in client.ts). Chromium lets no SharedWorker start workers of
// its own, so PGlite, the engine in Pyodide and the gateway's core share its
// one thread. Where SharedWorker is missing (Chrome on Android) a dedicated
// worker serves one tab at a time, over the same messages.
//
// How a tab talks to it:
//   - it says hello first, with its app and its build;
//   - the worker answers progress while it starts, which happens once per
//     origin: a tab that arrives later gets ready at once, alreadyRunning;
//     ready carries the worker's build, and a tab of another build reloads
//     (an old deploy's tab that finds a new worker, or the other way round);
//     failed says why the worker could not start;
//   - a graphql message imitates an HTTP request to the gateway: the same
//     headers (names in lower case), the same JSON body, and a reply with the
//     status, headers and body the HTTP shell sends. No cookie travels: the
//     worker keeps each API's session as a browser keeps cookies for an
//     origin, one per API and shared by every tab, and the CSRF token goes in
//     x-csrf-token as over HTTP;
//   - a command is one of the demo's controls (sign in with a role is the
//     APIs' own signIn); its reply carries a JSON body, CommandResults below;
//   - after the engine's jobs ran, the worker tells every tab what to read
//     again (changed), where the full system's outbox would notify the site;
//     after a reset, that the demo started over (reset), and the tabs read
//     everything again, signed out.
//
// Every message is a plain object a structured clone carries; the parse*
// functions below refuse anything else, so that neither side acts on a
// message of the wrong shape.

/** Where the worker's script is served, and the name every app opens it under. */
export const WORKER_URL = "/sandbox/backend.js";
export const WORKER_NAME = "offers-sandbox";

export const APPS = ["site", "console"] as const;
export type App = (typeof APPS)[number];

/** The gateway's two APIs: the console's (internal) and the site's (public). */
export const APIS = ["internal", "public"] as const;
export type Api = (typeof APIS)[number];

/** What the engine's jobs can change, as its tick() names it: the tabs read these again. */
export const CHANGES = ["catalog", "changes", "launches", "accounts", "audit"] as const;
export type Changed = (typeof CHANGES)[number];

/** The demo's controls. */
export const COMMANDS = ["status", "reset", "arm-fault", "clear-fault", "skip-to-next-launch"] as const;
export type CommandName = (typeof COMMANDS)[number];

/** The steps of a launch (§7.5, stage 6), where the simulated fault can be armed. */
export const LAUNCH_STEPS = ["check", "prepare", "publish", "notify", "verify"] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];

// ----- from a tab to the worker -----

export type Hello = { readonly kind: "hello"; readonly app: App; readonly build: string };

/** A request to one of the APIs, as the HTTP shell would get it at /graphql: id is the tab's own, positive and new for each request. */
export type GraphqlRequest = {
  readonly kind: "graphql";
  readonly id: number;
  readonly api: Api;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type Command = { readonly kind: "command"; readonly id: number; readonly name: CommandName; readonly args?: unknown };

export type ToWorker = Hello | GraphqlRequest | Command;

// ----- from the worker to a tab -----

/** The worker starting, one step after the other: loading Pyodide, opening the database, applying the migrations… */
export type Progress = { readonly kind: "progress"; readonly step: string; readonly done: number; readonly of: number };

export type ReadyInfo = {
  /** How long the worker took to start, in milliseconds; the first tab's, for the tabs that came later. */
  readonly bootMs: number;
  /** Another tab had started the worker already. */
  readonly alreadyRunning: boolean;
  /** The worker's build: a tab of another build reloads. */
  readonly build: string;
  /** The demo's clock, ISO 8601 with Z. */
  readonly now: string;
};

export type Ready = { readonly kind: "ready"; readonly info: ReadyInfo };
export type Failed = { readonly kind: "failed"; readonly reason: string };

/** The answer to a graphql request or a command, with the id it came with. */
export type Reply = {
  readonly kind: "reply";
  readonly id: number;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type ChangedMessage = { readonly kind: "changed"; readonly what: readonly Changed[] };
export type Reset = { readonly kind: "reset" };

export type FromWorker = Progress | Ready | Failed | Reply | ChangedMessage | Reset;

// ----- the commands -----

/** What each command takes in args: only arm-fault takes any. */
export type CommandArgs = {
  readonly status: undefined;
  readonly reset: undefined;
  readonly "arm-fault": { readonly step: LaunchStep };
  readonly "clear-fault": undefined;
  readonly "skip-to-next-launch": undefined;
};

/** Where the demo stands. */
export type Status = {
  readonly build: string;
  readonly now: string;
  /** When the next launch is due on the demo's clock (its start less the minute ahead, or its next try); null when none is. */
  readonly nextDue: string | null;
  /** The step the simulated fault is armed at, for the next launch; null when none. */
  readonly armed: LaunchStep | null;
  /**
   * SharedWorker, or a dedicated worker for this one tab. (How many tabs are
   * open it cannot say: a browser does not tell a SharedWorker when one of
   * its tabs closes.)
   */
  readonly shared: boolean;
};

/**
 * Each command's reply body, with status 200: JSON of these. A command that
 * cannot be done now replies 409, and one of the wrong shape 400, both with
 * { error } in words.
 */
export type CommandResults = {
  readonly status: Status;
  /** The demo started over from the build's snapshot: every tab got { kind: "reset" }. */
  readonly reset: { readonly now: string };
  readonly "arm-fault": { readonly armed: LaunchStep };
  readonly "clear-fault": { readonly armed: null };
  /**
   * The demo's clock moved to the next launch due, the launch ran (its tries
   * after a simulated fault too), and the clock stopped at its change's start:
   * from and to are the demo's times before and after, ISO 8601 with Z, and
   * changed what the tabs read again, as every tab is told. 409 when no launch
   * is due.
   */
  readonly "skip-to-next-launch": { readonly from: string; readonly to: string; readonly changed: readonly Changed[] };
};

export type CommandError = { readonly error: string };

// ----- reading a message -----

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

/** Headers as plain strings, names in lower case. */
function isHeaders(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.entries(value).every(([name, text]) => name === name.toLowerCase() && typeof text === "string");
}

/** A message a tab sent, or null when it is not one: the worker answers nothing to what it cannot read. */
export function parseToWorker(data: unknown): ToWorker | null {
  if (!isObject(data)) return null;
  switch (data["kind"]) {
    case "hello":
      return oneOf(APPS, data["app"]) && typeof data["build"] === "string" ? { kind: "hello", app: data["app"], build: data["build"] } : null;
    case "graphql":
      return isId(data["id"]) && oneOf(APIS, data["api"]) && isHeaders(data["headers"]) && typeof data["body"] === "string"
        ? { kind: "graphql", id: data["id"], api: data["api"], headers: data["headers"], body: data["body"] }
        : null;
    case "command":
      return isId(data["id"]) && oneOf(COMMANDS, data["name"])
        ? { kind: "command", id: data["id"], name: data["name"], ...(data["args"] === undefined ? {} : { args: data["args"] }) }
        : null;
    default:
      return null;
  }
}

/** A message the worker sent, or null when it is not one. */
export function parseFromWorker(data: unknown): FromWorker | null {
  if (!isObject(data)) return null;
  switch (data["kind"]) {
    case "progress":
      return typeof data["step"] === "string" && Number.isSafeInteger(data["done"]) && Number.isSafeInteger(data["of"])
        ? { kind: "progress", step: data["step"], done: data["done"] as number, of: data["of"] as number }
        : null;
    case "ready": {
      const info = data["info"];
      return isObject(info) && typeof info["bootMs"] === "number" && typeof info["alreadyRunning"] === "boolean"
        && typeof info["build"] === "string" && typeof info["now"] === "string"
        ? { kind: "ready", info: { bootMs: info["bootMs"], alreadyRunning: info["alreadyRunning"], build: info["build"], now: info["now"] } }
        : null;
    }
    case "failed":
      return typeof data["reason"] === "string" ? { kind: "failed", reason: data["reason"] } : null;
    case "reply":
      return isId(data["id"]) && Number.isSafeInteger(data["status"]) && isHeaders(data["headers"]) && typeof data["body"] === "string"
        ? { kind: "reply", id: data["id"], status: data["status"] as number, headers: data["headers"], body: data["body"] }
        : null;
    case "changed": {
      const what = data["what"];
      return Array.isArray(what) && what.every((entry) => oneOf(CHANGES, entry)) ? { kind: "changed", what: what as Changed[] } : null;
    }
    case "reset":
      return { kind: "reset" };
    default:
      return null;
  }
}

/** arm-fault's args, or null: the step must be one of a launch's. */
export function parseArmFault(args: unknown): CommandArgs["arm-fault"] | null {
  return isObject(args) && oneOf(LAUNCH_STEPS, args["step"]) ? { step: args["step"] } : null;
}
