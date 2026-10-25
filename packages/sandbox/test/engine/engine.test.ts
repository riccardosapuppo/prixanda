// The engine of the demo in Node: the same Python engine and the same
// adapter as in the browser, on PGlite, behind the contract's bytes. The
// browser's own (IndexedDB, the worker, the network) is in browser.test.ts.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { loadPyodide } from "pyodide";
import { AuditService } from "contracts/commerce/v1/audit";
import { CatalogService } from "contracts/commerce/v1/catalog";
import { ChangeService } from "contracts/commerce/v1/changes";
import { RefusalCode } from "contracts/commerce/v1/common";
import { LaunchService, LaunchState } from "contracts/commerce/v1/launches";
import { QuoteService } from "contracts/commerce/v1/quotes";
import { SubscriberService } from "contracts/commerce/v1/subscriptions";
import { pyodideDir } from "../../src/engine/build/wheels.ts";
import { loadPython } from "../../src/engine/python.ts";
import { assetsDir, FINANCE, MARKETING, nodeEngine, type NodeEngine, ON_CALL, PUBLIC, romeLocal, rpc, RpcError } from "./support.ts";

let on: NodeEngine;

const show = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

before(async () => {
  on = await nodeEngine();
});

after(async () => {
  await on.engine.close();
});

const codeOf = async (work: Promise<unknown>): Promise<number> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof RpcError) return error.code;
    throw error;
  }
  return 0;
};

test("the engine starts on the build's snapshot, with the versions it was built for", async () => {
  assert.equal(on.engine.info.loaded, true);
  assert.deepEqual(on.engine.info.applied, []);
  assert.equal(on.engine.info.versions.python, "3.13.2");
  assert.equal(on.engine.info.versions.protobuf, "6.31.1");
  assert.match(on.engine.info.versions.postgres, /^18\./);
  // The time of the story, not the machine's: 08:30 in Rome on the morning after the data's last day.
  assert.equal(on.manifest.story, "2026-10-25T07:30:00Z");
  assert.ok(Math.abs(on.engine.clock.now().getTime() - Date.parse(on.manifest.story)) < 60_000, on.engine.clock.now().toISOString());
  const markets = await rpc(on, CatalogService.method.listMarkets, {});
  assert.deepEqual(markets.markets.map((m) => m.code).sort(), ["DE", "FR", "GB", "IT"]);
  const listeners = await rpc(on, SubscriberService.method.listDemoListeners, {});
  assert.equal(listeners.listeners.length, 6);
});

test("every module of the package imports in Pyodide, which has neither grpc nor asyncpg", async () => {
  const assets = assetsDir();
  const zip = await readFile(join(assets, "engine", on.manifest.engine));
  const pyodide = await loadPython({
    loadPyodide, indexURL: pyodideDir(), packageBaseUrl: `${join(assets, "pyodide").replaceAll("\\", "/")}/`,
    engine: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer,
  });
  const imported = JSON.parse(pyodide.runPython(`
import importlib, json, pkgutil, commerce, commerce.v1
# commerce.v1, the contract's messages, is a namespace package, which walk_packages does not go into.
names = sorted({m.name for m in pkgutil.walk_packages(commerce.__path__, "commerce.")}
               | {m.name for m in pkgutil.iter_modules(commerce.v1.__path__, "commerce.v1.")})
for name in names:
    importlib.import_module(name)
missing = [name for name in ("grpc", "asyncpg") if importlib.util.find_spec(name) is not None]
json.dumps({"modules": names, "missing": missing})
`) as string) as { modules: string[]; missing: string[] };
  assert.deepEqual(imported.missing, [], "Pyodide has no grpc and no asyncpg, so nothing could import them");
  assert.ok(imported.modules.length >= 50, imported.modules.join(" "));
  assert.ok(!imported.modules.some((name) => /^commerce\.(server|adapters|generate|compat|invariants|measure)\b|_grpc$|snapshot$/.test(name)),
    imported.modules.join(" "));
});

