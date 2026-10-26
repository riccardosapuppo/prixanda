// The site's pure modules: dates put into words, the markets of an address,
// who an offer for an artist's listeners is for, the rounds of asking while
// a payment waits, and the geometry of the drawings, held to their rules.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canopy, monthsScene } from "../src/components/art/geometry.ts";
import { copy } from "../src/content/copy.ts";
import { DEFAULT_MARKET, isSiteMarket, marketFromQuery, marketShort, SITE_MARKETS } from "../src/data/markets.ts";
import { lastDayBefore, siteDay, siteTime } from "../src/lib/dates.ts";
import { type RoundTimer, WaitRounds } from "../src/lib/rounds.ts";

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

describe("who an offer for an artist's listeners is for (§14.2)", () => {
  const rule = (minSeconds: number, withinDays = 30) => ({ artist: "Ottoline Marr", minSeconds, withinDays });

  it("says it as what they did, with the API's artist, time and days", () => {
    assert.equal(copy.listening.forListeners(rule(7_200)), "For listeners who played Ottoline Marr for more than 2 hours in the last 30 days.");
    assert.equal(copy.listening.forListeners(rule(10_800, 7)), "For listeners who played Ottoline Marr for more than 3 hours in the last 7 days.");
  });

  it("words the time as the engine does: whole hours, else whole minutes, else seconds; one of each in the singular", () => {
    assert.match(copy.listening.forListeners(rule(3_600)), /for more than 1 hour in/);
    assert.match(copy.listening.forListeners(rule(5_400)), /for more than 90 minutes in/);
    assert.match(copy.listening.forListeners(rule(60)), /for more than 1 minute in/);
    assert.match(copy.listening.forListeners(rule(45)), /for more than 45 seconds in/);
    assert.match(copy.listening.forListeners(rule(1)), /for more than 1 second in/);
    assert.match(copy.listening.forListeners(rule(7_776_000, 90)), /for more than 2,160 hours in the last 90 days/);
    assert.match(copy.listening.forListeners(rule(7_200, 1)), /in the last day\.$/);
  });

  it("tags its campaign with the artist", () => {
    assert.equal(copy.listening.tag("Doppelfenster"), "Listeners of Doppelfenster");
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
  // is 1,47 €; Sonequo tops it up by 1,53 € to the 3,00 € minimum.
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

describe("the rounds of asking while a payment waits", () => {
  const LIMIT = 30_000;

  /** A clock of the test's own: its timers fire when the test moves it. */
  function testClock() {
    let now = 0;
    let made = 0;
    const timers = new Map<number, { readonly at: number; readonly done: () => void }>();
    const timer: RoundTimer = {
      start(done, ms) {
        made += 1;
        timers.set(made, { at: now + ms, done });
        return made;
      },
      stop: (handle) => void timers.delete(handle as number),
    };
    const advance = (ms: number) => {
      now += ms;
      for (const [handle, each] of [...timers].sort(([, a], [, b]) => a.at - b.at)) {
        if (each.at > now) continue;
        timers.delete(handle);
        each.done();
      }
    };
    return { timer, advance, running: () => timers.size };
  }

  function rounds() {
    const clock = testClock();
    let changes = 0;
    const held = new WaitRounds(LIMIT, () => (changes += 1), clock.timer);
    return { held, clock, changes: () => changes };
  }

  it("asks for the length of a round once something waits, then says the provider has not answered", () => {
    const { held, clock, changes } = rounds();
    held.follow(true);
    assert.deepEqual({ asking: held.asking, timedOut: held.timedOut }, { asking: true, timedOut: false });
    clock.advance(LIMIT - 1);
    assert.equal(held.timedOut, false);
    clock.advance(1);
    assert.deepEqual({ asking: held.asking, timedOut: held.timedOut }, { asking: false, timedOut: true });
    assert.equal(changes(), 1, "the page is told once");
  });

  it("opens a new round with each check again, which runs out in its turn and is said again", () => {
    const { held, clock } = rounds();
    held.follow(true);
    clock.advance(LIMIT);
    assert.equal(held.timedOut, true);
    for (let round = 2; round <= 3; round += 1) {
      held.checkAgain();
      assert.deepEqual({ asking: held.asking, timedOut: held.timedOut }, { asking: true, timedOut: false }, `round ${round} asks`);
      clock.advance(LIMIT - 1);
      assert.equal(held.timedOut, false, `round ${round} lasts its length`);
      clock.advance(1);
      assert.deepEqual({ asking: held.asking, timedOut: held.timedOut }, { asking: false, timedOut: true }, `round ${round} runs out`);
    }
  });

  it("counts a round from the check again, not from the round before", () => {
    const { held, clock } = rounds();
    held.follow(true);
    clock.advance(20_000);
    held.checkAgain();
    clock.advance(20_000);
    assert.equal(held.timedOut, false);
    clock.advance(10_000);
    assert.equal(held.timedOut, true);
    assert.equal(clock.running(), 0, "one round at a time");
  });

  it("ends when nothing waits any more, and opens nothing for a check again then, nor after the page went", () => {
    const { held, clock } = rounds();
    held.follow(true);
    held.follow(false);
    assert.equal(clock.running(), 0);
    clock.advance(LIMIT * 2);
    assert.deepEqual({ asking: held.asking, timedOut: held.timedOut }, { asking: true, timedOut: false });
    held.checkAgain();
    assert.equal(clock.running(), 0, "nothing waits: no round");
    held.follow(true);
    held.dispose();
    assert.equal(clock.running(), 0, "no round outlives the page");
  });
});
