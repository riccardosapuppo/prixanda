// The form of a prepaid pass (src/lib/pass-form.ts): a saved version goes
// through the form and back without losing anything, the steps stop on what
// cannot mean anything, a gift code never carries a student verification,
// the example is the business book's (§9.1), and the form carries every
// field the gateway's schema gives a pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSchema, isInputObjectType, isObjectType } from "graphql";
import type { MarketFacts } from "../src/lib/offer-form.ts";
import {
  checkPassStep, emptyPass, emptyPassMarket, giftPassExample, PASS_CARRIED, PASS_PLANS, PASS_STEP_OF_CHECK, type PassContent, passDiffers, passFromContent,
  passStepOf, toPassInput,
} from "../src/lib/pass-form.ts";

const FACTS: MarketFacts = {
  IT: { currency: "EUR", timeZone: "Europe/Rome", name: "Italy" },
  GB: { currency: "GBP", timeZone: "Europe/London", name: "United Kingdom" },
};
/** Saturday 24 October 2026, 10:42 in Rome: the business book's day. */
const NOW = new Date("2026-10-24T08:42:00Z");

/** The three-month gift pass of §9.1, sold in Italy and the United Kingdom. */
const GIFT: PassContent = {
  title: "Three-month gift pass",
  plan: "individual",
  months: 3,
  prices: [{ market: "IT", amount: { amountMinor: "2999", currency: "EUR" } }, { market: "GB", amount: { amountMinor: "2599", currency: "GBP" } }],
  periods: [{ market: "IT", startsLocal: "2026-10-26T09:00", endsLocal: null }, { market: "GB", startsLocal: "2026-10-26T09:00", endsLocal: "2027-01-01T00:00" }],
  codeValidMonths: 12,
  pages: [
    { market: "IT", title: "Three months of Individual, as a gift", text: "Three months of Individual, paid once: 29,99 €.", terms: "It never renews.", treatment: "standard" },
    { market: "GB", title: "Three months of Individual, as a gift", text: "Three months of Individual, paid once: £25.99.", terms: "It never renews.", treatment: "gift" },
  ],
};

describe("a saved pass goes through the form and back whole", () => {
  it("keeps every market's price, period of sale and page, the page's treatment too", () => {
    const typed = toPassInput(passFromContent(GIFT), FACTS);
    assert.ok("input" in typed, JSON.stringify(typed));
    assert.deepEqual(typed.input.prices, GIFT.prices);
    assert.deepEqual(typed.input.periods, [{ market: "IT", startsLocal: "2026-10-26T09:00" }, { market: "GB", startsLocal: "2026-10-26T09:00", endsLocal: "2027-01-01T00:00" }]);
    assert.equal(typed.input.pages[1]?.treatment, "gift");
    assert.equal(typed.input.months, 3);
    assert.equal(typed.input.codeValidMonths, 12);
  });

  it("an untouched form says nothing new; an edited price does", () => {
    assert.equal(passDiffers(passFromContent(GIFT), GIFT, FACTS), false);
    const form = passFromContent(GIFT);
    assert.equal(passDiffers({ ...form, markets: form.markets.map((entry) => (entry.market === "GB" ? { ...entry, price: "24.99" } : entry)) }, GIFT, FACTS), true);
  });
});

describe("the form carries every field the gateway's schema gives a pass", () => {
  const schema = buildSchema(readFileSync(new URL("../../../services/gateway/schema/internal.graphql", import.meta.url), "utf8"));
  const pairs: [keyof typeof PASS_CARRIED, string][] = [
    ["PrepaidPassContent", "PrepaidPassInput"], ["PrepaidPassPrice", "PrepaidPassPriceInput"], ["OfferPeriod", "OfferPeriodInput"], ["OfferPage", "OfferPageInput"],
  ];
  for (const [output, input] of pairs) {
    it(`${output} and ${input}`, () => {
      const outputType = schema.getType(output);
      const inputType = schema.getType(input);
      assert.ok(isObjectType(outputType) && isInputObjectType(inputType));
      const carried = [...PASS_CARRIED[output]].sort();
      assert.deepEqual(Object.keys(outputType.getFields()).sort(), carried, `${output}: the console must read and carry every field`);
      assert.deepEqual(Object.keys(inputType.getFields()).sort(), carried, `${input}: the console must send every field back`);
    });
  }
});

