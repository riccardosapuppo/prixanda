// What an error becomes on its way out: the engine's gRPC codes mapped to the
// codes the clients know, the engine's own words passed on only where they
// speak to the caller, and never a stack trace.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { fromEngine } from "../src/core/errors.ts";
import { formatError } from "../src/node/http.ts";

/** The mapping the gateway promises, written here on its own. */
const EXPECTED: Array<[Code, string, boolean]> = [
  [Code.InvalidArgument, "BAD_USER_INPUT", true],
  [Code.OutOfRange, "BAD_USER_INPUT", true],
  [Code.FailedPrecondition, "BAD_USER_INPUT", true],
  [Code.AlreadyExists, "BAD_USER_INPUT", true],
  [Code.NotFound, "NOT_FOUND", true],
  [Code.PermissionDenied, "FORBIDDEN", true],
  [Code.Unauthenticated, "ENGINE_UNAVAILABLE", false],
  [Code.Unavailable, "ENGINE_UNAVAILABLE", false],
  [Code.DeadlineExceeded, "ENGINE_UNAVAILABLE", false],
  [Code.ResourceExhausted, "ENGINE_UNAVAILABLE", false],
  [Code.Aborted, "ENGINE_UNAVAILABLE", false],
  [Code.Canceled, "ENGINE_UNAVAILABLE", false],
  [Code.Internal, "INTERNAL_SERVER_ERROR", false],
  [Code.Unknown, "INTERNAL_SERVER_ERROR", false],
  [Code.DataLoss, "INTERNAL_SERVER_ERROR", false],
  [Code.Unimplemented, "INTERNAL_SERVER_ERROR", false],
];

describe("errors of the engine", () => {
  test("every gRPC code has its place", () => {
    const all = Object.values(Code).filter((value): value is Code => typeof value === "number");
    assert.equal(all.length, 16);
    assert.deepEqual(all.sort((a, b) => a - b), EXPECTED.map(([code]) => code).sort((a, b) => a - b));
  });

  for (const [code, expected, speaks] of EXPECTED) {
    test(`${Code[code]} becomes ${expected}, ${speaks ? "with" : "without"} the engine's sentence for the console`, () => {
      const engine = new ConnectError("the engine's own sentence", code);
      const forConsole = fromEngine(engine, true);
      const forSite = fromEngine(engine, false);
      assert.equal(forConsole.extensions["code"], expected);
      assert.equal(forSite.extensions["code"], expected);
      assert.equal(forConsole.message.includes("the engine's own sentence"), speaks);
      assert.ok(!forSite.message.includes("the engine's own sentence"), "the site never gets the engine's words");
    });
  }

  test("an error that is not the engine's is internal", () => {
    assert.equal(fromEngine(new TypeError("x is undefined"), true).extensions["code"], "INTERNAL_SERVER_ERROR");
    assert.ok(!fromEngine(new TypeError("x is undefined"), true).message.includes("undefined"));
  });
});

describe("formatError", () => {
  test("keeps the message and code meant for the client, and drops what libraries add", () => {
    const formatted = formatError({
      message: "Sign in first: this needs a session.",
      locations: [{ line: 1, column: 3 }],
      path: ["overview"],
      extensions: { code: "UNAUTHENTICATED", stacktrace: ["Error: at resolver (core/x.ts:1)"], exception: { secret: 1 } },
    });
    assert.deepEqual(formatted, { message: "Sign in first: this needs a session.", locations: [{ line: 1, column: 3 }], path: ["overview"], extensions: { code: "UNAUTHENTICATED" } });
  });

  test("turns anything else into a generic internal error", () => {
    for (const extensions of [{ code: "INTERNAL_SERVER_ERROR" }, { code: "SOMETHING_NEW" }, {}]) {
      const formatted = formatError({ message: "Cannot read properties of undefined (reading 'id') at /srv/gateway/core.ts:42", extensions });
      assert.equal(formatted.extensions?.["code"], "INTERNAL_SERVER_ERROR");
      assert.doesNotMatch(formatted.message, /undefined|\.ts/);
    }
  });
});
