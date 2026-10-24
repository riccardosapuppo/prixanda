// The custom scalars of the two schemas, validated both ways: what a client
// sends is refused when malformed, and what the engine answers is checked
// before it leaves, so a scalar never carries a value its description denies.
import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from "graphql";

/** Money inside the gateway: the engine's integer of minor units, and its currency (§3.4). */
export type MoneyValue = { readonly amountMinor: bigint; readonly currency: string };
/** ISO 8601 wall-clock time without an offset: 2026-10-26T09:00 or 2026-10-26T09:00:00. */
export type LocalDateTimeValue = string;
/** ISO 8601 instant in UTC, ending in Z. */
export type DateTimeValue = string;
export type MarketCodeValue = string;
export type PlanCodeValue = string;
/** 64 lower-case hexadecimal digits. */
export type Sha256Value = string;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const CURRENCY = /^[A-Z]{3}$/;
const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
export const MARKET_CODE = /^[A-Z]{2}$/;
export const PLAN_CODE = /^[a-z][a-z0-9-]{0,30}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const refuse = (message: string): never => {
  throw new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
};

/** An integer of minor units from a string of digits, or a JavaScript number that is a safe integer; never a fraction. */
function minorUnits(value: unknown): bigint {
  if (typeof value === "string" && INTEGER.test(value)) {
    const amount = BigInt(value);
    if (amount >= INT64_MIN && amount <= INT64_MAX) return amount;
    return refuse("Money: amountMinor is outside the 64-bit range");
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return refuse("Money: amountMinor must be an integer number of minor units, written as a string of digits (\"579\" for 5.79)");
}

function moneyFromObject(value: unknown): MoneyValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse("Money must be an object: {\"amountMinor\": \"579\", \"currency\": \"EUR\"}");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "amountMinor" && key !== "currency");
  if (unknown.length) refuse(`Money takes amountMinor and currency only, not ${unknown.join(", ")}`);
  const currency = record["currency"];
  if (typeof currency !== "string" || !CURRENCY.test(currency)) refuse("Money: currency must be an ISO 4217 code such as EUR or GBP");
  return { amountMinor: minorUnits(record["amountMinor"]), currency: currency as string };
}

export const MoneyScalar = new GraphQLScalarType<MoneyValue, { amountMinor: string; currency: string }>({
  name: "Money",
  serialize(value) {
    const money = value as { amountMinor?: unknown; currency?: unknown } | null;
    if (typeof money?.amountMinor !== "bigint" || typeof money.currency !== "string" || !CURRENCY.test(money.currency)
      || money.amountMinor < INT64_MIN || money.amountMinor > INT64_MAX) {
      throw new GraphQLError("Money: the engine answered an amount that is not an integer with a currency");
    }
    return { amountMinor: money.amountMinor.toString(), currency: money.currency };
  },
  parseValue: moneyFromObject,
  parseLiteral(ast, variables) {
    if (ast.kind !== Kind.OBJECT) return refuse("Money must be an object: {amountMinor: \"579\", currency: \"EUR\"}");
    const fields: Record<string, unknown> = {};
    for (const field of ast.fields) fields[field.name.value] = literal(field.value, variables);
    return moneyFromObject(fields);
  },
});

// An integer literal keeps its digits: 9007199254740993 must not become a float on the way.
function literal(node: ValueNode, variables: Readonly<Record<string, unknown>> | null | undefined): unknown {
  switch (node.kind) {
    case Kind.STRING:
      return node.value;
    case Kind.INT:
      return node.value;
    case Kind.VARIABLE:
      return variables?.[node.name.value];
    default:
      return refuse(`Money: ${node.kind} is not allowed here`);
  }
}

function daysIn(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** Whether the numbers name a real date and time of day. */
function onTheCalendar(parts: readonly (string | undefined)[]): boolean {
  const [year, month, day, hour, minute, second] = parts.map((part) => Number(part ?? "0"));
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) return false;
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month)
    && hour <= 23 && minute <= 59 && second <= 59;
}

function stringScalar(name: string, test: (value: string) => boolean, rule: string, normalize = (value: string) => value) {
  const check = (value: unknown, from: "client" | "engine"): string => {
    if (typeof value === "string" && test(value)) return normalize(value);
    if (from === "engine") throw new GraphQLError(`${name}: the engine answered a value that is not ${rule}`);
    return refuse(`${name} must be ${rule}`);
  };
  return new GraphQLScalarType<string, string>({
    name,
    serialize: (value) => check(value, "engine"),
    parseValue: (value) => check(value, "client"),
    parseLiteral: (ast) => (ast.kind === Kind.STRING ? check(ast.value, "client") : refuse(`${name} must be a string: ${rule}`)),
  });
}

export const LocalDateTimeScalar = stringScalar("LocalDateTime", (value) => {
  const match = LOCAL.exec(value);
  return match !== null && onTheCalendar(match.slice(1));
}, "a local date and time such as 2026-10-26T09:00, without an offset");

export const DateTimeScalar = stringScalar("DateTime", (value) => {
  const match = INSTANT.exec(value);
  return match !== null && onTheCalendar(match.slice(1));
}, "an instant in UTC such as 2026-10-24T07:00:00Z");

export const MarketCodeScalar = stringScalar("MarketCode", (value) => MARKET_CODE.test(value), "two capital letters (ISO 3166-1 alpha-2), such as IT");

export const PlanCodeScalar = stringScalar("PlanCode", (value) => PLAN_CODE.test(value),
  "a plan code: lower-case letters, digits and dashes, starting with a letter");

// Clients may write the digest in capitals; the gateway keeps it in lower case.
export const Sha256Scalar = stringScalar("Sha256", (value) => SHA256.test(value.toLowerCase()),
  "a SHA-256 digest of 64 hexadecimal digits", (value) => value.toLowerCase());

export const PUBLIC_SCALARS = [MoneyScalar, LocalDateTimeScalar, DateTimeScalar, MarketCodeScalar, PlanCodeScalar] as const;
export const INTERNAL_SCALARS = [...PUBLIC_SCALARS, Sha256Scalar] as const;
