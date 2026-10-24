// The engine, as the gateway's core sees it: the commerce contract's services
// behind a Connect transport. Today the Node shell gives it a gRPC transport
// (src/node/grpc.ts); in stage 8 the browser will give it a transport that
// reaches the engine running in the page. The core never imports a transport.
//
// Every call goes through engineCalls(), which writes the metadata the way the
// contract and the coordinator's conventions say, so that no resolver can
// forget it: x-request-id always; x-actor and x-actor-role on every method
// that acts for a person, never on the public ones; idempotency-key on the
// methods that change something, and only there; and, on the subscriber's
// methods, the subscriber id of the site's session, whatever the request said.
import { type CallOptions, type Client, Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { AuditService } from "contracts/commerce/v1/audit";
import { CatalogService } from "contracts/commerce/v1/catalog";
import { ChangeService } from "contracts/commerce/v1/changes";
import { LaunchService } from "contracts/commerce/v1/launches";
import { OverviewService, PeopleService } from "contracts/commerce/v1/overview";
import { QuoteService } from "contracts/commerce/v1/quotes";
import { SimulationService } from "contracts/commerce/v1/simulation";
import { SubscriberService } from "contracts/commerce/v1/subscriptions";
import { fromEngine, gatewayError } from "./errors.ts";
import { anyKind, METHOD_ROLES, type MethodName, PUBLIC_METHODS, type RoleName, SUBSCRIBER_METHODS } from "./roles.ts";

export const SERVICES = {
  catalog: CatalogService,
  changes: ChangeService,
  quotes: QuoteService,
  simulation: SimulationService,
  audit: AuditService,
  overview: OverviewService,
  people: PeopleService,
  subscribers: SubscriberService,
  launches: LaunchService,
} as const;

type Services = typeof SERVICES;

export type EngineClient = { readonly [K in keyof Services]: Client<Services[K]> };

export function createEngineClient(transport: Transport): EngineClient {
  return {
    catalog: createClient(CatalogService, transport),
    changes: createClient(ChangeService, transport),
    quotes: createClient(QuoteService, transport),
    simulation: createClient(SimulationService, transport),
    audit: createClient(AuditService, transport),
    overview: createClient(OverviewService, transport),
    people: createClient(PeopleService, transport),
    subscribers: createClient(SubscriberService, transport),
    launches: createClient(LaunchService, transport),
  };
}

/**
 * The methods that change something carry an idempotency key, and the engine
 * refuses them without one (the engine's behaviour 2): ChangeService's
 * writes, GetQuote, which saves a quote, ExportHead, which writes
 * audit.exported, the subscriber's VerifyStudent, ConfirmQuote and
 * AnswerPriceChange, and the on-call engineer's RetryLaunch and CancelLaunch.
 */
export const IDEMPOTENT_METHODS = [
  "CreateChange", "SaveVersion", "ValidateChange", "SubmitChange", "ApproveChange", "RejectChange",
  "ScheduleChange", "CancelChange", "SuspendChange", "GetQuote", "ExportHead", "VerifyStudent", "ConfirmQuote",
  "RetryLaunch", "CancelLaunch", "AnswerPriceChange", "BuyPrepaidPass", "ActivatePrepaidPass",
] as const;

export type Actor = { readonly id: string; readonly role: RoleName };

export type EngineCallEvent = {
  readonly method: string;
  readonly ok: boolean;
  readonly ms: number;
  /** The gRPC code's name when the call failed. */
  readonly code?: string;
  readonly message?: string;
};

/** What every call of one request shares. */
export type CallSettings = {
  readonly requestId: string;
  /** From the Idempotency-Key header; null when the client sent none. */
  readonly idempotencyKey: string | null;
  /** Whether the engine's own sentence may reach the client (the console) or not (the site). */
  readonly detailedErrors: boolean;
  readonly timeouts: { readonly readMs: number; readonly writeMs: number };
  /** Told about every call, for the logs. */
  readonly observe?: (event: EngineCallEvent) => void;
};

type Unary<F> = F extends (request: infer R, options?: CallOptions) => Promise<infer O> ? (request: R) => Promise<O> : never;

/** The engine's methods with the metadata already written: only the request is left to pass. */
export type EngineCalls = { readonly [K in keyof EngineClient]: { readonly [M in keyof EngineClient[K]]: Unary<EngineClient[K][M]> } };

const isPublic = (name: string) => (PUBLIC_METHODS as readonly string[]).includes(name);
const isSubscriber = (name: string) => (SUBSCRIBER_METHODS as readonly string[]).includes(name);
const isIdempotent = (name: string) => (IDEMPOTENT_METHODS as readonly string[]).includes(name);
const isRestricted = (name: string): name is MethodName => Object.hasOwn(METHOD_ROLES, name);

/**
 * The engine's methods for one request, acting as `actor`: null for the
 * public site, or before anyone has signed in. A method that acts for a
 * person refuses to start without one, and with a role the matrix does not
 * allow for it: the gateway never sends the engine a call it knows is wrong.
 * The subscriber's methods act for `subscriber()`, the listener of the site's
 * session when the call starts, and refuse to start without one; the
 * subscriber id they send is that one, whatever the request carried.
 */
export function engineCalls(
  client: EngineClient,
  settings: CallSettings,
  actor: Actor | null,
  subscriber: () => string | null = () => null,
): EngineCalls {
  const bound: Record<string, Record<string, (request: unknown) => Promise<unknown>>> = {};
  for (const [key, service] of Object.entries(SERVICES) as Array<[keyof Services, Services[keyof Services]]>) {
    const methods: Record<string, (request: unknown) => Promise<unknown>> = {};
    const raw = client[key] as unknown as Record<string, (request: unknown, options: CallOptions) => Promise<unknown>>;
    for (const method of service.methods) {
      const name = method.name;
      if (!isPublic(name) && !isSubscriber(name) && !isRestricted(name)) {
        throw new Error(`the role matrix (roles.ts) does not list the engine method ${name}`);
      }
      const writes = isIdempotent(name);
      methods[method.localName] = async (given) => {
        let request = given;
        const headers: Record<string, string> = { "x-request-id": settings.requestId };
        if (isSubscriber(name)) {
          const subscriberId = subscriber();
          if (subscriberId === null) throw gatewayError("UNAUTHENTICATED", "Choose a listener first: this needs the site's session.");
          request = { ...(given as object), subscriberId };
        }
        if (isRestricted(name)) {
          if (actor === null) throw gatewayError("UNAUTHENTICATED", "Sign in first: this needs a session.");
          if (!anyKind(METHOD_ROLES[name]).includes(actor.role)) {
            throw gatewayError("FORBIDDEN", `The ${actor.role} role may not call ${name}.`);
          }
          headers["x-actor"] = actor.id;
          headers["x-actor-role"] = actor.role;
        }
        if (writes) {
          if (settings.idempotencyKey === null) {
            throw gatewayError("BAD_USER_INPUT", "This mutation needs an Idempotency-Key header: a new random value for each action, the same one when retrying it.");
          }
          headers["idempotency-key"] = settings.idempotencyKey;
        }
        const started = performance.now();
        const fn = raw[method.localName];
        if (fn === undefined) throw new Error(`the engine client has no method ${method.localName}`);
        try {
          const response = await fn(request, { headers, timeoutMs: writes ? settings.timeouts.writeMs : settings.timeouts.readMs });
          settings.observe?.({ method: name, ok: true, ms: Math.round(performance.now() - started) });
          return response;
        } catch (error) {
          const engine = ConnectError.from(error);
          settings.observe?.({ method: name, ok: false, ms: Math.round(performance.now() - started), code: codeName(engine), message: engine.rawMessage });
          throw fromEngine(engine, settings.detailedErrors);
        }
      };
    }
    bound[key] = methods;
  }
  return bound as unknown as EngineCalls;
}

function codeName(error: ConnectError): string {
  // Code is a numeric enum: its reverse mapping gives the name.
  return (Code as unknown as Record<number, string>)[error.code] ?? String(error.code);
}
