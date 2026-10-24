// The week on the home, as lanes: one lane per market and plan, the list
// price in force drawn as a sheet hanging from the top, an offer as a sheet
// rising from the bottom, and where they overlap the offer runs over the
// list price. Only the lanes where something happens this week are drawn;
// the rest are counted.
//
// Two ways of lining the lanes up: by each market's local time (09:00 in
// Rome and 09:00 in London fall on the same vertical, as the offers are
// scheduled, §3.7) or by UTC (the same instant on the same vertical). By
// local time every lane starts at the axis calendar's first midnight, read on
// the market's own wall clock, so a Monday start falls in Monday's column in
// every market even when one of them is still on the day before; each
// market's "now" is marked from its own clock. The clock change of the week
// is marked where it happens.
import { formatLocal, type LocalParts, localToInstant, offsetMinutes, parseLocal, partsIn, zoneCity } from "./time.ts";

export type Align = "local" | "utc";

export type WeekMarket = { readonly code: string; readonly name: string; readonly timeZone: string };
export type WeekPrice = { readonly plan: string; readonly market: string; readonly amount: { readonly amountMinor: string; readonly currency: string }; readonly validFrom: string; readonly validUntil: string | null };
export type WeekOffer = {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly version: number;
  readonly plan: string;
  readonly periods: readonly { readonly market: string; readonly startsLocal: string; readonly endsLocal: string | null }[];
};

export type Sheet = {
  readonly kind: "price" | "offer";
  /** For an offer: live, approved (or scheduled) and waiting to start, or waiting for a signature. */
  readonly look: "price" | "live" | "approved" | "waiting";
  readonly from: number;
  readonly to: number;
  readonly label: string;
  readonly state?: string;
  readonly changeId?: string;
  readonly version?: number;
  readonly amount?: WeekPrice["amount"];
  /** Whether the sheet goes on past the window's end. */
  readonly continues: boolean;
};

export type Lane = {
  readonly market: WeekMarket;
  readonly plan: string;
  readonly sheets: readonly Sheet[];
  /** The lane's state in a few words, and its detail. */
  readonly status: { readonly word: "Overlapping" | "Approaching" | "Waiting" | "Price change"; readonly detail: string };
  /** Where "now" falls, from 0 to 1. */
  readonly now: number;
  /** Where the clocks change in this market this week, if they do. */
  readonly clockChange: { readonly at: number; readonly words: string } | null;
};

export type Week = {
  readonly days: readonly { readonly label: string; readonly at: number; readonly weekend: boolean }[];
  readonly lanes: readonly Lane[];
  /** The market and plan lanes with nothing happening this week. */
  readonly clear: number;
};

const DAY = 86_400_000;
export const WEEK_DAYS = 7;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const wall = (parts: LocalParts) => Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