test("the calls the server refuses are refused with gRPC's codes", async () => {
  assert.equal(await codeOf(rpc(on, CatalogService.method.listMarkets, {}, PUBLIC, { token: null })), 16);
  assert.equal(await codeOf(rpc(on, CatalogService.method.listMarkets, {}, PUBLIC, { token: "x".repeat(43) })), 16);
  assert.equal(await codeOf(rpc(on, ChangeService.method.listChanges, {}, PUBLIC)), 7); // a person is needed
  assert.equal(await codeOf(rpc(on, ChangeService.method.listChanges, {}, ["marketing-1", "finance"])), 7); // a role not held
  assert.equal(await codeOf(rpc(on, ChangeService.method.getChange, { changeId: "999999" }, MARKETING)), 5);
  assert.equal(await codeOf(rpc(on, CatalogService.method.listOffers, { market: "it" })), 3);
  const unknown = await on.engine.call("commerce.v1.CatalogService", "ListEverything", { authorization: `Bearer ${on.token}` }, new Uint8Array());
  assert.deepEqual(unknown.ok ? 0 : unknown.code, 12);
  const garbled = await on.engine.call("commerce.v1.CatalogService", "ListMarkets",
    { authorization: `Bearer ${on.token}`, "x-request-id": "test-garbled-0001" }, new Uint8Array([0xff, 0xff, 0xff]));
  assert.deepEqual(garbled.ok ? 0 : garbled.code, 13);
});

test("from a draft to a student's subscription, through a fault simulated in the publish step", async () => {
  const now = on.engine.clock.now();
  const starts = romeLocal(now, 2, 9);
  const ends = romeLocal(now, 40, 0);
  const created = await rpc(on, ChangeService.method.createChange, {
    content: {
      case: "offer",
      value: {
        title: "Student Autumn Pass", plan: "student",
        audience: { segment: 1, needsStudentCheck: true },
        prices: [{ market: "IT", price: { case: "fixed", value: { amountMinor: 299n, currency: "EUR" } } }],
        monthsAtOfferPrice: 3,
        periods: [{ market: "IT", startsLocal: starts, endsLocal: ends }],
        nonCombinabilityGroup: "student-offers",
        pages: [{ market: "IT", title: "Student Autumn Pass", text: "Three months of Student for 2,99 €.",
          terms: "New subscribers only. One pass per verified student.", treatment: "autumn" }],
      },
    },
  }, MARKETING);
  assert.equal(created.outcome.case, "change");
  const change = created.outcome.value;
  const validated = await rpc(on, ChangeService.method.validateChange, { changeId: change.id, version: 1 }, MARKETING);
  assert.equal(validated.outcome.case, "change", show(validated.outcome.value));
  const submitted = await rpc(on, ChangeService.method.submitChange, {
    changeId: change.id, version: 1, authorReason: "We are buying students for the autumn." }, MARKETING);
  assert.equal(submitted.outcome.case, "change");
  const hash = submitted.outcome.case === "change" ? submitted.outcome.value.versions.at(-1)?.contentHash : undefined;
  assert.ok(hash, "the version's content hash, which the signature names");
  // Marketing tries to approve its own campaign, and cannot: finance signs it (§7.3, §7.4).
  const own = await rpc(on, ChangeService.method.approveChange, { changeId: change.id, version: 1, contentHash: hash }, MARKETING);
  assert.equal(own.outcome.case === "refusal" ? own.outcome.value.code : undefined, RefusalCode.ROLE_NOT_ALLOWED);
  const approved = await rpc(on, ChangeService.method.approveChange, { changeId: change.id, version: 1, contentHash: hash }, FINANCE);
  assert.equal(approved.outcome.case, "change", show(approved.outcome.value));
  const scheduled = await rpc(on, ChangeService.method.scheduleChange, { changeId: change.id }, MARKETING);
  assert.equal(scheduled.outcome.case, "change");

  // Skip to its launch, with the fault armed on the publish step.
  const due = await on.engine.clock.nextDue();
  assert.ok(due && due.getTime() > now.getTime(), `the launch is due later: ${due?.toISOString()}`);
  on.engine.clock.advanceTo(due);
  on.engine.faults.arm("publish");
  assert.equal(on.engine.faults.armed(), "publish");
  const first = await on.engine.tick();
  assert.ok(first.ran > 0 && first.changed.includes("launches"), show(first));
  assert.ok(!first.changed.includes("catalog"), "nothing was published");
  assert.equal(on.engine.faults.armed(), null);
  const [listed] = (await rpc(on, LaunchService.method.listLaunches, { changeId: change.id }, ON_CALL)).launches;
  assert.ok(listed);
  const run = (await rpc(on, LaunchService.method.getLaunch, { launchId: listed.launchId }, ON_CALL)).launch;
  assert.ok(run);
  assert.equal(run.state, LaunchState.RUNNING);
  assert.equal(run.currentStep, "publish");
  const publish = run.steps.find((step) => step.name === "publish");
  assert.match(publish?.error ?? "", /^SimulatedFault: simulated by the demo: the publish step was cut/);
  assert.match(run.cause, /simulated by the demo/);
  const offersBefore = await rpc(on, CatalogService.method.listOffers, { market: "IT", at: "" });
  assert.ok(!offersBefore.offers.some((o) => o.offerId === change.id), "nothing of the publish step was kept");

  // The engine's own code tries the step again after its wait, and the change goes live.
  const retry = await on.engine.clock.nextDue();
  assert.ok(retry, "the launch waits for its next attempt");
  on.engine.clock.advanceTo(retry);
  const second = await on.engine.tick();
  assert.ok(second.changed.includes("catalog") && second.changed.includes("changes"), show(second));
  const done = (await rpc(on, LaunchService.method.getLaunch, { launchId: run.launchId }, ON_CALL)).launch;
  assert.equal(done?.state, LaunchState.DONE);
  assert.equal(done?.steps.find((step) => step.name === "publish")?.attempts, 2);
  assert.equal(await on.engine.clock.nextDue(), null);

  // At its start, a verified student who never paid subscribes at the offer's price.
  on.engine.clock.advanceTo(new Date(Date.parse(`${starts}:00+01:00`) + 3_600_000));
  const [offer] = (await rpc(on, CatalogService.method.listOffers, { market: "IT" })).offers;
  assert.equal(offer?.offerId, change.id);
  const student = (await rpc(on, SubscriberService.method.listDemoListeners, {})).listeners
    .find((listener) => listener.market === "IT" && listener.studentVerified && listener.plan === "free");
  assert.ok(student, "a verified student on the Free plan in Italy");
  const quote = await rpc(on, QuoteService.method.getQuote, { plan: "student", market: "IT", offerId: change.id, subscriberId: student.subscriberId });
  assert.equal(quote.outcome.case, "quote", show(quote.outcome.value));
  const q = quote.outcome.case === "quote" ? quote.outcome.value : undefined;
  assert.equal(q?.price?.amountMinor, 299n);
  const confirmed = await rpc(on, SubscriberService.method.confirmQuote, { quoteId: q?.quoteId ?? "", subscriberId: student.subscriberId });
  assert.equal(confirmed.outcome.case, "confirmation", show(confirmed.outcome.value));
  const account = await rpc(on, SubscriberService.method.getAccount, { subscriberId: student.subscriberId });
  assert.equal(account.account?.subscription?.plan, "student");
  const chain = await rpc(on, AuditService.method.verifyChain, {}, ["auditor-1", "auditor"]);
  assert.equal(chain.ok, true, show(chain));
});

