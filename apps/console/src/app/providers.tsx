"use client";
// Everything a page of the console stands on: the query cache, the gateway
// client with its transport, the clock, the demo session, and the input
// modality (nothing animates while the person works from the keyboard). In
// the demo's sandbox (built with SANDBOX=1), the transport is the worker in
// this browser and the clock is the demo's; what the engine's jobs changed is
// read again when the worker says so, and starting over reloads every tab.
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { csrfToken } from "../lib/csrf.ts";
import { createGatewayClient, GatewayError, httpTransport } from "../lib/gateway.ts";
import { openSandbox, READ_AGAIN, runCommand, SANDBOX_BUILD, SANDBOX_MODE, sandboxTransport } from "../lib/sandbox.ts";
import { DEMO_STATUS_KEY, forgetGuide, SandboxProvider } from "../lib/react/sandbox.tsx";
import { newRequestId } from "../lib/ids.ts";
import { readRetryDelay, retryRead } from "../lib/retry.ts";
import { type Clock, ClockProvider, offsetClock, systemClock } from "../lib/react/clock.tsx";
import { GatewayProvider } from "../lib/react/gateway.tsx";
import { SessionProvider } from "../lib/react/session.tsx";
import { SESSION_KEY } from "../lib/session-switch.ts";

/** The gateway's internal endpoint, fixed when the console is built. */
export const GATEWAY_URL = process.env["NEXT_PUBLIC_GATEWAY_URL"] ?? "http://127.0.0.1:4621/graphql";

function makeQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: false,
        // A read that got no answer is tried twice more, and one turned away
        // for too many requests after the wait the gateway names; a refusal is not (lib/retry.ts).
        retry: retryRead,
        retryDelay: readRetryDelay,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        // The session ended on the gateway (an hour idle, a restart): back to the entry.
        if (error instanceof GatewayError && error.code === "UNAUTHENTICATED") {
          client.setQueryData(SESSION_KEY, { session: null });
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
  const [sandbox] = useState(() => (SANDBOX_MODE ? openSandbox(SANDBOX_BUILD) : null));
  const [gateway] = useState(() => createGatewayClient({ transport: sandbox ? sandboxTransport(sandbox) : httpTransport(GATEWAY_URL), csrfToken, newRequestId }));
  const [clock, setClock] = useState<Clock>(systemClock);

  useEffect(() => {
    if (sandbox === null) return;
    // The demo's clock: the story's time from the worker, running on with this machine's until the worker says otherwise.
    const follow = (now: string) => {
      const at = Date.parse(now);
      if (Number.isFinite(at)) setClock(offsetClock(at - Date.now()));
    };
    const fromStatus = () => {
      const status = sandbox.status();
      if (status.state === "ready") follow(status.info.now);
    };
    fromStatus();
    const stopStatus = sandbox.subscribe(fromStatus);
    const stopChanged = sandbox.onChanged((what) => {
      const names = new Set<string>(what.flatMap((kind) => READ_AGAIN[kind]));
      void queryClient.invalidateQueries({ predicate: (query) => names.has(String(query.queryKey[0])) || query.queryKey[0] === DEMO_STATUS_KEY[0] });
      // A launch the demo skipped to moved its clock.
      void runCommand(sandbox, "status").then((answer) => {
        if (answer.ok) follow(answer.result.now);
      }).catch(() => undefined);
    });
    const stopReset = sandbox.onReset(() => {
      forgetGuide();
      window.location.reload();
    });
    return () => {
      stopStatus();
      stopChanged();
      stopReset();
    };
  }, [sandbox, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <GatewayProvider client={gateway}>
        <SandboxProvider sandbox={sandbox}>
          <ClockProvider clock={clock}>
            <SessionProvider>
              <InputModality />
              {children}
            </SessionProvider>
          </ClockProvider>
        </SandboxProvider>
      </GatewayProvider>
    </QueryClientProvider>
  );
}
