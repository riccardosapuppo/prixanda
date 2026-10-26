"use client";
// The demonstration entry (business book §12.1, §15): the demo's people,
// named by role, as the engine lists them. Choosing one is not a login and
// the page says so; what each role may do is enforced by the server.
import { BRAND, DISCLAIMER } from "design";
import { Icon } from "design/icon";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { SandboxFoot, SandboxStart } from "../../components/sandbox.tsx";
import { Button, ErrorPanel, Loading } from "../../components/ui.tsx";
import { PeopleDocument } from "../../graphql/generated.ts";
import { inTeamOrder, primaryRole, TEAM } from "../../lib/permissions.ts";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";
import { useSession } from "../../lib/react/session.tsx";
import { safeNext } from "../../lib/safe-next.ts";

export function Entry() {
  const session = useSession();
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const people = useGatewayQuery(PeopleDocument, {}, { staleTime: 5 * 60_000 });
  const [choosing, setChoosing] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    if (session.status === "signed-in" && choosing === null) router.replace(next);
  }, [choosing, next, router, session.status]);

  const enter = async (personId: string) => {
    setChoosing(personId);
    setFailure(null);
    try {
      await session.signIn(personId);
      router.replace(next);
    } catch (error) {
      setFailure(error);
      setChoosing(null);
    }
  };

  return (
    <main id="main" className="flex min-h-screen flex-col bg-stone">
      <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-10 md:px-6 md:py-16">
        <header className="grid gap-3">
          <p className="grid gap-0.5">
            <span className="font-archivo text-5xl font-bold leading-tight tracking-[-0.015em] text-ink [font-stretch:125%]">{BRAND.platform}</span>
            <span className="text-sm text-ink-2">The console of {BRAND.service}</span>
          </p>
          <h1 className="page-title mt-4">Choose who you are in the demo</h1>
          <p className="max-w-[65ch] text-base">
            This is a demonstration entry, not a login: anyone can be anyone on this list. What each person may do is real, though:
            the gateway, the engine and the database check every action against the role.
          </p>
        </header>
        <SandboxStart />
        {failure ? <ErrorPanel error={failure} /> : null}
        {people.isPending ? <Loading what="the demo's people" lines={6} /> : people.isError ? (
          <ErrorPanel error={people.error} retry={() => void people.refetch()} />
        ) : (
          <ul role="list" className="grid border-t-2 border-ink">
            {inTeamOrder(people.data.people).map((person) => {
              const role = primaryRole(person.roles);
              return (
                <li key={person.id} className="grid gap-3 border-b border-cord py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <div className="grid gap-1">
                    <p className="text-lg font-bold">{person.label}</p>
                    {role ? (
                      <p className="text-sm text-ink-2">
                        <b className="font-semibold text-ink">Can</b> {TEAM.roles[role].can}. <b className="font-semibold text-ink">Cannot</b> {TEAM.roles[role].cannot}.
                      </p>
                    ) : null}
                  </div>
                  <Button
                    weight="default"
                    iconAfter="arrow-right"
                    busy={choosing === person.id}
                    disabled={choosing !== null && choosing !== person.id}
                    onClick={() => void enter(person.id)}
                  >
                    Enter as {person.label}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="flex items-baseline gap-2 text-sm text-ink-2">
          <Icon name="info" size={15} className="translate-y-0.5" />
          {DISCLAIMER}
        </p>
      </div>
      <SandboxFoot />
    </main>
  );
}
