// Writing money, the way the engine writes it (business book §3.4).
//
// An amount is an integer number of the currency's minor unit, carried as a
// string of digits (the gateway's Money scalar: {"amountMinor": "579",
// "currency": "EUR"}) and handled here as a bigint: no float ever touches it,
// so nothing rounds on the way to the screen.
//
// Two ways of writing, one per application:
//   - the console writes every amount one way, en-GB, exactly as the engine's
//     format_money does (services/commerce/src/commerce/domain/money.py):
//     €5.79, £9.49, −€1,877.51 with a real minus sign, ¥1,000;
//   - the site writes a price the way its market's country writes it, since
//     its text is English but prices stay local: 10,49 € in Italy and
//     Germany, 1 234,99 € in France, £9.49 in the United Kingdom.
// A test compares the console's writing with the engine's on the same amounts.

/** An amount as the gateway sends it, or as a caller already holds it. */
export type MoneyLike = { readonly amountMinor: string | bigint | number; readonly currency: string };

/** The real minus sign, U+2212, never a hyphen. */
export const MINUS = "−";
/** No-break space, between an amount and a euro sign that follows it. */
export const NBSP = " ";
/** Narrow no-break space, the French thousands separator. */
export const NNBSP = " ";

/** ISO 4217 minor units of the currencies the engine writes (the yen: a currency without decimals, §3.4). */
export const MINOR_UNITS: Readonly<Record<string, number>> = { EUR: 2, GBP: 2, JPY: 0 };
const SYMBOLS: Readonly<Record<string, string>> = { EUR: "€", GBP: "£", JPY: "¥" };

const DIGITS = /^-?\d+$/;

/** The amount as a bigint; refuses anything that is not a whole number of minor units. */
export function minorUnits(amount: MoneyLike["amountMinor"]): bigint {
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "number") {
    if (!Number.isSafeInteger(amount)) throw new TypeError(`an amount of money is a whole number of minor units, not ${amount}`);
    return BigInt(amount);
  }
  if (!DIGITS.test(amount)) throw new TypeError(`an amount of money is a string of digits, not ${JSON.stringify(amount)}`);
  return BigInt(amount);
}

function digitsOf(currency: string): number {
  const digits = MINOR_UNITS[currency];
  if (digits === undefined) throw new RangeError(`no minor units known for ${JSON.stringify(currency)}`);
  return digits;
}

function group(units: bigint, separator: string): string {
  const text = units.toString();
  const parts: string[] = [];
  for (let end = text.length; end > 0; end -= 3) parts.unshift(text.slice(Math.max(0, end - 3), end));
  return parts.join(separator);
}

function split(money: MoneyLike): { negative: boolean; units: bigint; minor: string; digits: number } {
  const digits = digitsOf(money.currency);
  const amount = minorUnits(money.amountMinor);
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const scale = 10n ** BigInt(digits);
  return { negative, units: magnitude / scale, minor: (magnitude % scale).toString().padStart(digits, "0"), digits };
}

/** The console's way, the engine's format_money: €5.79, £9.49, −€1,877.51, ¥1,000. */
export function formatMoney(money: MoneyLike): string {
  const { negative, units, minor, digits } = split(money);
  const body = group(units, ",") + (digits ? `.${minor}` : "");
  const symbol = SYMBOLS[money.currency];
  const sign = negative ? MINUS : "";
  return symbol === undefined ? `${sign}${body} ${money.currency}` : `${sign}${symbol}${body}`;
}

/** The markets the site sells in, and how each writes a price. */
export type MarketCode = "IT" | "FR" | "DE" | "GB";

const SITE_STYLE: Readonly<Record<MarketCode, { thousands: string; decimal: string; symbolFirst: boolean }>> = {
  IT: { thousands: ".", decimal: ",", symbolFirst: false },
  DE: { thousands: ".", decimal: ",", symbolFirst: false },
  FR: { thousands: NNBSP, decimal: ",", symbolFirst: false },
  GB: { thousands: ",", decimal: ".", symbolFirst: true },
};

/** The site's way: a price as its market's country writes it. 10,49 € (IT, DE), 1 234,99 € (FR), £9.49 (GB). */
export function formatSitePrice(money: MoneyLike, market: MarketCode): string {
  const style = SITE_STYLE[market];
  if (style === undefined) throw new RangeError(`no way of writing prices known for the market ${JSON.stringify(market)}`);
  const { negative, units, minor, digits } = split(money);
  const symbol = SYMBOLS[money.currency] ?? money.currency;
  const body = group(units, style.thousands) + (digits ? `${style.decimal}${minor}` : "");
  const sign = negative ? MINUS : "";
  return style.symbolFirst ? `${sign}${symbol}${body}` : `${sign}${body}${NBSP}${symbol}`;
}

/** A count the way the engine writes it: 10,000. */
export function formatCount(count: number | bigint): string {
  const value = typeof count === "bigint" ? count : BigInt(count);
  if (typeof count === "number" && !Number.isSafeInteger(count)) throw new TypeError(`a count is a whole number, not ${count}`);
  return (value < 0n ? MINUS : "") + group(value < 0n ? -value : value, ",");
}

/** A share in basis points the way the engine writes it: 2000 as 20%, 1250 as 12.5%, 25 as 0.25%. */
export function formatPercent(basisPoints: number): string {
  if (!Number.isSafeInteger(basisPoints)) throw new TypeError(`a share is a whole number of basis points, not ${basisPoints}`);
  const magnitude = Math.abs(basisPoints);
  const whole = Math.trunc(magnitude / 100);
  const rest = magnitude % 100;
  const sign = basisPoints < 0 ? MINUS : "";
  if (rest === 0) return `${sign}${whole}%`;
  return `${sign}${`${whole}.${String(rest).padStart(2, "0")}`.replace(/0+$/, "")}%`;
}

/**
 * A price typed by a person, in the currency's major unit ("2.99", "2,99",
 * "1,234.50"), as minor units; null when it is not a price of that currency.
 * The console never sends a float: the gateway receives the minor units.
 */
export function parseAmount(text: string, currency: string): bigint | null {
  const digits = digitsOf(currency);
  const cleaned = text.trim().replace(/^[€£¥]\s*/, "").replace(/\s*[€£¥]$/, "");
  const pattern = digits === 0 ? /^(\d{1,3}(?:[,.\s ]\d{3})*|\d+)$/ : /^(\d{1,3}(?:[,\s ]\d{3})*|\d+)(?:[.,](\d{1,2}))?$/;
  const match = pattern.exec(cleaned);
  if (match === null) return null;
  const units = BigInt((match[1] ?? "0").replace(/[,.\s ]/g, ""));
  const fraction = digits === 0 ? "" : (match[2] ?? "").padEnd(digits, "0");
  return units * 10n ** BigInt(digits) + (fraction ? BigInt(fraction) : 0n);
}
