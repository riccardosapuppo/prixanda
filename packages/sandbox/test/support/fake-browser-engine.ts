// A BrowserEngine for the tests: the gateway's fake engine, its services and
// behaviours as over gRPC, behind the binary call of the engine in the page,
// with the jobs, the clock, the fault and the skip in the tests' hands.
import { type DescMethodUnary, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { SERVICES } from "gateway/engine";
import { FakeEngine } from "../../../../services/gateway/test/support/fake-engine.ts";
import type { BrowserEngine } from "../../src/gateway/engine-port.ts";
import type { Changed, LaunchStep } from "../../src/protocol.ts";

const METHODS = new Map<string, DescMethodUnary>();
for (const service of Object.values(SERVICES)) {
  for (const method of service.methods) if (method.methodKind === "unary") METHODS.set(`${service.typeName}/${method.name}`, method as DescMethodUnary);
}

export type FakeBrowserEngine = BrowserEngine & {
  readonly fake: FakeEngine;
  /** What the next tick changes; it is used once. */
  nextChanges: Changed[];
  ticks: number;
  resets: number;
  /** When the next launch is due, as the test says. */
  due: Date | null;
  /** What the next skip answers. */
  skip: { from: Date; to: Date; changed: Changed[] } | null;
  /** Every call the worker made, by method. */
  readonly calls: string[];
};

export function fakeBrowserEngine(options: { now?: string } = {}): FakeBrowserEngine {
  let now = new Date(options.now ?? "2026-10-24T08:00:00Z");
  const fake = new FakeEngine({ clock: () => now });
  const transport = fake.inProcessTransport({ authorize: false });
  let armed: LaunchStep | null = null;
  const engine: FakeBrowserEngine = {
    fake,
    nextChanges: [],
    ticks: 0,
    resets: 0,
    due: null,
    skip: null,
    calls: [],
    async call(service, method, metadata, request) {
      engine.calls.push(method);
      const desc = METHODS.get(`${service}/${method}`);
      if (desc === undefined) return { ok: false, code: Code.Unimplemented, message: `no method ${service}/${method}` };
      try {
        const answer = await transport.unary(desc, undefined, undefined, metadata, fromBinary(desc.input, request));
        return { ok: true, response: toBinary(desc.output, answer.message) };
      } catch (error) {
        const failed = ConnectError.from(error);
        return { ok: false, code: failed.code, message: failed.rawMessage };
      }
    },
    async tick() {
      engine.ticks += 1;
      const changed = engine.nextChanges;
      engine.nextChanges = [];
      return { ran: changed.length, changed };
    },
    clock: {
      now: () => now,
      advanceTo(instant) {
        if (Number.isNaN(instant.getTime())) throw new RangeError("not a date");
        if (instant > now) now = instant;
      },
      nextDue: async () => engine.due,
    },
    faults: {
      arm(step) {
        armed = step;
      },
      clear() {
        armed = null;
      },
      armed: () => armed,
    },
    async skipToNextLaunch() {
      const skipped = engine.skip;
      engine.skip = null;
      if (skipped !== null) now = skipped.to;
      return skipped;
    },
    async reset() {
      engine.resets += 1;
    },
  };
  return engine;
}
