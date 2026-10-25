// The engine in the page, as the gateway's side of the worker uses it: the
// interface of src/engine/, the engine's side of the package. The gateway's
// side codes against this shape only; src/backend.ts gives it the engine's
// own startEngine, the tests a fake. A change to it is made on both sides at
// once.
import type { Changed, LaunchStep } from "../protocol.ts";

export type EngineReply =
  | { readonly ok: true; readonly response: Uint8Array }
  | { readonly ok: false; readonly code: number /* a gRPC code */; readonly message: string };

export type BrowserEngine = {
  /**
   * One call of the contract: the service and method as proto/ names them
   * ("commerce.v1.ChangeService", "SubmitChange"), the metadata as the gateway
   * writes it (x-request-id, x-actor, x-actor-role, idempotency-key,
   * authorization), the request in binary; the response in binary, or the
   * gRPC code. A wrong token is code 16, UNAUTHENTICATED, as on the server.
   */
  call(service: string, method: string, metadata: Readonly<Record<string, string>>, request: Uint8Array): Promise<EngineReply>;
  /** The jobs due at the demo's time: launch steps, the outbox, the provider's events, alarms; what they changed. */
  tick(): Promise<{ readonly ran: number; readonly changed: readonly Changed[] }>;
  readonly clock: {
    now(): Date;
    /** Forward only: an instant not after the demo's time leaves the clock where it is; an invalid date is a RangeError. */
    advanceTo(instant: Date): void;
    /** When the next launch is due (its start less the minute ahead, or its next try); null when none is. */
    nextDue(): Promise<Date | null>;
  };
  /** The simulated fault: the next launch fails once at the step; the recovery is the engine's real code. */
  readonly faults: { arm(step: LaunchStep): void; clear(): void; armed(): string | null };
  /**
   * To the next launch due, its steps run, its tries after a simulated fault
   * too, and on to its change's start, so that the offer is in force; it
   * stops where a launch is refused or fails. Null when nothing is due.
   * `changed` holds the jobs of the days skipped too.
   */
  skipToNextLaunch(): Promise<{ readonly from: Date; readonly to: Date; readonly changed: readonly Changed[] } | null>;
  /** Back to the build's snapshot: IndexedDB cleared, the database opened again; calls that arrive meanwhile wait. */
  reset(): Promise<void>;
};

export type StartEngine = (options: {
  /** Where the build serves the engine's files: /sandbox/. */
  readonly base: string;
  /** The IndexedDB database the data lives in. */
  readonly database: string;
  /** The internal token every call must carry, made at random by the worker. */
  readonly token: string;
  readonly onProgress?: (step: string) => void;
}) => Promise<BrowserEngine>;
