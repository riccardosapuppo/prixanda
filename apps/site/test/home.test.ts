// The home's pure pieces, held to their rules: the promise drawn plan by
// plan, the sheets of a price, the printed covers, the clock of a listening
// session, the plans' order and lines, and a label's session.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { canopy, priceParts, promiseSails } from "../src/components/art/geometry.ts";
import { coverArt, TECHNIQUE } from "../src/components/art/covers.ts";
import { FIRST_PLAN, inSiteOrder, planFromQuery } from "../src/components/home/plan-order.ts";
import { copy } from "../src/content/copy.ts";
import { LABELS, labelOf, RELEASES, releasesOf, sessionOf, slug } from "../src/content/editorial.ts";
import { clamp, clock, nextStart, positionAt, previousStart, timeline } from "../src/lib/session.ts";

const money = (amountMinor: number) => ({ amountMinor: String(amountMinor), currency: "EUR" });

describe("the promise, plan by plan", () => {
  // Italy's paid plans: Individual, Duo, Family, Student; Student's pool (2,85 €) is topped up to the 3,00 € minimum.
  const items = [
    { artists: 516n, pool: 516n },
    { artists: 713n, pool: 713n },
    { artists: 885n, pool: 885n },
    { artists: 300n, pool: 285n },
  ];

  it("hangs one sail per paid plan, each as long as what it gives the artists", () => {
    const figure = promiseSails(items, { minimum: 300n });
    assert.equal(figure.sails.length, 4);
    const drops = figure.sails.map((sail) => sail.bottom - figure.rope);
    assert.ok((drops[2] ?? 0) > (drops[1] ?? 0) && (drops[1] ?? 0) > (drops[0] ?? 0) && (drops[0] ?? 0) > (drops[3] ?? 0));
    // Lengths are proportional to the amounts.
    assert.ok(Math.abs((drops[2] ?? 0) / (drops[0] ?? 1) - 885 / 516) < 1e-9);
  });

  it("draws the minimum as a cord every sail reaches, and the top-up only where the pool falls short", () => {
    const figure = promiseSails(items, { minimum: 300n });
    for (const sail of figure.sails) assert.ok(sail.bottom >= figure.cordY - 1e-9, "every sail reaches the cord");
    assert.deepEqual(figure.sails.map((sail) => sail.chord !== null), [false, false, false, true]);
    assert.ok(Math.abs((figure.sails[3]?.bottom ?? 0) - figure.cordY) < 1e-9, "a topped-up sail stops at the minimum");
    assert.equal(figure.cordTo, figure.width);
  });

  it("refuses a promise without a paid plan", () => {
    assert.throws(() => promiseSails([], { minimum: 300n }), RangeError);
  });
});

describe("the sheets of a price", () => {
  it("lays the artists, the service, the payment costs and VAT end to end, to the price", () => {
    // Individual in Italy: 10,49 € = 5,16 to the artists + 3,25 kept + 0,19 payment + 1,89 VAT.
    const parts = priceParts({ price: money(1049), artists: money(516), topUp: money(0), companyKeeps: money(325), paymentCosts: money(19) });
    assert.deepEqual(parts.map((part) => [part.dye, part.from, part.to]), [
      ["madder", 0n, 516n], ["saffron", 516n, 841n], ["neutral", 841n, 860n], ["indigo", 860n, 1049n],
    ]);
  });

  it("overlaps the artists' sheet and the service's by exactly the top-up", () => {
    // Student in Italy: 5,79 €; the pool's 2,85 € is topped up by 0,15 € to the 3,00 € minimum.
    const parts = priceParts({ price: money(579), artists: money(300), topUp: money(15), companyKeeps: money(165), paymentCosts: money(10) });
    const [artists, service] = parts;
    assert.equal((artists?.to ?? 0n) - (service?.from ?? 0n), 15n);
    assert.equal(parts.at(-1)?.to, 579n);
    const drawn = canopy(parts, 579n, { minimum: 300n });
    assert.equal(drawn.sails.length, 4);
    assert.ok(drawn.cord !== null && Math.abs(drawn.cord - (drawn.sails[0]?.hem[1] ?? 0)) < 1e-9, "the cord hangs where the artists' sheet ends");
  });
});

describe("the printed covers", () => {
  // Fingerprints of every release's cover: the same seed draws the same cover, on every machine.
  const PRINTS: Readonly<Record<number, string>> = {
    1: "18c8f18ba3cacf46", 2: "160082cd5adb641b", 3: "f69b9578d78f4736", 4: "709e3e6d5cdc00f3",
    5: "42a503852f73eb58", 6: "239eac0b8d32ee8e", 7: "1b94eb5ac4217bf9",
  };

  it("prints each label in its own technique", () => {
    assert.deepEqual(LABELS.map((label) => TECHNIQUE[label.name]), ["linocut", "pochoir", "scraperboard", "cyanotype"]);
    for (const release of RELEASES) assert.equal(coverArt({ seed: release.seed, label: labelOf(release).name }).technique, TECHNIQUE[labelOf(release).name]);
  });

  it("draws the same cover from the same seed", () => {
    for (const release of RELEASES) {
      const art = coverArt({ seed: release.seed, label: labelOf(release).name });
      assert.deepEqual(art, coverArt({ seed: release.seed, label: labelOf(release).name }));
      assert.equal(createHash("sha256").update(JSON.stringify(art)).digest("hex").slice(0, 16), PRINTS[release.id], `${release.title}`);
    }
  });

  it("draws a different cover from another seed", () => {
    const one = coverArt({ seed: 11, label: "Casa Lenta" });
    const other = coverArt({ seed: 12, label: "Casa Lenta" });
    assert.notDeepEqual(one.shapes, other.shapes);
  });
});

