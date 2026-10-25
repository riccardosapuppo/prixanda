// The guided creation's form model: a saved version goes through the form
// and back without losing anything, the steps stop on what cannot mean
// anything, and the form carries every field the gateway's schema gives an
// offer (when the schema grows, this test fails until the form follows).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSchema, isInputObjectType, isObjectType } from "graphql";
import {
  CARRIED, cannotCarry, checkStep, differsFrom, emptyForm, emptyMarket, formFromContent, type MarketFacts, type OfferContent, parseHours,
  parsePercent, plainAmount, plainHours, stepOfField, toInput,
} from "../src/lib/offer-form.ts";

const FACTS: MarketFacts = {
  IT: { currency: "EUR", timeZone: "Europe/Rome", name: "Italy" },
  GB: { currency: "GBP", timeZone: "Europe/London", name: "United Kingdom" },
};
const NOW = new Date("2026-10-24T08:42:00Z");

/** The fans' campaign of §14.2: an audience narrowed by a listening rule, and an editorial page. */
const FANS: OfferContent = {
  title: "Nordflur release",
  plan: "individual",
  audience: { segment: "FREE_LISTENERS", currentPlan: null, needsStudentCheck: false, listening: { artistId: 4, minSeconds: 10_800, withinDays: 30 } },
  prices: [{ market: "IT", fixed: { amountMinor: "499", currency: "EUR" }, percentOffBasisPoints: null }],
  monthsAtOfferPrice: 2,
  periods: [{ market: "IT", startsLocal: "2026-11-02T09:00", endsLocal: "2026-11-30T00:00" }],
  nonCombinabilityGroup: "release-offers",
  redemptionCap: 5000,
  pages: [{ market: "IT", title: "Nordflur", text: "Two months of Individual for 4,99 €.", terms: "For Free listeners of Doppelfenster.", treatment: "nordflur" }],
};

describe("a saved version goes through the form and back whole", () => {
  it("keeps the listening rule, the cap and the page's treatment", () => {
    const typed = toInput(formFromContent(FANS), FACTS);
    assert.ok("input" in typed, JSON.stringify(typed));
    assert.deepEqual(typed.input.audience.listening, { artistId: 4, minSeconds: 10_800, withinDays: 30 });
    assert.equal(typed.input.redemptionCap, 5000);
    assert.equal(typed.input.pages[0]?.treatment, "nordflur");
    assert.deepEqual(typed.input.prices, [{ market: "IT", fixed: { amountMinor: "499", currency: "EUR" } }]);
  });

  it("saving only a new name keeps the audience as narrow as it was", () => {
    const form = { ...formFromContent(FANS), title: "Nordflur release, last call" };
    const typed = toInput(form, FACTS);
    assert.ok("input" in typed);
    assert.equal(typed.input.title, "Nordflur release, last call");
    assert.deepEqual(typed.input.audience, { segment: "FREE_LISTENERS", needsStudentCheck: false, listening: { artistId: 4, minSeconds: 10_800, withinDays: 30 } });
  });

  it("an untouched form says nothing new, an edited one does", () => {
    assert.equal(differsFrom(formFromContent(FANS), FANS, FACTS), false);
    assert.equal(differsFrom({ ...formFromContent(FANS), months: "3" }, FANS, FACTS), true);
    // A listening rule lost on the way, or changed, is a difference too.
    assert.equal(differsFrom({ ...formFromContent(FANS), fans: false }, FANS, FACTS), true);
    assert.equal(differsFrom({ ...formFromContent(FANS), hours: "4" }, FANS, FACTS), true);
  });

  it("a new page gets the standard treatment", () => {
    const form = { ...emptyForm(), title: "A", plan: "student", segment: "NEVER_PAID" as const, group: "student-offers", markets: [{ ...emptyMarket("IT", "2026-11-02T09:00"), fixed: "2.99", pageTitle: "T", pageText: "X", pageTerms: "Y" }] };
    const typed = toInput(form, FACTS);
    assert.ok("input" in typed);
    assert.equal(typed.input.pages[0]?.treatment, "standard");
    assert.equal(typed.input.audience.listening, undefined);
  });
});

