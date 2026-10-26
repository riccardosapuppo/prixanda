// The worker's fetch that tries a dropped download again (src/retry.ts): a GET
// that failed before any answer is tried again, up to three times, with
// growing pauses; an answer, even a 503, comes back at once; a POST, an
// aborted request and an error that is not the network's are not tried again.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { retryingFetch } from "../src/retry.ts";

/** A fetch that fails as told, then answers 200: the calls it got, and the pauses the retries took. */
function flaky(failures: unknown[]) {
  const calls: string[] = [];
  const pauses: number[] = [];
  const plain = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const fetch = retryingFetch(plain, { sleep: async (ms) => { pauses.push(ms); } });
  return { fetch, calls, pauses };
}

describe("the worker's fetch", () => {
  test("a GET the network dropped is tried again, with growing pauses, and its answer comes back", async () => {
    const { fetch, calls, pauses } = flaky([new TypeError("Failed to fetch"), new TypeError("Failed to fetch")]);
    const answer = await fetch("/sandbox/runtime-0123456789ab/pyodide/pyodide.asm.wasm");
    assert.equal(answer.status, 200);
    assert.equal(calls.length, 3);
    assert.deepEqual(pauses, [500, 1000]);
  });

  test("three drops in a row: the third failure is the one thrown", async () => {
    const { fetch, calls } = flaky([new TypeError("one"), new TypeError("two"), new TypeError("three")]);
    await assert.rejects(fetch("/sandbox/engine/manifest.json"), { name: "TypeError", message: "three" });
    assert.equal(calls.length, 3);
  });

  test("an answer comes back as it came, even a server error", async () => {
    const plain = (async () => new Response("busy", { status: 503 })) as typeof fetch;
    let pauses = 0;
    const answer = await retryingFetch(plain, { sleep: async () => { pauses += 1; } })("/sandbox/engine/manifest.json");
    assert.equal(answer.status, 503);
    assert.equal(pauses, 0);
  });

  test("a POST, an aborted request and an error that is not the network's are not tried again", async () => {
    const post = flaky([new TypeError("Failed to fetch")]);
    await assert.rejects(post.fetch("/graphql", { method: "POST", body: "{}" }), TypeError);
    assert.equal(post.calls.length, 1);

    const stopped = new AbortController();
    stopped.abort();
    const aborted = flaky([new TypeError("Failed to fetch")]);
    await assert.rejects(aborted.fetch("/sandbox/engine/manifest.json", { signal: stopped.signal }), TypeError);
    assert.equal(aborted.calls.length, 1);

    const other = flaky([new RangeError("not the network")]);
    await assert.rejects(other.fetch("/sandbox/engine/manifest.json"), RangeError);
    assert.equal(other.calls.length, 1);
  });
});
