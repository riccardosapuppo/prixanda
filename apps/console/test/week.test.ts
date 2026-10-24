// The week on the home. Lined up by local time, every lane starts at the
// axis calendar's midnight, so 09:00 on Monday falls in Monday's column in
// every market, even in the hour when it is already tomorrow in Rome and still
// today in London; each market's "now" is marked from its own clock. Lined up
// by UTC, the same instant falls on the same vertical.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWeek, type Week, type WeekMarket, type WeekOffer } from "../src/lib/week.ts";

const ITALY: WeekMarket = { code: "IT", name: "Italy", timeZone: "Europe/Rome" };
const UK: WeekMarket = { code: "GB", name: "United Kingdom", timeZone: "Europe/London" };

/** Two identical starts, Monday 26 October at 09:00, each in its market's own time. */
const PASS: WeekOffer = {
  id: "7",
  title: "Student Autumn Pass",
  state: "APPROVED",
  version: 3,
  plan: "student",
  periods: [
    { market: "IT", startsLocal: "2026-10-26T09:00", endsLocal: "2027-01-26T09:00" },
    { market: "GB", startsLocal: "2026-10-26T09:00", endsLocal: "2027-01-26T09:00" },
  ],
};

/** 22:30 UTC on Friday 23 October: 00:30 on Saturday in Rome, 23:30 on Friday in London. */
const ROME_TOMORROW_LONDON_TODAY = "2026-10-23T22:30:00Z";

function weekAt(now: string, align: "local" | "utc"): Week {
  return buildWeek({ now: new Date(now), align, markets: [ITALY, UK], plans: ["student"], prices: [], offers: [PASS], axisZone: "Europe/Rome" });
}

const laneOf = (week: Week, market: string) => week.lanes.find((lane) => lane.market.code === market);
const offerStart = (week: Week, market: string) => laneOf(week, market)?.sheets.find((sheet) => sheet.kind === "offer")?.from;

/** The label of the day column a position falls in. */
function dayAt(week: Week, at: number): string {
  return week.days[Math.floor(at * week.days.length + 1e-9)]?.label ?? "outside the week";
}

describe("the week lined up by local time", () => {
  it("puts two identical starts in the same day's column when Rome is already tomorrow and London still today", () => {
    const week = weekAt(ROME_TOMORROW_LONDON_TODAY, "local");
    assert.equal(week.days[0]?.label, "Sat 24 Oct");
    const italy = offerStart(week, "IT");
    const uk = offerStart(week, "GB");
    assert.ok(italy !== undefined && uk !== undefined, "both lanes draw the offer");
    assert.equal(dayAt(week, italy), "Mon 26");
    assert.equal(dayAt(week, uk), "Mon 26");
    assert.equal(uk, italy);
  });

  it("marks each market's now from its own clock: past midnight in Rome, still before the first day in London", () => {
    const week = weekAt(ROME_TOMORROW_LONDON_TODAY, "local");
    const halfAnHour = 0.5 / (7 * 24);
    assert.ok(Math.abs((laneOf(week, "IT")?.now ?? -1) - halfAnHour) < 1e-9, "00:30 on Saturday in Rome");
    assert.equal(laneOf(week, "GB")?.now, 0, "23:30 on Friday in London is before the window: held at its start");
  });

  it("marks the clocks going back where each market's wall clock shows it", () => {
    const week = weekAt(ROME_TOMORROW_LONDON_TODAY, "local");
    const hours = (at: number | undefined) => Math.round((at ?? -1) * 7 * 24 * 60) / 60;
    // Sunday 25 October: 03:00 back to 02:00 in Rome, 02:00 back to 01:00 in London, from Saturday 00:00.
    assert.equal(laneOf(week, "IT")?.clockChange?.words, "Clocks back 03:00 to 02:00");
    assert.equal(hours(laneOf(week, "IT")?.clockChange?.at), 27);
    assert.equal(laneOf(week, "GB")?.clockChange?.words, "Clocks back 02:00 to 01:00");
    assert.equal(hours(laneOf(week, "GB")?.clockChange?.at), 26);
  });
});

describe("the week lined up by UTC", () => {
  it("puts the same instant on the same vertical: London's 09:00 is an hour after Rome's", () => {
    const week = weekAt(ROME_TOMORROW_LONDON_TODAY, "utc");
    const italy = offerStart(week, "IT");
    const uk = offerStart(week, "GB");
    assert.ok(italy !== undefined && uk !== undefined, "both lanes draw the offer");
    assert.ok(Math.abs((uk - italy) * 7 * 24 - 1) < 1e-9);
    assert.equal(laneOf(week, "IT")?.now, laneOf(week, "GB")?.now);
  });
});
