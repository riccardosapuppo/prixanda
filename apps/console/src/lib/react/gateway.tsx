"use client";
// The gateway client for React: queries through TanStack Query, keyed by the
// operation and its variables, and actions (mutations) that carry one
// idempotency key per action, kept until the action has an answer.
import {
  type InfiniteData, keepPreviousData, type UseInfiniteQueryResult, type UseQueryResult, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient,
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
  /** Read again when the tab comes back to the front (a page that watches the platform, lib/react/watch.tsx). */
  readonly refetchOnWindowFocus?: boolean;
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
    ...(options.refetchOnWindowFocus !== undefined ? { refetchOnWindowFocus: options.refetchOnWindowFocus } : {}),
    // The previous page stays on screen while the next one loads (TanStack's own helper; its type is generic over any data).
    ...(options.keepPrevious ? { placeholderData: keepPreviousData as never } : {}),
  });
}

/**
 * The same operation for several sets of variables at once (the plans of
 * every market a campaign is for), each read and kept as useGatewayQuery
 * keeps it, under the same key: one request per set, shared with the
 * components that ask for the same.
 */
export function useGatewayQueries<TData, TVariables>(
  operation: Operation<TData, TVariables>,
  variablesList: readonly TVariables[],
  options: { readonly staleTime?: number } = {},
): UseQueryResult<TData, Error>[] {
  const gateway = useGateway();
  return useQueries({
    queries: variablesList.map((variables) => ({
      queryKey: queryKeyOf(operation, variables),
      queryFn: ({ signal }: { readonly signal: AbortSignal }) => gateway.run(operation, variables, { signal }),
      ...(options.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
    })),
  });
}

/** The pages of a list, as they were read last. */
export type Pages<TData> = InfiniteData<TData, string | null>;

export type PagesOptions<TData> = {
  readonly enabled?: boolean;
  /** Milliseconds between readings of the pages, or false; a function decides from the pages read last (a list with a launch that runs). */
  readonly refetchInterval?: number | false | ((data: Pages<TData> | undefined) => number | false);
  /** Read again when the tab comes back to the front (a page that watches the platform, lib/react/watch.tsx). */
  readonly refetchOnWindowFocus?: boolean;
};

/**
 * A list read a page at a time with the engine's keyset cursors: the first
 * page, then each next one on demand (fetchNextPage), kept together under the
 * operation's name so that what invalidates the operation invalidates its
 * pages too. hasNextPage says whether the engine has more.
 *
 * Read again (at a page's pace, or when what it shows moved), the pages are
 * read in order from the first, each with the cursor the page before it
 * gives now: when a row comes in at the top, every page's edge moves with
 * it, and the row at an old edge stays on the list. One query per cursor
 * would keep the old edges, and that row would fall between two pages.
 */
export function useGatewayPages<TData, TVariables>(
  operation: Operation<TData, TVariables>,
  variablesFor: (after: string | null) => TVariables,
  nextOf: (page: TData) => string | null,
  options: PagesOptions<TData> = {},
): UseInfiniteQueryResult<Pages<TData>, Error> {
  const gateway = useGateway();
  const every = options.refetchInterval;
  return useInfiniteQuery<TData, Error, Pages<TData>, readonly unknown[], string | null>({
    queryKey: [operation.name, "pages", variablesFor(null)],
    queryFn: ({ pageParam, signal }) => gateway.run(operation, variablesFor(pageParam), { signal }),
    initialPageParam: null,
    getNextPageParam: (last) => nextOf(last) ?? undefined,
    enabled: options.enabled ?? true,
    // A list that watches reads its pages again together (lib/react/watch.tsx).
    ...(every !== undefined ? { refetchInterval: typeof every === "function" ? (query: { state: { data: Pages<TData> | undefined } }) => every(query.state.data) : every } : {}),
    ...(options.refetchOnWindowFocus !== undefined ? { refetchOnWindowFocus: options.refetchOnWindowFocus } : {}),
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
