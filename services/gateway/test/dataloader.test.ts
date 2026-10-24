// The DataLoader, counted at the engine: the console's list of offers with
// their details costs N + 1 calls without batching and 2 with it, for the same
// answer. The calls are counted where they arrive, in the fake engine's gRPC
// server, not by the gateway that makes them.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MAX_BATCH } from "../src/core/loaders.ts";
import { codes, type Harness, startHarness } from "./support/harness.ts";

const OFFERS = 25;
const LIST = `{ changes(filter: { kind: OFFER }, first: ${OFFERS}) { nodes { id title details { sentence current { version fingerprint } } } } }`;

async function measureList(batch: boolean): Promise<{ calls: Record<string, number>; total: number; data: unknown }> {
  const harness = await startHarness({ engine: { offers: OFFERS }, batch });
  try {
    const client = harness.console();
    await client.signIn("marketing-1");
    harness.engine.clearCalls();
    const answer = await client.graphql(LIST);
    assert.equal(answer.body.errors, undefined, answer.text);
    const calls: Record<string, number> = {};
    for (const call of harness.engine.calls) calls[call.method] = (calls[call.method] ?? 0) + 1;
    return { calls, total: harness.engine.count(), data: answer.body.data };
  } finally {
    await harness.close();
  }
}

describe("the list of offers with their details", () => {
  test(`without batching: ${OFFERS} + 1 calls; with BatchGetChanges: 2; the same answer`, async () => {
    const without = await measureList(false);
    const withBatches = await measureList(true);
    assert.deepEqual(without.calls, { ListChanges: 1, GetChange: OFFERS });
    assert.equal(without.total, OFFERS + 1);
    assert.deepEqual(withBatches.calls, { ListChanges: 1, BatchGetChanges: 1 });
    assert.equal(withBatches.total, 2);
    assert.deepEqual(withBatches.data, without.data);
    assert.equal((withBatches.data as { changes: { nodes: unknown[] } }).changes.nodes.length, OFFERS);
  });
});

describe("the loaders of one request", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness({ engine: { offers: MAX_BATCH + 1 } });
  });
  after(async () => {
    await harness.close();
  });

  test("live for that request only: two requests, two batches", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    harness.engine.clearCalls();
    await client.graphql('{ change(id: "1") { title } }');
    await client.graphql('{ change(id: "1") { title } }');
    assert.equal(harness.engine.count("BatchGetChanges"), 2);
  });

  test("ask once for an id asked twice", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    harness.engine.clearCalls();
    await client.graphql('{ a: change(id: "2") { title } b: change(id: "2") { id } c: change(id: "3") { id } }');
    const batches = harness.engine.calls.filter((call) => call.method === "BatchGetChanges");
    assert.equal(batches.length, 1);
    assert.deepEqual((batches[0]?.message as { changeIds: string[] }).changeIds, ["2", "3"]);
  });

  test("an unknown id fails its own row only", async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    const answer = await client.graphql('{ known: change(id: "4") { id } unknown: change(id: "99999") { id } }');
    assert.deepEqual(answer.body.data, { known: { id: "4" }, unknown: null });
    assert.deepEqual(codes(answer), ["NOT_FOUND"]);
    assert.deepEqual(answer.body.errors[0].path, ["unknown"]);
  });

  test(`split a request for more than ${MAX_BATCH} changes into batches of ${MAX_BATCH}`, async () => {
    const client = harness.console();
    await client.signIn("marketing-1");
    harness.engine.clearCalls();
    const fields = Array.from({ length: MAX_BATCH + 1 }, (_, index) => `c${index + 1}: change(id: "${index + 1}") { id }`).join(" ");
    const answer = await client.graphql(`{ ${fields} }`);
    assert.equal(answer.body.errors, undefined, answer.text.slice(0, 300));
    const sizes = harness.engine.calls.filter((call) => call.method === "BatchGetChanges").map((call) => (call.message as { changeIds: string[] }).changeIds.length);
    assert.deepEqual(sizes, [MAX_BATCH, 1]);
  });
});
