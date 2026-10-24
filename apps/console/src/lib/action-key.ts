// One idempotency key per action, kept until the action has a known outcome.
//
// The engine saves the outcome of every write under its key: the same key with
// the same request gets the saved outcome back, never a second write. So the
// console keeps an action's key until an answer comes back, refusals
// included, and sends the same key when the person tries again. Any failure
// leaves the outcome unknown (the gateway may not have answered, the answer
// may have been cut or unreadable, the engine may have written before the
// gateway gave up), and the key stays: retrying a campaign's creation after
// a broken response replays it instead of creating a second campaign. A
// different request (other variables) is another action, with a new key.
import type { Operation } from "../graphql/operation.ts";
import type { GatewayClient } from "./gateway.ts";
import { newIdempotencyKey } from "./ids.ts";

/** Variables written the same way whatever the order of their keys. */
export function stableText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableText).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableText((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class ActionKey {
  readonly #action: string;
  readonly #newKey: (action: string) => string;
  #pending: { readonly key: string; readonly request: string } | null = null;

  constructor(action: string, newKey: (action: string) => string = newIdempotencyKey) {
    this.#action = action;
    this.#newKey = newKey;
  }

  /** The key for this request: the pending one when it is the same request, a new one otherwise. */
  keyFor(variables: unknown): string {
    const request = stableText(variables);
    if (this.#pending === null || this.#pending.request !== request) this.#pending = { key: this.#newKey(this.#action), request };
    return this.#pending.key;
  }

  /** An answer came back: the outcome is known, and the next action gets a new key. */
  answered(): void {
    this.#pending = null;
  }

  /** The key waiting for an outcome, if any. */
  get pending(): string | null {
    return this.#pending?.key ?? null;
  }
}

/** Runs one action: its key, the request, and the key kept unless an answer came back. */
export async function runAction<TData, TVariables>(client: GatewayClient, operation: Operation<TData, TVariables>, variables: TVariables, keys: ActionKey): Promise<TData> {
  const data = await client.run(operation, variables, { idempotencyKey: keys.keyFor(variables) });
  keys.answered();
  return data;
}
