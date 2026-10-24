// The site's pure modules: dates put into words, the markets of an address,
// and the geometry of the drawings, held to their rules.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canopy, monthsScene } from "../src/components/art/geometry.ts";
import { DEFAULT_MARKET, isSiteMarket, marketFromQuery, marketShort, SITE_MARKETS } from "../src/data/markets.ts";
import { lastDayBefore, siteDay, siteTime } from "../src/lib/dates.ts";

describe("dates in words", () => {
  it("writes a day of a market's calendar the English way, in every market", () => {
    assert.equal(siteDay("2026-10-26"), "26 October 2026");
    assert.equal(siteDay("2026-10-26T09:00"), "26 October 2026");
    assert.equal(siteDay("2027-01-01T00:00:00"), "1 January 2027");
  });

  it("names the last day an offer can be taken: an end at midnight is the day before", () => {
    assert.equal(lastDayBefore("2026-11-30T00:00"), "29 November 2026");
    assert.equal(lastDayBefore("2026-11-30T12:00"), "30 November 2026");
    assert.equal(lastDayBefore("2026-11-30T00:01"), "30 November 2026");
    assert.equal(lastDayBefore("2027-01-01T00:00"), "31 December 2026");
    assert.equal(lastDayBefore("2028-03-01T00:00"), "29 February 2028");
    assert.equal(lastDayBefore("2027-03-01T00:00"), "28 February 2027");
    assert.equal(lastDayBefore("2026-11-30T00:00", { withYear: false }), "29 November");
  });

  it("writes an instant as the wall-clock time of the market, across the clock change of 25 October 2026", () => {
    // Rome is UTC+2 until the night of 25 October, UTC+1 after it (business book §3.7).
    assert.equal(siteTime("2026-10-24T07:00:00Z", "Europe/Rome"), "09:00");
    assert.equal(siteTime("2026-10-26T08:00:00Z", "Europe/Rome"), "09:00");
    assert.equal(siteTime("2026-10-26T08:00:00Z", "Europe/London"), "08:00");
    assert.equal(siteTime("2026-10-24T22:30:00Z", "Europe/Berlin"), "00:30");
  });

  it("refuses what is not a date", () => {
    assert.throws(() => siteDay("26/10/2026"), RangeError);
    assert.throws(() => siteDay("2026-13-01"), RangeError);
    assert.throws(() => siteTime("yesterday", "Europe/Rome"), RangeError);
  });
});

describe("the market of an address", () => {
  it("reads ?market= in any case, and nothing it does not know", () => {
    assert.equal(marketFromQuery(new URLSearchParams("market=FR")), "FR");
    assert.equal(marketFromQuery(new URLSearchParams("market=gb")), "GB");
    assert.equal(marketFromQuery(new URLSearchParams("market=US")), null);
    assert.equal(marketFromQuery(new URLSearchParams("offer=1")), null);
  });

  it("knows the four markets, Italy first", () => {
    assert.deepEqual(SITE_MARKETS, ["IT", "FR", "DE", "GB"]);
    assert.equal(DEFAULT_MARKET, "IT");
    assert.ok(SITE_MARKETS.every(isSiteMarket));
    assert.equal(isSiteMarket("JP"), false);
    assert.equal(isSiteMarket(42), false);
    assert.equal(marketShort("GB"), "UK");
    assert.equal(marketShort("DE"), "DE");
  });
});

describe("the months of an offer, drawn", () => {
  it("hangs one sail per month at the offer price, then the list price to the edge", () => {
    const scene = monthsScene(3);
    assert.equal(scene.sails.length, 3);
    assert.equal(scene.columns, 5);
    assert.equal(scene.ties.length, 4);
    assert.equal(scene.list.hem[1], scene.width);
  });

  it("keeps the sails apart, in order, inside the drawing", () => {
    for (const months of [1, 2, 3, 6, 12]) {
      const scene = monthsScene(months);
      let previous = 0;
      for (const sail of scene.sails) {
        assert.ok(sail.a > previous && sail.b > sail.a, `months ${months}: sails in order`);
        assert.ok(sail.bottom > scene.rope && sail.bottom < scene.height, `months ${months}: a sail hangs inside the drawing`);
        previous = sail.b;
      }
      assert.ok(scene.list.hem[0] > previous, `months ${months}: the list price starts after the last month`);
      assert.equal(scene.columns, Math.max(months + 2, 5));
    }
  });

  it("refuses an offer of no months", () => {
    assert.throws(() => monthsScene(0), RangeError);
    assert.throws(() => monthsScene(1.5), RangeError);
  });
});

describe("the canopy of where money goes", () => {
  // The Student Autumn Pass in Italy (business book §6.7): of 2,99 €, the pool
  // is 1,47 €; Rione tops it up by 1,53 € to the 3,00 € minimum.
  const owed = 300n;
  const pool = 147n;
  const drawn = canopy([{ from: 0n, to: owed, dye: "madder" }, { from: pool, to: owed, dye: "saffron" }], owed, { minimum: 300n, height: 104 });

  it("gives each sail the width of its amount, and the two overlap by exactly the top-up", () => {
    const [artists, service] = drawn.sails;
    assert.ok(artists && service);
    const width = (sail: typeof artists) => sail.hem[1] - sail.hem[0];
    assert.ok(Math.abs(width(artists) / width(service) - 300 / 153) < 1e-9);
    assert.equal(service.hem[1], artists.hem[1], "the top-up ends where the artists' share ends");
  });

  it("hangs the cord of the minimum where the minimum is", () => {
    assert.equal(drawn.cord, drawn.sails[0]?.hem[1]);
    assert.equal(canopy([{ from: 0n, to: 516n, dye: "madder" }], 1049n).cord, null);
  });

  it("draws nothing for an empty part and refuses a canopy of no length", () => {
    assert.equal(canopy([{ from: 100n, to: 100n, dye: "saffron" }], 300n).sails.length, 0);
    assert.throws(() => canopy([], 0n), RangeError);
  });
});