test("the skip to the next launch runs it through a simulated fault, and ends at the change's start", async () => {
  const now = on.engine.clock.now();
  const starts = romeLocal(now, 3, 9); // 09:00 in Paris too
  const offer = (market: string) => ({
    content: {
      case: "offer" as const,
      value: {
        title: "Student Autumn Pass, France", plan: "student",
        audience: { segment: 1, needsStudentCheck: true },
        prices: [{ market, price: { case: "fixed" as const, value: { amountMinor: 299n, currency: "EUR" } } }],
        monthsAtOfferPrice: 3,
        periods: [{ market, startsLocal: starts, endsLocal: romeLocal(now, 40, 0) }],
        nonCombinabilityGroup: "student-offers",
        pages: [{ market, title: "Student Autumn Pass", text: "Trois mois de Student pour 2,99 €.", terms: "Nouveaux abonnés." }],
      },
    },
  });
  const created = await rpc(on, ChangeService.method.createChange, offer("FR"), MARKETING);
  assert.equal(created.outcome.case, "change");
  const id = created.outcome.value.id;
  await rpc(on, ChangeService.method.validateChange, { changeId: id, version: 1 }, MARKETING);
  const submitted = await rpc(on, ChangeService.method.submitChange, { changeId: id, version: 1, authorReason: "France too." }, MARKETING);
  const hash = submitted.outcome.case === "change" ? submitted.outcome.value.versions.at(-1)?.contentHash : undefined;
  assert.ok(hash);
  await rpc(on, ChangeService.method.approveChange, { changeId: id, version: 1, contentHash: hash }, FINANCE);
  const scheduled = await rpc(on, ChangeService.method.scheduleChange, { changeId: id }, MARKETING);
  assert.equal(scheduled.outcome.case, "change", show(scheduled.outcome.value));

  on.engine.faults.arm("notify");
  const skipped = await on.engine.skipToNextLaunch();
  assert.ok(skipped);
  const startsAt = Date.parse(`${starts}:00+01:00`);
  assert.ok(skipped.from.getTime() < startsAt && skipped.to.getTime() >= startsAt && skipped.to.getTime() < startsAt + 60_000,
    `${skipped.from.toISOString()} to ${skipped.to.toISOString()}, for a start at ${new Date(startsAt).toISOString()}`);
  // The jobs of the days skipped ran too: the payment of the subscription of the test before, for one.
  for (const word of ["audit", "catalog", "changes", "launches"] as const) assert.ok(skipped.changed.includes(word), show(skipped));
  const [listed] = (await rpc(on, LaunchService.method.listLaunches, { changeId: id }, ON_CALL)).launches;
  const run = (await rpc(on, LaunchService.method.getLaunch, { launchId: listed?.launchId ?? "0" }, ON_CALL)).launch;
  assert.equal(run?.state, LaunchState.DONE);
  const notify = run?.steps.find((step) => step.name === "notify");
  assert.equal(notify?.attempts, 2);
  assert.equal(notify?.facts["earlier attempts"], "1");
  assert.match(notify?.facts["last failure"] ?? "", /^SimulatedFault: simulated by the demo: the notify step was cut/);
  assert.deepEqual(run?.incidents, [], "no alarm: the launch started on time");
  const offers = (await rpc(on, CatalogService.method.listOffers, { market: "FR" })).offers;
  assert.deepEqual(offers.map((o) => o.offerId), [id], "in force at once");
  const events = on.logs.map((line) => JSON.parse(line) as { event: string; change?: number; step?: string })
    .filter((line) => line.change === Number(id) && line.event.startsWith("launch_")).map((line) => `${line.event}${line.step ? ` ${line.step}` : ""}`);
  assert.deepEqual(events, ["launch_started", "launch_step_done check", "launch_step_done prepare", "launch_step_done publish",
    "launch_step_failed notify", "launch_step_done notify", "launch_step_done verify", "launch_done"]);
  assert.equal(await on.engine.skipToNextLaunch(), null);
});

