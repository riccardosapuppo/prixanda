// The pure pieces of the prepaid passes and the price changes (stage 7): a
// code as a person types it, the months of a pass drawn, the depth of a
// period's sheet, and the sentences that put the engine's dates into words.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PASS_END_SHARE, passScene, sheetDepth } from "../src/components/art/geometry.ts";
import { copy } from "../src/content/copy.ts";
import { normalCode } from "../src/lib/codes.ts";
import { lastDayBefore, siteDay } from "../src/lib/dates.ts";

describe("a prepaid code as a person types it", () => {
  it("keeps it in the engine's form: upper case, three groups of four", () => {
    assert.equal(normalCode("K7QM-3XTP-9WAD"), "K7QM-3XTP-9WAD");
    assert.equal(normalCode("k7qm 3xtp 9wad"), "K7QM-3XTP-9WAD");
    assert.equal(normalCode("  k7qm3xtp9wad "), "K7QM-3XTP-9WAD");
    assert.equal(normalCode("K7QM–3XTP–9WAD"), "K7QM-3XTP-9WAD");
  });

  it("refuses what cannot be a code, before anything is sent", () => {
    assert.equal(normalCode(""), null);
    assert.equal(normalCode("NOT-A-CODE"), null);
    assert.equal(normalCode("K7QM-3XTP-9WA"), null);
    assert.equal(normalCode("K7QM-3XTP-9WADX"), null);
    // The alphabet leaves out what reads alike: 0, 1, I and O.
    assert.equal(normalCode("K7QM-3XTP-9WA0"), null);
    assert.equal(normalCode("K7QM-3XTP-9WAI"), null);
    assert.equal(normalCode("K7QM-3XTP-9WAO"), null);
    assert.equal(normalCode("K7QM-3XTP-9WA1"), null);
  });
});

describe("a pass's months, drawn", () => {
  it("hangs one sail per month and stops the rope after the last", () => {
    const scene = passScene(3);
    assert.equal(scene.sails.length, 3);
    const slot = scene.width / (3 + PASS_END_SHARE);
    assert.ok(Math.abs(scene.ropeTo - 3 * slot) < 1e-9);
    for (const [i, sail] of scene.sails.entries()) {
      assert.ok(sail.a >= i * slot && sail.b <= (i + 1) * slot, `month ${i + 1} stays in its column`);
    }
    assert.ok(scene.ropeTo < scene.width, "the rope stops before the end's column");
  });

  it("refuses a pass of no months", () => {
    assert.throws(() => passScene(0), RangeError);
    assert.throws(() => passScene(2.5), RangeError);
  });
});

describe("the depth of a period's sheet", () => {
  it("hangs a higher price lower, and leaves the free plan's rope bare", () => {
    assert.equal(sheetDepth(1899n, 1899n), 15);
    assert.ok(sheetDepth(2099n, 1899n) > 15);
    assert.equal(sheetDepth(0n, 1899n), 0);
    assert.ok(sheetDepth(10_000n, 1899n) <= 23, "a sheet stays inside its drawing");
    assert.throws(() => sheetDepth(1899n, 0n), RangeError);
  });
});

describe("a price change in words, with the engine's dates", () => {
  const words = copy.priceChange;
  it("asks in Germany with two answers of the same shape, and says that silence is no", () => {
    const deadline = lastDayBefore("2026-12-17T23:59");
    assert.equal(deadline, "17 December 2026");
    assert.equal(words.consent.yes("20,99 €"), "Yes, move me to 20,99 €");
    assert.equal(words.consent.no("Family", siteDay("2027-01-15", { withYear: false })), "No, end my Family plan on 15 January");
    assert.equal(words.consent.silence(deadline), "If we don't hear from you by 17 December 2026, we take it as a no.");
    assert.equal(
      words.consent.ifNo(deadline, "Family", siteDay("2027-01-15")),
      "If you say no, or don't answer by 17 December 2026: your Family plan ends on 15 January 2027, when the month you've paid for runs out, and the account moves to Free.",
    );
  });

  it("tells in advance elsewhere, with the way to leave before the new price", () => {
    assert.equal(words.notice.leaveAction(siteDay("2026-12-15", { withYear: false })), "Leave on 15 December");
    assert.equal(
      words.notice.now("10,49 €", "10,99 €", siteDay("2026-12-15")),
      "You pay 10,49 € a month. From your billing date on 15 December 2026, you pay 10,99 €.",
    );
  });

  it("keeps the law and the service's choice in two blocks with their own names", () => {
    assert.notEqual(words.law, words.choice);
    assert.match(words.choice, /choice/);
    assert.equal(words.choiceTag, "Not a legal requirement");
  });
});

describe("dates without the year", () => {
  it("writes a day short where the year is plain from the sentence", () => {
    assert.equal(siteDay("2026-12-17", { withYear: false }), "17 December");
    assert.equal(siteDay("2026-12-17T23:59", { withYear: false }), "17 December");
    assert.equal(siteDay("2026-12-17"), "17 December 2026");
  });
});