describe("the clock of a listening session", () => {
  // Casa Lenta: 41 minutes in 9 tracks, then 49 minutes in 12.
  const records = [{ minutes: 41, tracks: 9 }, { minutes: 49, tracks: 12 }];
  const line = timeline(records);

  it("starts each record where the one before ends", () => {
    assert.deepEqual(line, { starts: [0, 2460], total: 5400 });
  });

  it("finds the record and the track, splitting a record's time evenly among its tracks", () => {
    assert.deepEqual(positionAt(records, line, 0), { index: 0, into: 0, track: 1 });
    assert.deepEqual(positionAt(records, line, 760), { index: 0, into: 760, track: 3 });
    assert.deepEqual(positionAt(records, line, 2459), { index: 0, into: 2459, track: 9 });
    assert.deepEqual(positionAt(records, line, 2460), { index: 1, into: 0, track: 1 });
    assert.deepEqual(positionAt(records, line, 5400), { index: 1, into: 2940, track: 12 });
    assert.equal(clamp(-5, line), 0);
    assert.equal(clamp(9999, line), 5400);
    assert.equal(clamp(Number.NaN, line), 0);
  });

  it("goes back to this record's start, or to the one before when this one has barely begun", () => {
    assert.equal(previousStart(line, positionAt(records, line, 3000)), 2460);
    assert.equal(previousStart(line, positionAt(records, line, 2462)), 0);
    assert.equal(previousStart(line, positionAt(records, line, 3)), 0);
    assert.equal(nextStart(line, positionAt(records, line, 100)), 2460);
    assert.equal(nextStart(line, positionAt(records, line, 3000)), 5400);
  });

  it("writes the time the way a player does", () => {
    assert.equal(clock(0), "0:00");
    assert.equal(clock(760), "12:40");
    assert.equal(clock(5400), "1:30:00");
    assert.equal(clock(3605.9), "1:00:05");
  });

  it("refuses a session without records, or a record without length or tracks", () => {
    assert.throws(() => timeline([]), RangeError);
    assert.throws(() => timeline([{ minutes: 0, tracks: 3 }]), RangeError);
    assert.throws(() => timeline([{ minutes: 30, tracks: 0 }]), RangeError);
  });
});

describe("the plans' order and lines", () => {
  const plan = (code: string) => ({ code });

  it("lists the paid plans from Individual, then Free, and any other plan last", () => {
    assert.deepEqual(inSiteOrder([plan("free"), plan("student"), plan("family"), plan("gift"), plan("duo"), plan("individual")]).map((each) => each.code), [
      "individual", "duo", "family", "student", "free", "gift",
    ]);
    assert.equal(FIRST_PLAN, "individual");
  });

  it("reads the plan an address asks for, and nothing that could not be one", () => {
    assert.equal(planFromQuery(new URLSearchParams("plan=duo")), "duo");
    assert.equal(planFromQuery(new URLSearchParams("plan=Student")), "student");
    assert.equal(planFromQuery(new URLSearchParams("plan=<script>")), null);
    assert.equal(planFromQuery(new URLSearchParams("")), null);
  });

  it("says the counts of a plan's line from what the plan includes", () => {
    const includes = (seats: number, skipsPerHour: number | null, audio = "LOSSLESS", offline = true) => ({ seats, skipsPerHour, audio, offline });
    assert.equal(copy.plans.line("free", includes(1, 6, "STANDARD", false)), "The whole catalogue. Six skips an hour, standard quality.");
    assert.equal(copy.plans.line("individual", includes(1, null)), "Lossless, offline, skip as much as you like.");
    assert.equal(copy.plans.line("duo", includes(2, null)), "Two accounts, one bill.");
    assert.equal(copy.plans.line("family", includes(5, null)), "Up to five accounts, one bill.");
    assert.equal(copy.plans.line("family", includes(6, null)), "Up to six accounts, one bill.");
    assert.equal(copy.plans.line("unknown", includes(1, null)), "");
  });
});

describe("a label's listening session", () => {
  it("names a label as an address", () => {
    assert.deepEqual(LABELS.map((label) => slug(label.name)), ["casa-lenta", "disques-pareil", "kellerlicht", "coldframe-records"]);
    assert.equal(slug("Café Été"), "cafe-ete");
  });

  it("plays a label's records one after the other, with their tracks and minutes added up", () => {
    const casaLenta = LABELS[0];
    assert.ok(casaLenta);
    const session = sessionOf(casaLenta);
    assert.deepEqual(session.records.map((record) => record.title), ["Stanze al piano terra", "Binario Morto"]);
    assert.equal(session.tracks, 21);
    assert.equal(session.minutes, 90);
    assert.deepEqual(releasesOf(casaLenta, []), []);
  });
});
