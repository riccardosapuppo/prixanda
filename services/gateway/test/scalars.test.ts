// The custom scalars, both ways: what a client sends is refused when
// malformed, and what the engine answers is checked before it leaves.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Kind, parseValue } from "graphql";
import {
  DateTimeScalar, LocalDateTimeScalar, MarketCodeScalar, MoneyScalar, PlanCodeScalar, Sha256Scalar,
} from "../src/core/scalars.ts";
import { codes, type Harness, startHarness } from "./support/harness.ts";

describe("Money", () => {
  test("reads an integer of minor units, as a string of digits or a safe integer", () => {
    assert.deepEqual(MoneyScalar.parseValue({ amountMinor: "579", currency: "EUR" }), { amountMinor: 579n, currency: "EUR" });
    assert.deepEqual(MoneyScalar.parseValue({ amountMinor: 579, currency: "GBP" }), { amountMinor: 579n, currency: "GBP" });
    assert.deepEqual(MoneyScalar.parseValue({ amountMinor: "-187751", currency: "EUR" }), { amountMinor: -187751n, currency: "EUR" });
    assert.deepEqual(MoneyScalar.parseValue({ amountMinor: "-9223372036854775808", currency: "JPY" }), { amountMinor: -(2n ** 63n), currency: "JPY" });
  });

  test("refuses fractions, floats, other keys, other currencies and amounts past 64 bits", () => {
    for (const value of [
      { amountMinor: 5.79, currency: "EUR" },
      { amountMinor: "5.79", currency: "EUR" },
      { amountMinor: "1e3", currency: "EUR" },
      { amountMinor: "0579", currency: "EUR" },
      { amountMinor: 2 ** 53, currency: "EUR" },
      { amountMinor: "9223372036854775808", currency: "EUR" },
      { amountMinor: "579", currency: "eur" },
      { amountMinor: "579" },
      { amountMinor: "579", currency: "EUR", formatted: "€5.79" },
      "579 EUR",
      null,
    ]) {
      assert.throws(() => MoneyScalar.parseValue(value), /Money/, JSON.stringify(value));
    }
  });

  test("keeps every digit of an integer written in the query, past what a float can hold", () => {
    const ast = parseValue('{ amountMinor: 9007199254740993, currency: "EUR" }');
    assert.deepEqual(MoneyScalar.parseLiteral(ast, null), { amountMinor: 9007199254740993n, currency: "EUR" });
    assert.throws(() => MoneyScalar.parseLiteral(parseValue('{ amountMinor: 5.79, currency: "EUR" }'), null), /Money/);
    assert.throws(() => MoneyScalar.parseLiteral({ kind: Kind.STRING, value: "579" }, null), /Money must be an object/);
  });

  test("writes the engine's bigint as a string, and refuses anything else the engine might send", () => {
    assert.deepEqual(MoneyScalar.serialize({ amountMinor: 9223372036854775807n, currency: "EUR" }), { amountMinor: "9223372036854775807", currency: "EUR" });
    assert.throws(() => MoneyScalar.serialize({ amountMinor: 579, currency: "EUR" }), /not an integer with a currency/);
    assert.throws(() => MoneyScalar.serialize({ amountMinor: 579n, currency: "" }), /not an integer with a currency/);
  });
});

describe("dates and times", () => {
  test("LocalDateTime takes a real wall-clock time without an offset; what the clocks skip is the engine's to say", () => {
    for (const value of ["2026-10-26T09:00", "2026-10-26T09:00:00", "2026-10-25T02:30", "2028-02-29T23:59"]) {
      assert.equal(LocalDateTimeScalar.parseValue(value), value);
    }
    for (const value of ["2026-02-29T10:00", "2026-13-01T00:00", "2026-10-26T24:00", "2026-10-26T09:60", "2026-10-26T09:00+01:00",
      "2026-10-26T09:00Z", "2026-10-26 09:00", "2026-10-26T09:00:00.5", "26/10/2026 09:00", ""]) {
      assert.throws(() => LocalDateTimeScalar.parseValue(value), /LocalDateTime/, value);
    }
  });

  test("DateTime takes an instant in UTC with a Z, and nothing else", () => {
    for (const value of ["2026-10-24T07:00:00Z", "2026-10-24T07:00:00.123456Z"]) assert.equal(DateTimeScalar.parseValue(value), value);
    for (const value of ["2026-10-24T07:00:00+00:00", "2026-10-24T07:00Z", "2026-10-24", "2026-02-30T00:00:00Z"]) {
      assert.throws(() => DateTimeScalar.parseValue(value), /DateTime/, value);
    }
    assert.throws(() => DateTimeScalar.serialize("2026-10-24T09:00:00+02:00"), /the engine answered/);
  });
});

describe("codes and digests", () => {
  test("MarketCode and PlanCode take the database's shapes", () => {
    assert.equal(MarketCodeScalar.parseValue("IT"), "IT");
    for (const value of ["it", "ITA", "I1", ""]) assert.throws(() => MarketCodeScalar.parseValue(value), /MarketCode/);
    for (const value of ["student", "family-plus", "a"]) assert.equal(PlanCodeScalar.parseValue(value), value);
    for (const value of ["Student", "1plan", "plan_x", "a".repeat(32)]) assert.throws(() => PlanCodeScalar.parseValue(value), /PlanCode/);
  });

  test("Sha256 takes 64 hexadecimal digits and keeps them in lower case", () => {
    assert.equal(Sha256Scalar.parseValue("AB".repeat(32)), "ab".repeat(32));
    for (const value of ["a".repeat(63), "g".repeat(64), `${"a".repeat(64)} `]) assert.throws(() => Sha256Scalar.parseValue(value), /Sha256/);
  });
});

describe("through HTTP", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.close();
  });

  test("a malformed value in the variables is a 400 BAD_USER_INPUT, and the engine hears nothing", async () => {
    const client = harness.console();
    await client.signIn("commercial-lead-1");
    harness.engine.clearCalls();
    const answer = await client.graphql("mutation ($p: ListPriceInput!) { createListPrice(listPrice: $p) { __typename } }", {
      variables: { p: { title: "x", plan: "duo", market: "IT", amount: { amountMinor: 14.99, currency: "EUR" }, startsLocal: "2027-01-01T00:00" } },
    });
    assert.equal(answer.status, 400);
    assert.deepEqual(codes(answer), ["BAD_USER_INPUT"]);
    assert.equal(harness.engine.count(), 0);
  });
});
