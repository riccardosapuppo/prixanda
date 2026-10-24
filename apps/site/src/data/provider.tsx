"use client";
// The data layer of every page: one QueryClient and one SiteApi per browser
// tab, made once. A page asks through the hooks of hooks.ts and never builds a
// request of its own.
//
// The transport is HTTP to the gateway unless one is handed in: the browser
// sandbox of stage 8 hands in the schema executed in the page, the tests can
// hand in a fake.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { ApiError, createSiteApi, type SiteApi } from "./api.ts";
import { API_CREDENTIALS, SITE_API_URL } from "./config.ts";
import { httpTransport, type Transport } from "./transport.ts";

const ApiContext = createContext<SiteApi | null>(null);

/** Asked again: an unreachable API or engine, twice, never a malformed request or a refusal. */
function retry(failures: number, error: unknown): boolean {
  return error instanceof ApiError && error.transient && failures < 2;
}

export function SiteData({ children, transport }: { readonly children: ReactNode; readonly transport?: Transport }) {
  const [state] = useState(() => ({
    api: createSiteApi(transport ?? httpTransport(SITE_API_URL, { credentials: API_CREDENTIALS })),
    client: new QueryClient({
      defaultOptions: {
        queries: { staleTime: 30_000, retry, refetchOnWindowFocus: true },
        mutations: { retry: false },
      },
    }),
  }));
  return (
    <QueryClientProvider client={state.client}>
      <ApiContext value={state.api}>{children}</ApiContext>
    </QueryClientProvider>
  );
}

export function useSiteApi(): SiteApi {
  const api = useContext(ApiContext);
  if (api === null) throw new Error("useSiteApi outside <SiteData>");
  return api;
}
