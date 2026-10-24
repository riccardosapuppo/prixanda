// The protocol between a tab and the sandbox's worker: each message read back
// as it was sent, and every message of the wrong shape refused, field by field,
// so that neither side acts on one.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  APIS, CHANGES, COMMANDS, type FromWorker, LAUNCH_STEPS, parseArmFault, parseFromWorker, parseToWorker, type ToWorker, WORKER_NAME, WORKER_URL,
} from "../src/protocol.ts";

const TO_WORKER: ToWorker[] = [
  { kind: "hello", app: "site", build: "b-0123" },
  { kind: "hello", app: "console", build: "b-0123" },
  { kind: "graphql", id: 1, api: "public", headers: { "content-type": "application/json", "x-csrf-token": "t" }, body: '{"query":"{ markets { code } }"}' },
  { kind: "graphql", id: 2, api: "internal", headers: {}, body: "{}" },
  { kind: "command", id: 3, name: "status" },
  { kind: "command", id: 4, name: "arm-fault", args: { step: "publish" } },
];

const FROM_WORKER: FromWorker[] = [
  { kind: "progress", step: "Loading the engine", done: 1, of: 5 },
  { kind: "ready", info: { bootMs: 4210, alreadyRunning: false, build: "b-0123", now: "2026-10-24T08:00:00Z" } },
  { kind: "failed", reason: "IndexedDB is not available in this browser." },
  { kind: "reply", id: 1, status: 200, headers: { "content-type": "application/json" }, body: '{"data":{}}' },
  { kind: "changed", what: ["catalog", "launches"] },
  { kind: "reset" },
];

describe("the sandbox's protocol", () => {
  test("one worker for the origin: the address and the name every app opens", () => {
    assert.equal(WORKER_URL, "/sandbox/backend.js");
    assert.equal(WORKER_NAME, "plancia-sandbox");
  });

  test("names what the engine's tick() changes, the demo's commands and the steps of a launch, as the brief fixed them", () => {
    assert.deepEqual([...CHANGES], ["catalog", "changes", "launches", "accounts", "audit"]);
    assert.deepEqual([...COMMANDS], ["status", "reset", "arm-fault", "clear-fault", "skip-to-next-launch"]);
    assert.deepEqual([...LAUNCH_STEPS], ["check", "prepare", "publish", "notify", "verify"]);
    assert.deepEqual([...APIS], ["internal", "public"]);
  });

  test("reads back every message as it was sent, through a structured clone", () => {
    for (const message of TO_WORKER) assert.deepEqual(parseToWorker(structuredClone(message)), message);
    for (const message of FROM_WORKER) assert.deepEqual(parseFromWorker(structuredClone(message)), message);
  });

  test("refuses a message to the worker of the wrong shape", () => {
    const wrong: unknown[] = [
      null, "hello", [], 42, {},
      { kind: "hi", app: "site", build: "b" },
      { kind: "hello", app: "shop", build: "b" },
      { kind: "hello", app: "site" },
      { kind: "graphql", id: 0, api: "public", headers: {}, body: "{}" },
      { kind: "graphql", id: -1, api: "public", headers: {}, body: "{}" },
      { kind: "graphql", id: 1.5, api: "public", headers: {}, body: "{}" },
      { kind: "graphql", id: 1, api: "private", headers: {}, body: "{}" },
      { kind: "graphql", id: 1, api: "public", headers: { "Content-Type": "application/json" }, body: "{}" },
      { kind: "graphql", id: 1, api: "public", headers: { "x-csrf-token": 7 }, body: "{}" },
      { kind: "graphql", id: 1, api: "public", headers: [], body: "{}" },
      { kind: "graphql", id: 1, api: "public", headers: {}, body: { query: "{}" } },
      { kind: "command", id: 1, name: "delete-everything" },
      { kind: "command", name: "status" },
    ];
    for (const message of wrong) assert.equal(parseToWorker(message), null, JSON.stringify(message));
  });

  test("refuses a message from the worker of the wrong shape", () => {
    const wrong: unknown[] = [
      null, { kind: "ready" }, { kind: "ready", info: { bootMs: "fast", alreadyRunning: false, build: "b", now: "n" } },
      { kind: "progress", step: "x", done: 1.5, of: 2 }, { kind: "failed" },
      { kind: "reply", id: 1, status: "200", headers: {}, body: "" }, { kind: "reply", id: 1, status: 200, headers: {}, body: null },
      { kind: "changed", what: ["catalog", "everything"] }, { kind: "changed", what: "catalog" }, { kind: "bye" },
    ];
    for (const message of wrong) assert.equal(parseFromWorker(message), null, JSON.stringify(message));
  });

  test("arm-fault takes one of a launch's steps", () => {
    assert.deepEqual(parseArmFault({ step: "verify" }), { step: "verify" });
    for (const args of [undefined, null, {}, { step: "launch" }, { step: 3 }, ["publish"]]) assert.equal(parseArmFault(args), null, JSON.stringify(args));
  });
});