describe("a version the form cannot carry is not edited", () => {
  it("names a field the form does not know", () => {
    const reason = cannotCarry({ ...FANS, audience: { ...FANS.audience, region: "north" } });
    assert.match(reason ?? "", /the audience holds region/);
    assert.match(reason ?? "", /cannot carry/);
  });

  it("finds nothing to say about a version it carries whole", () => {
    assert.equal(cannotCarry({ __typename: "OfferContent", ...FANS }), null);
  });
});

describe("the form carries every field the gateway's schema gives an offer", () => {
  const schema = buildSchema(readFileSync(new URL("../../../services/gateway/schema/internal.graphql", import.meta.url), "utf8"));
  const pairs: [keyof typeof CARRIED, string][] = [
    ["OfferContent", "OfferInput"], ["Audience", "AudienceInput"], ["ListeningRule", "ListeningRuleInput"],
    ["OfferPrice", "OfferPriceInput"], ["OfferPeriod", "OfferPeriodInput"], ["OfferPage", "OfferPageInput"],
  ];
  for (const [output, input] of pairs) {
    it(`${output} and ${input}`, () => {
      const outputType = schema.getType(output);
      const inputType = schema.getType(input);
      assert.ok(isObjectType(outputType) && isInputObjectType(inputType));
      const carried = [...CARRIED[output]].sort();
      assert.deepEqual(Object.keys(outputType.getFields()).sort(), carried, `${output}: the console must read and carry every field`);
      assert.deepEqual(Object.keys(inputType.getFields()).sort(), carried, `${input}: the console must send every field back`);
    });
  }
});

describe("the steps stop on what cannot mean anything", () => {
  it("an empty step 1 names each missing field once", () => {
    const fields = checkStep(emptyForm(), 0, FACTS, NOW).map((problem) => problem.field);
    assert.deepEqual(fields, ["title", "markets", "plan", "segment", "group"]);
  });

  it("a price that is not a price, and months out of range", () => {
    const form = { ...emptyForm(), months: "40", markets: [{ ...emptyMarket("IT"), fixed: "2.999" }] };
    const problems = checkStep(form, 1, FACTS, NOW);
    assert.deepEqual(problems.map((problem) => problem.field), ["months", "IT-fixed"]);
  });

  it("a start the clocks repeat, a start in the past, an end before its start", () => {
    const repeated = checkStep({ ...emptyForm(), markets: [{ ...emptyMarket("IT"), startsLocal: "2026-10-25T02:30" }] }, 2, FACTS, NOW);
    assert.match(repeated[0]?.message ?? "", /The clocks repeat that time in Rome/);
    const past = checkStep({ ...emptyForm(), markets: [{ ...emptyMarket("IT"), startsLocal: "2026-10-20T09:00" }] }, 2, FACTS, NOW);
    assert.match(past[0]?.message ?? "", /That time has passed in Rome/);
    const backwards = checkStep({ ...emptyForm(), markets: [{ ...emptyMarket("IT"), startsLocal: "2026-11-02T09:00", endsLocal: "2026-11-01T09:00" }] }, 2, FACTS, NOW);
    assert.equal(backwards[0]?.message, "The end comes after the start.");
  });

  it("percentages and amounts as people type them", () => {
    assert.equal(parsePercent("40"), 4000);
    assert.equal(parsePercent("12,5%"), 1250);
    assert.equal(parsePercent("100"), null);
    assert.equal(parsePercent("0"), null);
    assert.equal(plainAmount({ amountMinor: "299", currency: "EUR" }), "2.99");
    assert.equal(plainAmount({ amountMinor: "1000", currency: "JPY" }), "1000");
  });
});

