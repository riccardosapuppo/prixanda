// From the engine's messages to the schemas' values and back. The contract's
// enums and the schemas' enums share their names (ROLE_MARKETING is MARKETING
// in both), which test/contract-enums.test.ts checks value by value; a value
// the gateway does not know is a broken contract, never a silent default.
import type { DescEnum } from "@bufbuild/protobuf";
import type { Money } from "contracts/commerce/v1/common";
import { contractBroken, gatewayError } from "./errors.ts";
import type { FactModel } from "./models.ts";
import { ROLES, type RoleName } from "./roles.ts";
import type { MoneyValue } from "./scalars.ts";

/** The schema's name of an enum value the engine sent; UNSPECIFIED and unknown numbers break the contract. */
export function enumName<N extends string>(desc: DescEnum, value: number, what: string): N {
  const found = desc.values.find((candidate) => candidate.number === value);
  if (found === undefined || found.number === 0) throw contractBroken(`${what} ${value} is not a value the gateway knows`);
  return found.localName as N;
}

/** The engine's number for an enum value the schema accepted. */
export function enumNumber(desc: DescEnum, name: string): number {
  const found = desc.values.find((candidate) => candidate.localName === name && candidate.number !== 0);
  if (found === undefined) throw gatewayError("BAD_USER_INPUT", `${name} is not a value of ${desc.name}`);
  return found.number;
}

/** A role of the schema (FINANCE) as the book and the metadata write it (finance). */
export function roleName(graphqlRole: string): RoleName {
  const role = graphqlRole.toLowerCase();
  const known = ROLES.find((candidate) => candidate === role);
  if (known === undefined) throw contractBroken(`role ${graphqlRole}`);
  return known;
}

export function graphqlRole(role: RoleName): Uppercase<RoleName> {
  return role.toUpperCase() as Uppercase<RoleName>;
}

export function money(value: Money | undefined, what: string): MoneyValue {
  if (value === undefined) throw contractBroken(`${what} has no amount`);
  return value;
}

export function optionalMoney(value: Money | undefined): MoneyValue | null {
  return value ?? null;
}

/** proto3 sends "" for an absent string. */
export function orNull(value: string): string | null {
  return value === "" ? null : value;
}

/** An int64 id of the contract: "0" or "" means none. */
export function idOrNull(value: string): string | null {
  return value === "" || value === "0" ? null : value;
}

/** A count or a share the engine sends as an int64; the schema's Int refuses anything past 32 bits on its own. */
export function count(value: bigint | number, what: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw contractBroken(`${what} ${value} is not a safe integer`);
  return number;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytes(hexDigits: string): Uint8Array {
  const out = new Uint8Array(hexDigits.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hexDigits.slice(index * 2, index * 2 + 2), 16);
  return out;
}

/** A map of the contract as a list, sorted by name so that the same facts always read the same. */
export function facts(map: { readonly [name: string]: string }): FactModel[] {
  return Object.keys(map).sort().map((name) => ({ name, value: map[name] ?? "" }));
}
