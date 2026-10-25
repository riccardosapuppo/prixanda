// What the stories stand on: a gateway that answers from fixtures and records
// what it was asked, a fixed clock, a demo person, and a query cache of
// their own. The components are the console's own; only the transport is
// replaced, as stage 8 will replace it with the schema running in the page.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { type ReactNode, useState } from "react";
import type { Operation } from "../graphql/operation.ts";
import type { GatewayClient } from "../lib/gateway.ts";
import type { Role } from "../lib/permissions.ts";
import { ClockProvider } from "../lib/react/clock.tsx";
import { GatewayProvider } from "../lib/react/gateway.tsx";
import { StaticSession, type Viewer } from "../lib/react/session.tsx";

/** Saturday 24 October 2026, 10:42 in Rome: the business book's day. */
export const STORY_NOW = new Date("2026-10-24T08:42:00Z");

export type Call = { readonly operation: string; readonly variables: unknown; readonly idempotencyKey: string | undefined };
type Handler = (variables: any, calls: readonly Call[]) => unknown;

/** A gateway client answering each operation from a handler, and keeping every call for the play functions to read. */
export function fakeGateway(handlers: Readonly<Record<string, Handler>>): GatewayClient & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run<TData, TVariables>(operation: Operation<TData, TVariables>, variables: TVariables, options: { readonly idempotencyKey?: string } = {}): Promise<TData> {
      calls.push({ operation: operation.name, variables, idempotencyKey: options.idempotencyKey });
      const handler = handlers[operation.name];
      if (handler === undefined) throw new Error(`the story's gateway has no answer for ${operation.name}`);
      return handler(variables, calls) as TData;
    },
  };
}

export const PEOPLE: Readonly<Record<string, Viewer>> = {
  marketing: { personId: "marketing-1", label: "Marketing", roles: ["MARKETING"] },
  marketingSecond: { personId: "marketing-2", label: "Marketing, second", roles: ["MARKETING"] },
  lead: { personId: "commercial-lead-1", label: "Commercial lead", roles: ["COMMERCIAL_LEAD"] },
  finance: { personId: "finance-1", label: "Finance", roles: ["FINANCE"] },
  catalog: { personId: "catalog-manager-1", label: "Catalog manager", roles: ["CATALOG_MANAGER"] },
  onCall: { personId: "on-call-1", label: "On-call engineer", roles: ["ON_CALL"] },
  auditor: { personId: "auditor-1", label: "Auditor", roles: ["AUDITOR"] },
};

export const viewerFor = (role: Role): Viewer => Object.values(PEOPLE).find((viewer) => viewer.roles.includes(role)) ?? PEOPLE["marketing"]!;

/** The console's providers around a story, with the fake gateway and one person of the demo. */
export function StoryProviders({ gateway, viewer, children }: { readonly gateway: GatewayClient; readonly viewer: Viewer; readonly children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } } });
  return (
    <QueryClientProvider client={client}>
      <GatewayProvider client={gateway}>
        <ClockProvider clock={{ now: () => STORY_NOW }}>
          <StaticSession viewer={viewer}>
            <main id="main" className="min-h-screen bg-stone">{children}</main>
          </StaticSession>
        </ClockProvider>
      </GatewayProvider>
    </QueryClientProvider>
  );
}

/**
 * A router that follows push and replace inside the story: the address's
 * query moves, and with it the step a guided form shows. The preview's own
 * router only records its calls (.storybook/preview.tsx).
 */
export function SteppingRouter({ children }: { readonly children: ReactNode }) {
  const [search, setSearch] = useState(() => new URLSearchParams());
  const [router] = useState<AppRouterInstance>(() => {
    const go = (href: string) => setSearch(new URLSearchParams(href.split("?")[1] ?? ""));
    return { back: () => undefined, forward: () => undefined, refresh: () => undefined, push: go, replace: go, prefetch: () => undefined, bfcacheId: "story" };
  });
  return (
    <AppRouterContext.Provider value={router}>
      <SearchParamsContext.Provider value={search}>{children}</SearchParamsContext.Provider>
    </AppRouterContext.Provider>
  );
}
