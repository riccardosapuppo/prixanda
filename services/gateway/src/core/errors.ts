// Errors that leave the gateway. A business refusal is not one of them: it is
// an answer, typed as a Refusal in a mutation's result. What is left are the
// technical errors, each with its extensions.code, and never a stack trace.
import { Code, ConnectError } from "@connectrpc/connect";
import { GraphQLError } from "graphql";

export const ERROR_CODES = [
  "UNAUTHENTICATED", // no session, or it ended
  "FORBIDDEN", // the session's roles may not read this (§12)
  "NOT_FOUND", // no such change, person or offer
  "BAD_USER_INPUT", // malformed arguments or headers; the engine refused them as malformed
  "ENGINE_UNAVAILABLE", // the engine did not answer in time, or could not be reached
  "INTERNAL_SERVER_ERROR", // anything else: the message is generic, the log has the rest
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function gatewayError(code: ErrorCode, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

/** What an engine error becomes, and whether its own message may be shown. */
const FROM_ENGINE: Record<Code, { code: ErrorCode; message: string; passMessage: boolean }> = {
  [Code.InvalidArgument]: { code: "BAD_USER_INPUT", message: "The engine refused the request as malformed.", passMessage: true },
  [Code.OutOfRange]: { code: "BAD_USER_INPUT", message: "The engine refused a value as out of range.", passMessage: true },
  [Code.FailedPrecondition]: { code: "BAD_USER_INPUT", message: "The engine refused the request in its current state.", passMessage: true },
  [Code.AlreadyExists]: { code: "BAD_USER_INPUT", message: "The engine already has this.", passMessage: true },
  [Code.NotFound]: { code: "NOT_FOUND", message: "Not found.", passMessage: true },
  [Code.PermissionDenied]: { code: "FORBIDDEN", message: "The engine does not let this session do that.", passMessage: true },
  // The engine refusing the gateway's own token is the gateway's misconfiguration,
  // not the person's fault: to them the engine is unavailable, and the log says why.
  [Code.Unauthenticated]: { code: "ENGINE_UNAVAILABLE", message: "The engine is not available.", passMessage: false },
  [Code.Unavailable]: { code: "ENGINE_UNAVAILABLE", message: "The engine is not available.", passMessage: false },
  [Code.DeadlineExceeded]: { code: "ENGINE_UNAVAILABLE", message: "The engine did not answer in time.", passMessage: false },
  [Code.ResourceExhausted]: { code: "ENGINE_UNAVAILABLE", message: "The engine is busy.", passMessage: false },
  [Code.Aborted]: { code: "ENGINE_UNAVAILABLE", message: "The engine gave up on the request; try again.", passMessage: false },
  [Code.Canceled]: { code: "ENGINE_UNAVAILABLE", message: "The call to the engine was cancelled.", passMessage: false },
  [Code.Internal]: { code: "INTERNAL_SERVER_ERROR", message: "Internal error.", passMessage: false },
  [Code.Unknown]: { code: "INTERNAL_SERVER_ERROR", message: "Internal error.", passMessage: false },
  [Code.DataLoss]: { code: "INTERNAL_SERVER_ERROR", message: "Internal error.", passMessage: false },
  [Code.Unimplemented]: { code: "INTERNAL_SERVER_ERROR", message: "Internal error.", passMessage: false },
};

/**
 * An error of a call to the engine as the client sees it. `detailed` lets the
 * engine's own sentence through for the codes where it speaks to the caller
 * (malformed, not found, not allowed): the console's people can act on it,
 * while the public site gets the gateway's fixed sentence.
 */
export function fromEngine(error: unknown, detailed: boolean): GraphQLError {
  const engine = ConnectError.from(error);
  const mapped = FROM_ENGINE[engine.code];
  const message = detailed && mapped.passMessage && engine.rawMessage ? `${mapped.message} ${engine.rawMessage.slice(0, 300)}` : mapped.message;
  return new GraphQLError(message, { extensions: { code: mapped.code }, originalError: engine });
}

/** The engine broke the contract: a field it must send is missing, an enum value is unknown. */
export function contractBroken(what: string): GraphQLError {
  return new GraphQLError(`The engine broke the contract: ${what}`, { extensions: { code: "INTERNAL_SERVER_ERROR" } });
}

/** The same, thrown: for `value ?? breach("what is missing")`. */
export function breach(what: string): never {
  throw contractBroken(what);
}
