// Requests no browser would send, written by hand on a raw socket: the
// gateway answers each one, and keeps answering the next ones. A request must
// never take the process down: both APIs live in the same one.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, before, describe, test } from "node:test";
import { type Harness, PORTS, startHarness } from "./support/harness.ts";

/** Sends `text` on a new connection and returns everything the server wrote back before closing it. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let answer = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => (answer += chunk));
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      resolve(answer);
    });
  });
}

const request = (target: string) => `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`;

let harness: Harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness.close();
});

describe("a request target that is not a path", () => {
  for (const target of ["//[", "http://[", "//[::1", "http://user@[x]/graphql"]) {
    test(`${target}: 400 on both ports, and both keep answering`, async () => {
      for (const port of [PORTS.internal, PORTS.public]) {
        const answer = await raw(port, request(target));
        assert.match(answer, /^HTTP\/1\.1 400 /, `port ${port}: ${JSON.stringify(answer.slice(0, 200))}`);
        assert.match(answer, /"code":"BAD_REQUEST"/);
        assert.match(answer, /x-request-id: [0-9a-f-]{36}\r\n/i);
        const next = await raw(port, request("/health"));
        assert.match(next, /^HTTP\/1\.1 200 /, `port ${port} still answers`);
      }
    });
  }
});

describe("whatever goes wrong outside the handler's own answers", () => {
  test("is caught by the server's last guard and written to the log; the server goes on", async () => {
    // A logger that throws makes the handler's own last step fail: what the
    // server's guard is for.
    const failing = harness.logs.push.bind(harness.logs);
    let thrown = 0;
    harness.logs.push = (...entries) => {
      if (entries.some((entry) => entry["msg"] === "request") && thrown === 0) {
        thrown += 1;
        throw new Error("the log is full");
      }
      return failing(...entries);
    };
    try {
      const answer = await raw(PORTS.public, request("/health"));
      assert.match(answer, /^HTTP\/1\.1 200 /, "the answer had already gone when the log failed");
    } finally {
      harness.logs.push = failing;
    }
    assert.equal(thrown, 1);
    assert.ok(harness.logs.some((entry) => entry["msg"] === "request handler failed"), JSON.stringify(harness.logs.slice(-3)));
    const next = await raw(PORTS.public, request("/health"));
    assert.match(next, /^HTTP\/1\.1 200 /);
  });
});
