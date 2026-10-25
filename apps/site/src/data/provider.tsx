"use client";
// The data layer of every page: one QueryClient and one SiteApi per browser
// tab, made once. A page asks through the hooks of hooks.ts and never builds a
// request of its own.
//
// The transport is HTTP to the gateway, or, in the demo's sandbox (built with
// SANDBOX=1), messages to the sandbox's worker (sandbox.ts); the tests can
// hand in a fake. The CSRF token the API sends back with every mutation is
// the one of the session the data layer last read (me.csrfToken). In the
// sandbox, what the engine's jobs changed is read again when the worker says
// so, and a reset reloads the tab: the demo starts over everywhere at once.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { SiteMeQuery } from "../graphql/generated.ts";
import { ApiError, createSiteApi, type SiteApi } from "./api.ts";
import { API_CREDENTIALS, SANDBOX_BUILD, SANDBOX_MODE, SITE_API_URL } from "./config.ts";
import { keys } from "./keys.ts";
import { openSandbox, READ_AGAIN, type Sandbox, sandboxTransport } from "./sandbox.ts";
import { httpTransport, type Transport } from "./transport.ts";

const ApiContext = createContext<SiteApi | null>(null);
const SandboxContext = createContext<Sandbox | null>(null);

/** Asked again: an unreachable API or engine, twice, never a malformed request or a refusal. */
function retry(failures: number, error: unknown): boolean {
  return error instanceof ApiError && error.transient && failures < 2;
}

export function SiteData({ children, transport, sandbox }: { readonly children: ReactNode; readonly transport?: Transport; readonly sandbox?: Sandbox }) {
  const [state] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 30_000, retry, refetchOnWindowFocus: true },
        mutations: { retry: false },
      },
    });
    const box = sandbox ?? (SANDBOX_MODE && transport === undefined ? openSandbox(SANDBOX_BUILD) : null);
    const carrier = transport ?? (box ? sandboxTransport(box) : httpTransport(SITE_API_URL, { credentials: API_CREDENTIALS }));
    const api = createSiteApi(carrier, {
      csrfToken: () => client.getQueryData<SiteMeQuery["me"]>(keys.me)?.csrfToken ?? null,
    });
    return { api, client, sandbox: box };
  });

  useEffect(() => {
    const box = state.sandbox;
    if (box === null) return;
    const stopChanged = box.onChanged((what) => {
      for (const kind of what) for (const queryKey of READ_AGAIN[kind]) void state.client.invalidateQueries({ queryKey });
    });
    const stopReset = box.onReset(() => window.location.reload());
    return () => {
      stopChanged();
      stopReset();
    };
  }, [state]);

  return (
    <QueryClientProvider client={state.client}>
      <ApiContext value={state.api}>
        <SandboxContext value={state.sandbox}>{children}</SandboxContext>
      </ApiContext>
    </QueryClientProvider>
  );
}

export function useSiteApi(): SiteApi {
  const api = useContext(ApiContext);
  if (api === null) throw new Error("useSiteApi outside <SiteData>");
  return api;
}

/** The demo's sandbox, in a sandbox build; null on the site served with a gateway. */
export function useSandbox(): Sandbox | null {
  return useContext(SandboxContext);
}