test("a write sent again with its key gets the same answer, and changes nothing", async () => {
  const content = {
    content: { case: "listPrice" as const, value: { title: "Family price, Germany", plan: "family", market: "DE",
      amount: { amountMinor: 2099n, currency: "EUR" }, startsLocal: `${romeLocal(on.engine.clock.now(), 60, 0)}` } },
  };
  const key = `key-same-${Date.now()}`;
  const first = await rpc(on, ChangeService.method.createChange, content, ["commercial-lead-1", "commercial_lead"], { key });
  const again = await rpc(on, ChangeService.method.createChange, content, ["commercial-lead-1", "commercial_lead"], { key });
  assert.equal(first.outcome.case, "change");
  assert.deepEqual(again, first);
  const listed = await rpc(on, ChangeService.method.listChanges, {}, ["commercial-lead-1", "commercial_lead"]);
  assert.equal(listed.changes.filter((c) => c.title === "Family price, Germany").length, 1);
});

test("the clock goes forward only", async () => {
  const before = on.engine.clock.now().getTime();
  on.engine.clock.advanceTo(new Date(before - 86_400_000));
  assert.ok(on.engine.clock.now().getTime() >= before);
  assert.throws(() => on.engine.clock.advanceTo(new Date(Number.NaN)), RangeError);
  assert.throws(() => on.engine.faults.arm("prepare-everything" as "check"), RangeError);
});

test("reset goes back to the build's snapshot", async () => {
  await on.engine.reset();
  const listed = await rpc(on, ChangeService.method.listChanges, {}, MARKETING);
  assert.equal(listed.changes.length, 0);
  assert.ok(Math.abs(on.engine.clock.now().getTime() - Date.parse(on.manifest.story)) < 60_000, "the clock is back at the story's start");
  assert.equal(on.engine.faults.armed(), null);
  assert.equal(await on.engine.clock.nextDue(), null);
});