describe("the fans of an artist (§14.2)", () => {
  const fans = (patch: Partial<ReturnType<typeof formFromContent>>) => ({ ...formFromContent(FANS), ...patch });

  it("reads a saved rule into the form and writes it back: the artist, the hours, the window", () => {
    const form = formFromContent(FANS);
    assert.deepEqual([form.fans, form.artist, form.hours, form.days], [true, "4", "3", "30"]);
    const typed = toInput(fans({ artist: "7", hours: "1,5", days: "14" }), FACTS);
    assert.ok("input" in typed, JSON.stringify(typed));
    assert.deepEqual(typed.input.audience.listening, { artistId: 7, minSeconds: 5_400, withinDays: 14 });
    const none = toInput(fans({ fans: false }), FACTS);
    assert.ok("input" in none);
    assert.equal(none.input.audience.listening, undefined);
  });

  it("starts a new campaign on the book's window, with nothing chosen", () => {
    const form = emptyForm();
    assert.deepEqual([form.fans, form.artist, form.hours, form.days], [false, "", "", "30"]);
  });

  it("writes hours back to the very same seconds", () => {
    for (const seconds of [3_600, 5_400, 10_800, 5_000, 1, 7_776_000 - 1]) assert.equal(parseHours(plainHours(seconds)), seconds, String(seconds));
    assert.deepEqual([plainHours(10_800), plainHours(5_400), plainHours(5_000)], ["3", "1.5", "1.3889"]);
    assert.deepEqual([parseHours("3"), parseHours(" 2,5 "), parseHours("0"), parseHours("three"), parseHours("-1")], [10_800, 9_000, null, null, null]);
  });

  it("stops step 1 on what cannot mean anything, and points each problem at its field", () => {
    const fields = (patch: Partial<ReturnType<typeof formFromContent>>) =>
      checkStep({ ...fans(patch), markets: [] }, 0, FACTS, NOW).map((problem) => problem.field).filter((field) => field !== "markets");
    assert.deepEqual(fields({ artist: "", hours: "", days: "30" }), ["artist", "hours"]);
    assert.deepEqual(fields({ hours: "lots" }), ["hours"]);
    assert.deepEqual(fields({ days: "0" }), ["days"]);
    assert.deepEqual(fields({ days: "91" }), ["days"]);
    // More than 24 hours a day cannot be played; 719 hours in 30 days can.
    const [tooMany] = checkStep({ ...fans({ hours: "720" }), markets: [] }, 0, FACTS, NOW).filter((problem) => problem.field === "hours");
    assert.equal(tooMany?.message, "Nobody plays more than 24 hours a day: in 30 days, fewer than 720 hours.");
    assert.deepEqual(fields({ hours: "719" }), []);
    // Without the rule, its fields are not asked for.
    assert.deepEqual(fields({ fans: false, artist: "", hours: "" }), []);
    for (const field of ["fans", "artist", "hours", "days"]) assert.equal(stepOfField(field), 0, field);
  });
});

describe("a time's seconds (the contract's way: minutes, and seconds only when there are some)", () => {
  const withSeconds: OfferContent = { ...FANS, periods: [{ market: "IT", startsLocal: "2026-11-02T09:00:10", endsLocal: "2026-11-30T00:00:20" }] };
  const moved = (form: ReturnType<typeof formFromContent>, patch: Partial<{ startsLocal: string; endsLocal: string }>) =>
    ({ ...form, markets: form.markets.map((market) => ({ ...market, ...patch })) });

  it("a change of seconds alone is a new version, at the start and at the end", () => {
    const form = formFromContent(withSeconds);
    assert.equal(differsFrom(form, withSeconds, FACTS), false);
    assert.equal(differsFrom(moved(form, { startsLocal: "2026-11-02T09:00:50" }), withSeconds, FACTS), true);
    assert.equal(differsFrom(moved(form, { endsLocal: "2026-11-30T00:00:40" }), withSeconds, FACTS), true);
    const typed = toInput(moved(form, { startsLocal: "2026-11-02T09:00:50" }), FACTS);
    assert.ok("input" in typed);
    assert.equal(typed.input.periods[0]?.startsLocal, "2026-11-02T09:00:50");
  });

  it("zero seconds are no seconds", () => {
    const form = formFromContent(FANS);
    assert.equal(differsFrom(moved(form, { startsLocal: "2026-11-02T09:00:00", endsLocal: "2026-11-30T00:00:00" }), FANS, FACTS), false);
  });
});
