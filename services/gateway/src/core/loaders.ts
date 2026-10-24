// The DataLoaders of one request. A list of changes asks for the details of
// every row: without a loader that is one GetChange per row after the
// ListChanges, N + 1 calls to the engine; with it, the rows asked for in the
// same tick go in one BatchGetChanges. scripts/measure-dataloader.ts counts
// both. Loaders live for one request only, so nothing one session read is
// ever served to another.
import type { Change } from "contracts/commerce/v1/changes";
import type { Person } from "contracts/commerce/v1/overview";
import DataLoader from "dataloader";
import type { Loaders } from "./context.ts";
import type { EngineCalls } from "./engine.ts";
import { contractBroken, gatewayError } from "./errors.ts";

/** The most ids one BatchGetChanges carries: the largest page of the console's lists. */
export const MAX_BATCH = 100;

export function createLoaders(reader: () => EngineCalls, anonymous: EngineCalls, batch: boolean): Loaders {
  const change = new DataLoader<string, Change>(async (ids) => {
    if (batch) {
      // Unknown ids are left out of the answer (the contract): each becomes NOT_FOUND on its own.
      const { changes } = await reader().changes.batchGetChanges({ changeIds: [...ids] });
      const byId = new Map(changes.map((found) => [found.id, found]));
      return ids.map((id) => byId.get(id) ?? gatewayError("NOT_FOUND", `There is no change ${id}.`));
    }
    // Without batching, what each resolver would do on its own.
    return Promise.all(ids.map(async (id) => {
      const { change: found } = await reader().changes.getChange({ changeId: id });
      return found ?? contractBroken("GetChange answered without a change");
    }));
  }, { batch, maxBatchSize: MAX_BATCH });

  let people: Promise<ReadonlyMap<string, Person>> | null = null;
  return {
    change,
    people: () => (people ??= anonymous.people.listPeople({}).then((answer) => new Map(answer.people.map((person) => [person.id, person])))),
  };
}
