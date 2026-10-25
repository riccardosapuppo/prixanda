// The engine's side of the package, canned, for the worker's test in a real
// browser: a few of the contract's calls answered from fixed messages, with
// the internal token checked as the engine checks it, so that the bundle's
// gateway runs in Chromium end to end (Apollo, the hashing, the sessions, the
// transport) without Pyodide or PGlite.
import { create, toBinary } from "@bufbuild/protobuf";
import { ListMarketsResponseSchema } from "contracts/commerce/v1/catalog";
import { ListDemoListenersResponseSchema } from "contracts/commerce/v1/subscriptions";
import type { BrowserEngine, EngineReply, StartEngine } from "../../src/gateway/engine-port.ts";
import type { Changed, LaunchStep } from "../../src/protocol.ts";

const EUR = (amountMinor: bigint) => ({ amountMinor, currency: "EUR" });

const ANSWERS: Record<string, () => Uint8Array> = {
  ListMarkets: () => toBinary(ListMarketsResponseSchema, create(ListMarketsResponseSchema, {
    markets: [{ code: "IT", name: "Italy", currency: "EUR", minorUnits: 2, timeZone: "Europe/Rome", vatBp: 2200, artistsMinimum: EUR(300n), floor: EUR(610n) }],
  })),
  ListDemoListeners: () => toBinary(ListDemoListenersResponseSchema, create(ListDemoListenersResponseSchema, {
    listeners: [{ subscriberId: "5001", market: "IT", title: "Student in Italy, verified", label: "Simulated listener.", plan: "free", studentVerified: true }],
  })),
};

export const startEngine: StartEngine = async ({ base, database, token, onProgress }) => {
  // What the engine's own startEngine is given in the demo: its files beside the worker, its data in IndexedDB.
  if (base !== "/sandbox/" || database !== "idb://plancia-sandbox") throw new Error(`the worker gave the engine ${base} and ${database}`);
  onProgress?.("Opening the canned engine");
  let now = new Date("2026-10-24T08:00:00Z");
  let armed: LaunchStep | null = null;
  let jobs = 0;
  const engine: BrowserEngine = {
    async call(_service, method, metadata): Promise<EngineReply> {
      if (metadata["authorization"] !== `Bearer ${token}`) return { ok: false, code: 16, message: "missing or wrong internal token" };
      const answer = ANSWERS[method];
      return answer ? { ok: true, response: answer() } : { ok: false, code: 12, message: `the canned engine has no ${method}` };
    },
    async tick() {
      jobs += 1;
      // The first run of the jobs changes the catalog, as a launch would: every tab hears it.
      const changed: Changed[] = jobs === 1 ? ["catalog"] : [];
      return { ran: changed.length, changed };
    },
    clock: {
      now: () => now,
      advanceTo(instant) {
        if (instant > now) now = instant;
      },
      nextDue: async () => null,
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
    skipToNextLaunch: async () => null,
    reset: async () => undefined,
  };
  return engine;
};
