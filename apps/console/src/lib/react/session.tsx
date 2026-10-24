"use client";
// The demonstration entry, on the console's side. Choosing a person is not a
// login: the gateway keeps the person in an HttpOnly session cookie and takes
// their roles from the engine; the browser never sends a role. The console
// keeps only what the session query says, and the CSRF token that every
// mutation must carry while the session lasts.
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { CurrentSessionDocument, type CurrentSessionQuery, SignInDocument, SignOutDocument } from "../../graphql/generated.ts";
import { setCsrfToken } from "../csrf.ts";
import { type Role, ROLES } from "../permissions.ts";
import { queryKeyOf, useGateway, useGatewayQuery } from "./gateway.tsx";

export type Viewer = { readonly personId: string; readonly label: string; readonly roles: readonly Role[] };

export type SessionValue = {
  readonly status: "loading" | "signed-out" | "signed-in" | "error";
  readonly viewer: Viewer | null;
  readonly expiresAt: string | null;
  readonly error: Error | null;
  readonly busy: boolean;
  signIn(personId: string): Promise<void>;
  signOut(): Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

const SESSION_KEY = queryKeyOf(CurrentSessionDocument, {});
const KEEP = new Set(["CurrentSession", "People"]);

function viewerOf(session: CurrentSessionQuery["session"]): Viewer | null {
  if (session === null) return null;
  return {
    personId: session.person.id,
    label: session.person.label,
    roles: ROLES.filter((role) => session.roles.includes(role)),
  };
}

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const gateway = useGateway();
  const client = useQueryClient();
  const query = useGatewayQuery(CurrentSessionDocument, {}, { staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const session = query.data?.session ?? null;
  setCsrfToken(session?.csrfToken ?? null);

  // Everything read as the previous person is reset, not removed: the screens
  // on display keep their queries and read them again as the new person.
  const forgetOthers = useCallback(() => {
    void client.resetQueries({ predicate: (cached) => !KEEP.has(String(cached.queryKey[0])) });
  }, [client]);

  const signIn = useCallback(async (personId: string) => {
    setBusy(true);
    try {
      const data = await gateway.run(SignInDocument, { personId });
      setCsrfToken(data.signIn.csrfToken);
      client.setQueryData<CurrentSessionQuery>(SESSION_KEY, { session: data.signIn });
      forgetOthers();
    } finally {
      setBusy(false);
    }
  }, [client, forgetOthers, gateway]);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await gateway.run(SignOutDocument, {});
    } finally {
      setCsrfToken(null);
      client.setQueryData<CurrentSessionQuery>(SESSION_KEY, { session: null });
      forgetOthers();
      setBusy(false);
    }
  }, [client, forgetOthers, gateway]);

  const value = useMemo<SessionValue>(() => ({
    status: query.isPending ? "loading" : query.isError ? "error" : session === null ? "signed-out" : "signed-in",
    viewer: viewerOf(session),
    expiresAt: session?.expiresAt ?? null,
    error: query.error,
    busy,
    signIn,
    signOut,
  }), [busy, query.error, query.isError, query.isPending, session, signIn, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error("useSession outside SessionProvider");
  return value;
}

/** The signed-in viewer; only inside pages that require a session. */
export function useViewer(): Viewer {
  const { viewer } = useSession();
  if (viewer === null) throw new Error("useViewer without a session");
  return viewer;
}

/** A session test double for stories and tests: a fixed viewer, no gateway. */
export function StaticSession({ viewer, children }: { readonly viewer: Viewer | null; readonly children: ReactNode }) {
  const value = useMemo<SessionValue>(() => ({
    status: viewer === null ? "signed-out" : "signed-in",
    viewer,
    expiresAt: null,
    error: null,
    busy: false,
    signIn: async () => {},
    signOut: async () => {},
  }), [viewer]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
