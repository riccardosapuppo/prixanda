// The form of a price migration (src/lib/migration-form.ts): a saved version
// goes through the form and back without losing anything, the steps stop on
// what cannot mean anything, the example is the business book's (§14.3) with
// its own dates, and the form carries every field the gateway's schema gives
// a migration (when the schema grows, this test fails until the form follows).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSchema, isInputObjectType, isObjectType } from "graphql";
import {
  checkMigrationStep, emptyMigration, familyRiseExample, increaseWords, MIGRATION_CARRIED, MIGRATION_STEP_OF_CHECK, type MigrationContent, migrationDiffers,
  migrationFromContent, migrationStepOf, toMigrationInput,
} from "../src/lib/migration-form.ts";
import type { MarketFacts } from "../src/lib/offer-form.ts";

const FACTS: MarketFacts = {
  DE: { currency: "EUR", timeZone: "Europe/Berlin", name: "Germany" },
  GB: { currency: "GBP", timeZone: "Europe/London", name: "United Kingdom" },
};
/** Saturday 24 October 2026, 10:42 in Rome: the business book's day. */
const NOW = new Date("2026-10-24T08:42:00Z");

/** The German Family rise of §8.7 and §14.3. */
const FAMILY: MigrationContent = {
  title: "Family price rise, Germany",
  plan: "family",
  market: "DE",
  amount: { amountMinor: "2099", currency: "EUR" },
  noticesLocal: "2026-11-02T09:00",
  startsLocal: "2026-12-01T00:00",
};

describe("a saved migration goes through the form and back whole", () => {
  it("sends back the same plan, market, price and local times", () => {
    const typed = toMigrationInput(migrationFromContent(FAMILY), FACTS);
    assert.ok("input" in typed, JSON.stringify(typed));
    assert.deepEqual(typed.input, FAMILY);
  });

  it("an untouched form says nothing new; a new price or date does", () => {
    assert.equal(migrationDiffers(migrationFromContent(FAMILY), FAMILY, FACTS), false);
    assert.equal(migrationDiffers({ ...migrationFromContent(FAMILY), amount: "21.49" }, FAMILY, FACTS), true);
    assert.equal(migrationDiffers({ ...migrationFromContent(FAMILY), startsLocal: "2027-01-01T00:00" }, FAMILY, FACTS), true);
    // The engine writes seconds the form does not show: the same minute is the same time.
    assert.equal(migrationDiffers(migrationFromContent(FAMILY), { ...FAMILY, noticesLocal: "2026-11-02T09:00:00" }, FACTS), false);
    // The gateway's content names its type: that is no difference either.
    assert.equal(migrationDiffers(migrationFromContent(FAMILY), { __typename: "PriceMigrationContent", ...FAMILY } as MigrationContent, FACTS), false);
  });

  it("is saved only once every field holds something to send: the input has no optional field", () => {
    const typed = toMigrationInput({ ...migrationFromContent(FAMILY), noticesLocal: "" }, FACTS);
    assert.ok("problems" in typed);
    assert.deepEqual(typed.problems.map((problem) => problem.field), ["noticesLocal"]);
  });
});

describe("the form carries every field the gateway's schema gives a migration", () => {
  it("PriceMigrationContent and PriceMigrationInput", () => {
    const schema = buildSchema(readFileSync(new URL("../../../services/gateway/schema/internal.graphql", import.meta.url), "utf8"));
    const output = schema.getType("PriceMigrationContent");
    const input = schema.getType("PriceMigrationInput");
    assert.ok(isObjectType(output) && isInputObjectType(input));
    const carried = [...MIGRATION_CARRIED.PriceMigrationContent].sort();
    assert.deepEqual(Object.keys(output.getFields()).sort(), carried, "the console must read and carry every field");
    assert.deepEqual(Object.keys(input.getFields()).sort(), carried, "the console must send every field back");
  });

  it("sends each finding the engine writes for a migration back to a step", () => {
    // The engine's checks for a migration (services/commerce/src/commerce/domain/validation.py).
    for (const check of ["price", "dates", "overlap", "floor", "time_zone"]) assert.ok(check in MIGRATION_STEP_OF_CHECK, check);
    assert.equal(MIGRATION_STEP_OF_CHECK["dates"], 1);
    assert.equal(MIGRATION_STEP_OF_CHECK["overlap"], 0);
  });
});

describe("the steps stop on what cannot mean anything", () => {
  it("an empty first step names each missing field once", () => {
    assert.deepEqual(checkMigrationStep(emptyMigration(), 0, FACTS, NOW).map((problem) => problem.field), ["title", "market", "plan", "amount"]);
  });

  it("a price that is not a price, in the market's currency", () => {
    const problems = checkMigrationStep({ ...migrationFromContent(FAMILY), market: "GB", amount: "20.999" }, 0, FACTS, NOW);
    assert.deepEqual(problems.map((problem) => problem.message), ["20.999 is not a price in GBP: write it like 20.99."]);
  });

  it("a request in the past, new subscribers before the existing ones are asked, a time the clocks skip", () => {
    const past = checkMigrationStep({ ...migrationFromContent(FAMILY), noticesLocal: "2026-10-20T09:00" }, 1, FACTS, NOW);
    assert.match(past[0]?.message ?? "", /That time has passed in Berlin/);
    const before = checkMigrationStep({ ...migrationFromContent(FAMILY), startsLocal: "2026-11-01T00:00" }, 1, FACTS, NOW);
    assert.deepEqual(before.map((problem) => problem.field), ["startsLocal"]);
    assert.equal(before[0]?.message, "New subscribers pay it from when the existing ones are asked or told, or later.");
    // The clocks skip from 02:00 to 03:00 in Berlin on 28 March 2027.
    const skipped = checkMigrationStep({ ...migrationFromContent(FAMILY), noticesLocal: "2027-03-28T02:30", startsLocal: "2027-04-01T00:00" }, 1, FACTS, NOW);
    assert.match(skipped[0]?.message ?? "", /The clocks skip that time in Berlin/);
  });

  it("the last step gathers every step's problems, each pointing back to its step", () => {
    const problems = checkMigrationStep({ ...emptyMigration(), market: "DE" }, 2, FACTS, NOW);
    assert.deepEqual(problems.map((problem) => migrationStepOf(problem.field)), [0, 0, 0, 1, 1]);
  });
});

describe("the example of the business book", () => {
  it("is the Family plan in Germany at €20.99, asked on 2 November, new subscribers from 1 December", () => {
    const example = familyRiseExample(NOW);
    assert.deepEqual(example, { title: "Family price rise, Germany", plan: "family", market: "DE", amount: "20.99", noticesLocal: "2026-11-02T09:00", startsLocal: "2026-12-01T00:00" });
    assert.deepEqual(checkMigrationStep(example, 2, FACTS, NOW), []);
  });

  it("says how much the new price adds to the one in force", () => {
    assert.deepEqual(increaseWords({ amountMinor: "1899", currency: "EUR" }, "20.99"), { amountMinor: 200n, basisPoints: 1053 });
    assert.equal(increaseWords(null, "20.99"), null);
    assert.equal(increaseWords({ amountMinor: "1899", currency: "EUR" }, "not a price"), null);
  });
});