test("a start over whose snapshot cannot be downloaded leaves the demo as it was, and the next one starts over", async () => {
  const lead = ["commercial-lead-1", "commercial_lead"] as const;
  await rpc(on, ChangeService.method.createChange, {
    content: { case: "listPrice", value: { title: "Duo price, France", plan: "duo", market: "FR",
      amount: { amountMinor: 1699n, currency: "EUR" }, startsLocal: `${romeLocal(on.engine.clock.now(), 60, 0)}` } },
  }, lead);
  on.failures.snapshot = 1;
  await assert.rejects(on.engine.reset(), /answered 503/);
  // The snapshot is downloaded before anything closes: the data in use is still open, as it was.
  assert.equal((await rpc(on, ChangeService.method.listChanges, {}, lead)).changes.length, 1);
  await on.engine.reset();
  assert.equal((await rpc(on, ChangeService.method.listChanges, {}, lead)).changes.length, 0);
  assert.equal((await rpc(on, CatalogService.method.listMarkets, {})).markets.length, 4);
});

test("a start over that fails once the data is closed: calls say so with UNAVAILABLE, and the next start over opens it", async () => {
  on.failures.remove = 1;
  await assert.rejects(on.engine.reset(), (error: unknown) => error instanceof Error && error.name === "DataNotOpen"
    && /could not be opened again after the start over \(IndexedDB did not delete the database\)/.test(error.message));
  await assert.rejects(rpc(on, CatalogService.method.listMarkets, {}), (error: unknown) => error instanceof RpcError
    && error.code === 14 && /start over again, or reload the page/.test(error.message));
  assert.deepEqual(await on.engine.tick(), { ran: 0, changed: [] });
  assert.equal(await on.engine.clock.nextDue(), null);
  await assert.rejects(on.engine.skipToNextLaunch(), (error: unknown) => error instanceof Error && error.name === "DataNotOpen");
  await on.engine.reset();
  assert.equal((await rpc(on, CatalogService.method.listMarkets, {})).markets.length, 4);
  assert.ok(Math.abs(on.engine.clock.now().getTime() - Date.parse(on.manifest.story)) < 60_000, "the clock is back at the story's start");
});

test("a start that fails once the database is open closes it, and the next start on the same data opens it", async () => {
  // The data on disk, in a folder of its own, as IndexedDB keeps it in the browser; PGlite's instances kept, to look
  // at them after the start.
  const dir = await mkdtemp(join(tmpdir(), "sandbox-engine-start-"));
  const opened: PGlite[] = [];
  const modules = {
    PGlite: { create: async (options: PGliteOptions) => {
      const pg = await PGlite.create(options);
      opened.push(pg);
      return pg;
    } } as unknown as typeof PGlite,
    btree_gist,
  };
  const exists = async () => existsSync(join(dir, "PG_VERSION"));
  const assets = assetsDir();
  const python = {
    loadPyodide: (async () => {
      throw new Error("/sandbox/pyodide/pyodide.asm.wasm answered 503");
    }) as unknown as typeof loadPyodide,
    indexURL: pyodideDir(), packageBaseUrl: `${join(assets, "pyodide").replaceAll("\\", "/")}/`,
    engine: async () => new ArrayBuffer(0),
  };
  try {
    await assert.rejects(nodeEngine(assets, { modules, python, dataDir: dir, exists }), /pyodide\.asm\.wasm answered 503/);
    assert.equal(opened.length, 1, "the database was open when Python failed");
    assert.equal(opened[0]?.closed, true, "the failed start closed it");
    const again = await nodeEngine(assets, { modules, dataDir: dir, exists });
    try {
      assert.equal(again.engine.info.loaded, false, "the second start opens the data the first one wrote");
      assert.equal((await rpc(again, CatalogService.method.listMarkets, {})).markets.length, 4);
    } finally {
      await again.engine.close();
    }
  } finally {
    // An instance a start left open would keep this process alive, and its files busy.
    for (const pg of opened) if (!pg.closed) await pg.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("the engine's log has a line for each call, in JSON, and none on the console", async () => {
  const lines = on.logs.map((line) => JSON.parse(line) as { event: string; status?: number });
  assert.ok(lines.some((line) => line.event === "rpc" && line.status === 0));
  assert.ok(lines.some((line) => line.event === "launch_step_failed"));
  assert.ok(lines.some((line) => line.event === "launch_done"));
});
