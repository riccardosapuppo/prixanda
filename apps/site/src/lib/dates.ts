// Writing the dates and times the API gives, the way the site writes them.
// No date is computed here: a local wall-clock time of a market
// (2026-11-30T00:00) or an instant (2026-10-26T08:00:00Z) comes from the API,
// and this only puts it into words. The site's text is English, so dates read
// "29 November 2026" in every market.

const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
] as const;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

type Parts = { year: number; month: number; day: number; hour: number; minute: number };

function parts(local: string): Parts {
  const match = LOCAL.exec(local);
  if (!match) throw new RangeError(`not a local date or time: ${JSON.stringify(local)}`);
  const [, year = "", month = "", day = "", hour = "0", minute = "0"] = match;
  return { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) };
}

function words({ year, month, day }: Pick<Parts, "year" | "month" | "day">, withYear = true): string {
  const name = MONTHS[month - 1];
  if (name === undefined) throw new RangeError(`no month ${month}`);
  return withYear ? `${day} ${name} ${year}` : `${day} ${name}`;
}

/** A day of a market's calendar, or the day of a local time: "26 October 2026". */
export function siteDay(local: string): string {
  return words(parts(local));
}

/**
 * The last day something can be done, when it can be done until `endLocal`
 * excluded: an offer that can be taken until 2026-11-30T00:00 can be taken
 * on 29 November, not on the 30th; until 2026-11-30T12:00, on the 30th.
 */
export function lastDayBefore(endLocal: string, { withYear = true }: { readonly withYear?: boolean } = {}): string {
  const { year, month, day, hour, minute } = parts(endLocal);
  if (hour !== 0 || minute !== 0) return words({ year, month, day }, withYear);
  const previous = new Date(Date.UTC(year, month - 1, day) - 86_400_000);
  return words({ year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1, day: previous.getUTCDate() }, withYear);
}

/** An instant as the wall-clock time of a market: "10:47". */
export function siteTime(utc: string, timeZone: string): string {
  const instant = new Date(utc);
  if (Number.isNaN(instant.getTime())) throw new RangeError(`not an instant: ${JSON.stringify(utc)}`);
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
}