/** A position on the lane, 0 at the window's start and 1 at its end, for a local time of a market. */
function placeLocal(local: string, zone: string, align: Align, start: number): number | null {
  const parts = parseLocal(local);
  if (parts === null) return null;
  if (align === "local") return (wall(parts) - start) / (WEEK_DAYS * DAY);
  const at = localToInstant(parts, zone);
  const instant = at.kind === "single" ? at.instant : at.kind === "repeated" ? at.earlier : null;
  return instant === null ? null : (instant.getTime() - start) / (WEEK_DAYS * DAY);
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** The instant a market's wall clock shows a local time (the earlier one when the clocks repeat it), or null when they skip it. */
function instantOf(local: LocalParts, zone: string): number | null {
  const at = localToInstant(local, zone);
  return at.kind === "single" ? at.instant.getTime() : at.kind === "repeated" ? at.earlier.getTime() : null;
}

/** The clock change of a market inside the window, found hour by hour. */
function clockChange(zone: string, startUtc: number, align: Align, windowStart: number): Lane["clockChange"] {
  const first = offsetMinutes(new Date(startUtc), zone);
  for (let hour = 1; hour <= WEEK_DAYS * 24; hour++) {
    const instant = startUtc + hour * 3_600_000;
    const offset = offsetMinutes(new Date(instant), zone);
    if (offset !== first) {
      // The change happened in the hour before `instant`: find the minute.
      let low = instant - 3_600_000;
      let high = instant;
      while (high - low > 60_000) {
        const middle = low + Math.floor((high - low) / 120_000) * 60_000;
        if (offsetMinutes(new Date(middle), zone) === first) low = middle;
        else high = middle;
      }
      const before = partsIn(new Date(high - 1), zone);
      const after = partsIn(new Date(high), zone);
      const two = (n: number) => String(n).padStart(2, "0");
      const fromWords = `${two(before.hour === 23 ? 0 : before.hour + (before.minute === 59 ? 1 : 0))}:00`;
      const toWords = `${two(after.hour)}:${two(after.minute)}`;
      const back = offset < first;
      const at = align === "local" ? (wall({ ...before, hour: before.hour, minute: 0, second: 0 }) + 3_600_000 - windowStart) / (WEEK_DAYS * DAY) : (high - windowStart) / (WEEK_DAYS * DAY);
      return { at: clamp(at), words: `Clocks ${back ? "back" : "forward"} ${fromWords} to ${toWords}` };
    }
  }
  return null;
}

export function buildWeek(input: {
  readonly now: Date;
  readonly align: Align;
  readonly markets: readonly WeekMarket[];
  readonly plans: readonly string[];
  readonly prices: readonly WeekPrice[];
  readonly offers: readonly WeekOffer[];
  /** The zone whose calendar the axis follows: the day labels, every lane's first midnight, and the instants when lanes line up by UTC. */
  readonly axisZone: string;
}): Week {
  const { now, align, markets, plans, prices, offers } = input;
  const axisToday = partsIn(now, input.axisZone);
  const axisStart = Date.UTC(axisToday.year, axisToday.month - 1, axisToday.day);
  const days = Array.from({ length: WEEK_DAYS }, (_, index) => {
    const date = new Date(axisStart + index * DAY);
    const weekday = date.getUTCDay();
    return { label: `${WEEKDAYS[weekday]} ${date.getUTCDate()}${index === 0 ? ` ${MONTHS[date.getUTCMonth()]}` : ""}`, at: index / WEEK_DAYS, weekend: weekday === 0 || weekday === 6 };
  });

  // By local time, every lane starts at the axis calendar's first midnight as
  // a wall-clock time (the same for every market); by UTC, at the axis zone's
  // midnight as an instant.
  const firstMidnight = { ...axisToday, hour: 0, minute: 0, second: 0 };
  const utcStart = instantOf(firstMidnight, input.axisZone) ?? axisStart;
  const start = align === "local" ? axisStart : utcStart;

  const lanes: Lane[] = [];
  let clear = 0;
  for (const market of markets) {
    // The market's own clock, against the axis calendar: in the hour when the
    // axis zone is already on the next day, it falls before the first column.
    const nowAt = align === "local" ? (wall(partsIn(now, market.timeZone)) - start) / (WEEK_DAYS * DAY) : (now.getTime() - start) / (WEEK_DAYS * DAY);
    // The clock change is looked for from the window's first midnight in this market.
    const changeStart = align === "local" ? instantOf(firstMidnight, market.timeZone) ?? utcStart : utcStart;

    for (const plan of plans) {
      const sheets: Sheet[] = [];
      const lanePrices = prices
        .filter((price) => price.market === market.code && price.plan === plan)
        .map((price) => ({ price, from: placeLocal(price.validFrom, market.timeZone, align, start) ?? -Infinity, to: price.validUntil ? placeLocal(price.validUntil, market.timeZone, align, start) ?? Infinity : Infinity }))
        .filter((entry) => entry.from < 1 && entry.to > 0)
        .sort((a, b) => a.from - b.from);
      for (const { price, from, to } of lanePrices) {
        sheets.push({ kind: "price", look: "price", from: clamp(from), to: clamp(to), label: "List price", amount: price.amount, continues: to > 1 });
      }
      const priceChange = lanePrices.find((entry) => entry.from > 0);
      let approaching: { at: number; words: string } | null = null;
      let overlapping = false;
      let waiting: string | null = null;
      for (const offer of offers) {
        if (offer.plan !== plan) continue;
        const look: Sheet["look"] | null = offer.state === "ACTIVE" ? "live" : offer.state === "APPROVED" || offer.state === "SCHEDULED" ? "approved"
          : offer.state === "IN_APPROVAL" || offer.state === "VALIDATED" ? "waiting" : null;
        if (look === null) continue;
        for (const period of offer.periods) {
          if (period.market !== market.code) continue;
          const from = placeLocal(period.startsLocal, market.timeZone, align, start);
          const to = period.endsLocal ? placeLocal(period.endsLocal, market.timeZone, align, start) : Infinity;
          if (from === null || to === null || from >= 1 || to <= 0) continue;
          sheets.push({
            kind: "offer", look, from: clamp(from), to: clamp(to), label: offer.title, state: offer.state, changeId: offer.id, version: offer.version, continues: to > 1,
          });
          if (look === "live" && from <= nowAt) overlapping = true;
          else if (from > nowAt && (approaching === null || from < approaching.at)) approaching = { at: from, words: `starts ${formatLocal(period.startsLocal, market.timeZone, { withYear: false })}` };
          if (look === "waiting") waiting = `${offer.title} v${offer.version} waits for a signature`;
        }
      }
      const hasOffer = sheets.some((sheet) => sheet.kind === "offer");
      if (!hasOffer && priceChange === undefined) {
        clear += 1;
        continue;
      }
      const status: Lane["status"] = overlapping
        ? { word: "Overlapping", detail: "an offer over the list price" }
        : approaching
          ? { word: waiting ? "Waiting" : "Approaching", detail: waiting ? `${approaching.words}, if it is signed in time` : approaching.words }
          : priceChange
            ? { word: "Price change", detail: `a new list price from ${formatLocal(priceChange.price.validFrom, market.timeZone, { withYear: false })}` }
            : { word: "Waiting", detail: waiting ?? "an offer waits for a signature" };
      lanes.push({ market, plan, sheets, status, now: clamp(nowAt), clockChange: clockChange(market.timeZone, changeStart, align, start) });
    }
  }
  return { days, lanes, clear };
}

/** "Italy · Student", the lane's name. */
export function laneName(lane: Lane): string {
  return `${lane.market.name} · ${lane.plan.charAt(0).toUpperCase()}${lane.plan.slice(1)}`;
}

/** The lane in one sentence, for assistive technology: what the drawing shows. */
export function laneWords(lane: Lane, money: (amount: NonNullable<Sheet["amount"]>) => string): string {
  const parts = lane.sheets.map((sheet) => {
    if (sheet.kind === "price") return `list price ${sheet.amount ? money(sheet.amount) : ""}${sheet.from > 0 ? " from later this week" : ""}`.trim();
    const state = sheet.look === "live" ? "live" : sheet.look === "approved" ? "approved" : "waiting for a signature";
    return `${sheet.label} v${sheet.version ?? 1}, ${state}`;
  });
  return `${laneName(lane)}: ${lane.status.word}, ${lane.status.detail}. ${parts.join("; ")}.`;
}

export { zoneCity };