describe("the steps stop on what cannot mean anything", () => {
  it("an empty first step names each missing field once", () => {
    assert.deepEqual(checkPassStep({ ...emptyPass(), months: "", codeValidMonths: "" }, 0, FACTS, NOW).map((problem) => problem.field), ["title", "plan", "months", "codeValidMonths", "markets"]);
  });

  it("months and a code's wait inside the engine's limits", () => {
    const problems = checkPassStep({ ...passFromContent(GIFT), months: "25", codeValidMonths: "37" }, 0, FACTS, NOW);
    assert.deepEqual(problems.map((problem) => problem.message), ["Months of the plan: a whole number from 1 to 24.", "Months a code can wait: a whole number from 1 to 36."]);
  });

  it("a price that is not a price, a sale that starts in the past or ends before it starts", () => {
    const form = passFromContent(GIFT);
    const price = checkPassStep({ ...form, markets: [{ ...emptyPassMarket("GB"), price: "25" }, { ...emptyPassMarket("IT"), price: "29.999" }] }, 1, FACTS, NOW);
    assert.deepEqual(price.map((problem) => problem.field), ["IT-price"]);
    const past = checkPassStep({ ...form, markets: [{ ...emptyPassMarket("IT", "2026-10-20T09:00"), price: "29.99" }] }, 2, FACTS, NOW);
    assert.match(past[0]?.message ?? "", /That time has passed in Rome/);
    const backwards = checkPassStep({ ...form, markets: [{ ...emptyPassMarket("IT", "2026-11-02T09:00"), endsLocal: "2026-11-01T09:00", price: "29.99" }] }, 2, FACTS, NOW);
    assert.equal(backwards[0]?.message, "The end of the sale comes after its start.");
  });

  it("the last step gathers every step's problems, each pointing back to its step", () => {
    const steps = checkPassStep({ ...emptyPass(), markets: [emptyPassMarket("IT")] }, 4, FACTS, NOW).map((problem) => passStepOf(problem.field));
    assert.deepEqual([...new Set(steps)], [0, 1, 2, 3]);
    assert.equal(PASS_STEP_OF_CHECK["audience"], 0);
    assert.equal(PASS_STEP_OF_CHECK["floor"], 1);
  });
});

describe("a pass is a gift anyone can hold", () => {
  it("offers no Student plan: a code cannot carry a student verification (§9.3)", () => {
    assert.deepEqual([...PASS_PLANS], ["individual", "duo", "family"]);
  });

  it("the example of the book is three months of Individual at €29.99 in Italy, a code valid 12 months", () => {
    const example = giftPassExample(NOW);
    assert.equal(example.plan, "individual");
    assert.equal(example.months, "3");
    assert.equal(example.codeValidMonths, "12");
    assert.deepEqual(example.markets.map((entry) => [entry.market, entry.price, entry.startsLocal]), [["IT", "29.99", "2026-10-26T09:00"]]);
    assert.deepEqual(checkPassStep(example, 4, FACTS, NOW), []);
  });
});

describe("a time's seconds (the contract's way: minutes, and seconds only when there are some)", () => {
  const withSeconds: PassContent = {
    ...GIFT,
    periods: [{ market: "IT", startsLocal: "2026-10-26T09:00:10", endsLocal: null }, { market: "GB", startsLocal: "2026-10-26T09:00", endsLocal: "2027-01-01T00:00:20" }],
  };
  const moved = (form: ReturnType<typeof passFromContent>, market: string, patch: Partial<{ startsLocal: string; endsLocal: string }>) =>
    ({ ...form, markets: form.markets.map((entry) => (entry.market === market ? { ...entry, ...patch } : entry)) });

  it("keeps them through the form, and a change of seconds alone is a new version", () => {
    const form = passFromContent(withSeconds);
    const typed = toPassInput(form, FACTS);
    assert.ok("input" in typed, JSON.stringify(typed));
    assert.deepEqual(typed.input.periods, [{ market: "IT", startsLocal: "2026-10-26T09:00:10" }, { market: "GB", startsLocal: "2026-10-26T09:00", endsLocal: "2027-01-01T00:00:20" }]);
    assert.equal(passDiffers(form, withSeconds, FACTS), false);
    assert.equal(passDiffers(moved(form, "IT", { startsLocal: "2026-10-26T09:00:50" }), withSeconds, FACTS), true);
    assert.equal(passDiffers(moved(form, "GB", { endsLocal: "2027-01-01T00:00:40" }), withSeconds, FACTS), true);
  });

  it("zero seconds are no seconds", () => {
    assert.equal(passDiffers(moved(passFromContent(GIFT), "IT", { startsLocal: "2026-10-26T09:00:00" }), GIFT, FACTS), false);
  });
});
