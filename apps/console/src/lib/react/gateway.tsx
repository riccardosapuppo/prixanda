"use client";
// The gateway client for React: queries through TanStack Query, keyed by the
// operation and its variables, and actions (mutations) that carry one
// idempotency key per action, kept until the action has an answer.
import { keepPreviousData, type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useRef } from "react";
import type { Operation } from "../../graphql/operation.ts";
import { ActionKey, runAction } from "../action-key.ts";
import type { GatewayClient } from "../gateway.ts";

const GatewayContext = createContext<GatewayClient | null>(null);

export function GatewayProvider({ client, children }: { readonly client: GatewayClient; readonly children: ReactNode }) {
  return <GatewayContext.Provider value={client}>{children}</GatewayContext.Provider>;
}

export function useGateway(): GatewayClient {
  const client = useContext(GatewayContext);
  if (client === null) throw new Error("useGateway outside GatewayProvider");
  return client;
}

export type QueryOptions = {
  readonly enabled?: boolean;
  readonly staleTime?: number;
  readonly keepPrevious?: boolean;
  readonly refetchInterval?: number | false;
};

export function queryKeyOf<TVariables>(operation: Operation<unknown, TVariables>, variables: TVariables): readonly unknown[] {
  return [operation.name, variables];
}

export function useGatewayQuery<TData, TVariables>(
  operation: Operation<TData, TVariables>,
  variables: TVariables,
  options: QueryOptions = {},
): UseQueryResult<TData, Error> {
  const gateway = useGateway();
  return useQuery<TData, Error, TData, readonly unknown[]>({
    queryKey: queryKeyOf(operation, variables),
    queryFn: ({ signal }) => gateway.run(operation, variables, { signal }),
    enabled: options.enabled ?? true,
    ...(options.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
    ...(options.refetchInterval !== undefined ? { refetchInterval: options.refetchInterval } : {}),
    // The previous page stays on screen while the next one loads (TanStack's own helper; its type is generic over any data).
    ...(options.keepPrevious ? { placeholderData: keepPreviousData as never } : {}),
  });
}

/**
 * An action that changes something: run(variables) sends the mutation with
 * this action's idempotency key (lib/action-key.ts). The key stays until an
 * answer comes back, so trying again after any failure replays the action
 * instead of repeating it; a different request gets a new key.
 */
export function useAction<TData, TVariables>(operation: Operation<TData, TVariables>, actionName: string, options: { readonly onDone?: (data: TData) => void | Promise<void> } = {}) {
  const gateway = useGateway();
  const keys = useRef<ActionKey | null>(null);
  keys.current ??= new ActionKey(actionName);
  const held = keys.current;
  return useMutation<TData, Error, TVariables>({
    mutationKey: [operation.name],
    mutationFn: (variables) => runAction(gateway, operation, variables, held),
    onSuccess: async (data) => {
      await options.onDone?.(data);
    },
  });
}

/** After a change moved: everything that shows changes reads again. */
export function useRefreshChanges() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ predicate: (query) => ["Change", "Changes", "Home", "Week", "AuditEvents"].includes(String(query.queryKey[0])) });
}
