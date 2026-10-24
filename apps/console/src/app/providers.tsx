"use client";
// Everything a page of the console stands on: the query cache, the gateway
// client with its transport, the clock, the demo session, and the input
// modality (nothing animates while the person works from the keyboard).
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { CurrentSessionDocument } from "../graphql/generated.ts";
import { csrfToken } from "../lib/csrf.ts";
import { createGatewayClient, GatewayError, httpTransport } from "../lib/gateway.ts";
import { newRequestId } from "../lib/ids.ts";
import { ClockProvider, systemClock } from "../lib/react/clock.tsx";
import { GatewayProvider, queryKeyOf } from "../lib/react/gateway.tsx";
import { SessionProvider } from "../lib/react/session.tsx";

/** The gateway's internal endpoint, fixed when the console is built. */
export const GATEWAY_URL = process.env["NEXT_PUBLIC_GATEWAY_URL"] ?? "http://127.0.0.1:4621/graphql";

function makeQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: false,
        // A request that got no answer is tried twice more; a refusal or a 429 is not.
        retry: (failures, error) => error instanceof GatewayError && error.transient && error.code !== "RATE_LIMITED" && failures < 2,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        // The session ended on the gateway (an hour idle, a restart): back to the entry.
        if (error instanceof GatewayError && error.code === "UNAUTHENTICATED") {
          client.setQueryData(queryKeyOf(CurrentSessionDocument, {}), { session: null });
        }
      },
    }),
  });
  return client;
}

function InputModality() {
  useEffect(() => {
    const root = document.documentElement;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Tab" || event.key.startsWith("Arrow") || event.key === "Enter" || event.key === " " || event.key === "Escape") root.dataset["input"] = "keyboard";
    };
    const pointer = () => delete root.dataset["input"];
    window.addEventListener("keydown", keyboard, true);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, []);
  return null;
}

export function Providers({ children }: { readonly children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  const [gateway] = useState(() => createGatewayClient({ transport: httpTransport(GATEWAY_URL), csrfToken, newRequestId }));
  return (
    <QueryClientProvider client={queryClient}>
      <GatewayProvider client={gateway}>
        <ClockProvider clock={systemClock}>
          <SessionProvider>
            <InputModality />
            {children}
          </SessionProvider>
        </ClockProvider>
      </GatewayProvider>
    </QueryClientProvider>
  );
}
