// The writing of money, case by case: the console's as the engine writes it,
// the site's as each country writes a price, and typed prices read back.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCount, formatMoney, formatPercent, formatSitePrice, MINUS, minorUnits, NBSP, NNBSP, parseAmount } from "../src/money.ts";

const eur = (amountMinor: string | number | bigint) => ({ amountMinor, currency: "EUR" });
const gbp = (amountMinor: string | number | bigint) => ({ amountMinor, currency: "GBP" });

describe("the console writes every amount one way, as the engine does", () => {
  const cases: [Parameters<typeof formatMoney>[0], string][] = [
    [eur("579"), "€5.79"],
    [gbp("949"), "£9.49"],
    [eur("-187751"), `${MINUS}€1,877.51`],
    [eur("0"), "€0.00"],
    [eur("5"), "€0.05"],
    [eur("-5"), `${MINUS}€0.05`],
    [eur("200971416"), "€2,009,714.16"],
    [eur("100000"), "€1,000.00"],
    [eur("99999"), "€999.99"],
    [gbp("54160800"), "£541,608.00"],
    [{ amountMinor: "1000", currency: "JPY" }, "¥1,000"],
    [{ amountMinor: "-1234567", currency: "JPY" }, `${MINUS}¥1,234,567`],
    [eur(299n), "€2.99"],
    [eur(610), "€6.10"],
    [eur("123456789012345678901234567890"), "€1,234,567,890,123,456,789,012,345,678.90"],
  ];
  for (const [money, written] of cases) {
    it(`${money.amountMinor} ${money.currency} is ${written}`, () => assert.equal(formatMoney(money), written));
  }

  it("uses the real minus sign, never a hyphen", () => {
    const written = formatMoney(eur("-100"));
    assert.equal(written.codePointAt(0), 0x2212);
    assert.ok(!written.includes("-"));
  });

  it("refuses an amount that is not a whole number of minor units", () => {
    assert.throws(() => formatMoney(eur("5.79")), TypeError);
    assert.throws(() => formatMoney(eur(5.79)), TypeError);
    assert.throws(() => formatMoney(eur("")), TypeError);
    assert.throws(() => formatMoney(eur("1e3")), TypeError);
    assert.throws(() => formatMoney(eur(Number.MAX_SAFE_INTEGER + 2)), TypeError);
  });

  it("refuses a currency whose minor units it does not know", () => {
    assert.throws(() => formatMoney({ amountMinor: "100", currency: "USD" }), RangeError);
  });

  it("reads the gateway's digits as a bigint, beyond what a float can hold", () => {
    assert.equal(minorUnits("9007199254740993"), 9007199254740993n);
  });
});

describe("the site writes a price the way its market's country writes it", () => {
  it("Italy and Germany: comma for decimals, a point for thousands, the euro after a no-break space", () => {
    assert.equal(formatSitePrice(eur("1049"), "IT"), `10,49${NBSP}€`);
    assert.equal(formatSitePrice(eur("1899"), "DE"), `18,99${NBSP}€`);
    assert.equal(formatSitePrice(eur("123499"), "IT"), `1.234,99${NBSP}€`);
    assert.equal(formatSitePrice(eur("299"), "IT"), `2,99${NBSP}€`);
  });

  it("France: a narrow no-break space for thousands", () => {
    assert.equal(formatSitePrice(eur("1099"), "FR"), `10,99${NBSP}€`);
    assert.equal(formatSitePrice(eur("123499"), "FR"), `1${NNBSP}234,99${NBSP}€`);
  });

  it("the United Kingdom: the pound first, a point for pence", () => {
    assert.equal(formatSitePrice(gbp("949"), "GB"), "£9.49");
    assert.equal(formatSitePrice(gbp("123456"), "GB"), "£1,234.56");
  });

  it("a market it does not know is an error, not a guess", () => {
    assert.throws(() => formatSitePrice(eur("100"), "ES" as never), RangeError);
  });
});

describe("counts and shares, as the engine writes them", () => {
  it("groups thousands with commas", () => {
    assert.equal(formatCount(0), "0");
    assert.equal(formatCount(999), "999");
    assert.equal(formatCount(10000), "10,000");
    assert.equal(formatCount(202562), "202,562");
    assert.equal(formatCount(1234567n), "1,234,567");
    assert.equal(formatCount(-1200), `${MINUS}1,200`);
  });

  it("writes basis points as a percentage without trailing zeros", () => {
    assert.equal(formatPercent(2000), "20%");
    assert.equal(formatPercent(4000), "40%");
    assert.equal(formatPercent(1250), "12.5%");
    assert.equal(formatPercent(25), "0.25%");
    assert.equal(formatPercent(6555), "65.55%");
    assert.equal(formatPercent(10000), "100%");
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatPercent(-150), `${MINUS}1.5%`);
  });
});

describe("a price typed by a person becomes minor units, never a float", () => {
  const cases: [string, string, bigint | null][] = [
    ["2.99", "EUR", 299n],
    ["2,99", "EUR", 299n],
    ["€2.99", "EUR", 299n],
    ["2,99 €", "EUR", 299n],
    ["3", "EUR", 300n],
    ["2.9", "EUR", 290n],
    ["1,234.50", "EUR", 123450n],
    ["1234.5", "EUR", 123450n],
    [" 4.49 ", "EUR", 449n],
    ["£5.29", "GBP", 529n],
    ["1000", "JPY", 1000n],
    ["2.999", "EUR", null],
    ["-2.99", "EUR", null],
    ["two", "EUR", null],
    ["", "EUR", null],
    ["2..99", "EUR", null],
  ];
  for (const [typed, currency, expected] of cases) {
    it(`${JSON.stringify(typed)} in ${currency} is ${expected === null ? "not a price" : `${expected}`}`, () => {
      assert.equal(parseAmount(typed, currency), expected);
    });
  }
});
