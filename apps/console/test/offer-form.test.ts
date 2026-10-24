// The guided creation's form model: a saved version goes through the form
// and back without losing anything, the steps stop on what cannot mean
// anything, and the form carries every field the gateway's schema gives an
// offer (when the schema grows, this test fails until the form follows).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSchema, isInputObjectType, isObjectType } from "graphql";
import {
  CARRIED, cannotCarry, checkStep, differsFrom, emptyForm, emptyMarket, formFromContent, type MarketFacts, type OfferContent, parsePercent,
  plainAmount, toInput,
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
    // A listening rule lost on the way would be a difference too.
    assert.equal(differsFrom({ ...formFromContent(FANS), listening: null }, FANS, FACTS), true);
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
