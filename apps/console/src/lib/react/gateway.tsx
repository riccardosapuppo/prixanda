"use client";
// The gateway client for React: queries through TanStack Query, keyed by the
// operation and its variables, and actions (mutations) that carry one
// idempotency key per action, kept until the action has an answer.
import {
  type InfiniteData, keepPreviousData, type UseInfiniteQueryResult, type UseQueryResult, useInfiniteQuery, useMutation, useQuery, useQueryClient,
} from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useRef } from "react";
import { type Operation, queryKeyOf } from "../../graphql/operation.ts";
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

export type QueryOptions<TData = unknown> = {
  readonly enabled?: boolean;
  readonly staleTime?: number;
  readonly keepPrevious?: boolean;
  /** Milliseconds between readings, or false; a function decides from the data read last (a launch is read again while it runs). */
  readonly refetchInterval?: number | false | ((data: TData | undefined) => number | false);
};

export function useGatewayQuery<TData, TVariables>(
  operation: Operation<TData, TVariables>,
  variables: TVariables,
  options: QueryOptions<TData> = {},
): UseQueryResult<TData, Error> {
  const gateway = useGateway();
  return useQuery<TData, Error, TData, readonly unknown[]>({
    queryKey: queryKeyOf(operation, variables),
    queryFn: ({ signal }) => gateway.run(operation, variables, { signal }),
    enabled: options.enabled ?? true,
    ...(options.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
    ...(options.refetchInterval !== undefined ? { refetchInterval: typeof options.refetchInterval === "function" ? (query: { state: { data: TData | undefined } }) => (options.refetchInterval as (data: TData | undefined) => number | false)(query.state.data) : options.refetchInterval } : {}),
    // The previous page stays on screen while the next one loads (TanStack's own helper; its type is generic over any data).
    ...(options.keepPrevious ? { placeholderData: keepPreviousData as never } : {}),
  });
}

/**
 * A list read a page at a time with the engine's keyset cursors: the first
 * page, then each next one on demand (fetchNextPage), kept together under the
 * operation's name so that what invalidates the operation invalidates its
 * pages too. hasNextPage says whether the engine has more.
 */
export function useGatewayPages<TData, TVariables>(
  operation: Operation<TData, TVariables>,
  variablesFor: (after: string | null) => TVariables,
  nextOf: (page: TData) => string | null,
  options: { readonly enabled?: boolean } = {},
): UseInfiniteQueryResult<InfiniteData<TData, string | null>, Error> {
  const gateway = useGateway();
  return useInfiniteQuery<TData, Error, InfiniteData<TData, string | null>, readonly unknown[], string | null>({
    queryKey: [operation.name, "pages", variablesFor(null)],
    queryFn: ({ pageParam, signal }) => gateway.run(operation, variablesFor(pageParam), { signal }),
    initialPageParam: null,
    getNextPageParam: (last) => nextOf(last) ?? undefined,
    enabled: options.enabled ?? true,
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
