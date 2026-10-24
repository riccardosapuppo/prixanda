"use client";
// Launches: what is scheduled to start and what is live, from the engine's
// own lists. The run of each activation step by step, and the incidents with
// their recovery, belong to the activation jobs of the safe launch (business
// book §14.6); until the engine has them, this page says so instead of
// showing a timeline it cannot back.
import { Icon } from "design/icon";
import Link from "next/link";
import { useId } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Empty, ErrorPanel, Loading, StateChip } from "../../components/ui.tsx";
import { ChangesDocument, MarketsDocument } from "../../graphql/generated.ts";
import { marketName } from "../../lib/markets.ts";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";
import { formatInstantIn } from "../../lib/time.ts";

export function LaunchesScreen() {
  const scheduled = useGatewayQuery(ChangesDocument, { filter: { states: ["SCHEDULED", "ACTIVE"] }, first: 50, after: null });
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const headingId = useId();
  return (
    <>
      <PageHead title="Launches" sub="What is scheduled to start, and what is live on the site." />
      <PageBody>
        <section className="grid gap-3" aria-labelledby={headingId}>
          <div className="zone-head"><h2 id={headingId}>Scheduled and live</h2></div>
          {scheduled.isPending ? <Loading what="the launches" /> : scheduled.isError ? <ErrorPanel error={scheduled.error} retry={() => void scheduled.refetch()} /> : scheduled.data.changes.nodes.length === 0 ? (
            <Empty icon="rocket-launch">Nothing is scheduled or live. An approved offer appears here once Marketing or the commercial lead schedules it.</Empty>
          ) : (
            <ul role="list" className="grid">
              {scheduled.data.changes.nodes.map((change) => (
                <li key={change.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-cord py-3">
                  <span className="grid gap-1">
                    <Link href={`/campaigns/approval/?id=${change.id}`} className="font-bold">{change.title} v{change.currentVersion}</Link>
                    <span className="text-xs text-ink-2">{change.markets.map((code) => marketName(markets.data?.markets ?? [], code)).join(", ")} · last change {formatInstantIn(change.updatedAt, CONSOLE_ZONE)}</span>
                  </span>
                  <StateChip state={change.state} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="grid gap-3 border-t-2 border-ink pt-3" aria-labelledby="runs">
          <h2 id="runs" className="text-xl font-bold">Runs, step by step</h2>
          <p className="flex max-w-[70ch] items-baseline gap-2">
            <Icon name="info" size={16} className="translate-y-0.5 text-indigo" />
            <span>
              Today the engine activates a scheduled change in one transaction at its start: the offer, its prices and the new catalog appear
              together or not at all (§7.5). The timeline of each run, with the steps, a fault and its recovery, comes with the activation jobs of
              the safe launch (§14.6), and the home's incidents with it.
            </span>
          </p>
        </section>
      </PageBody>
    </>
  );
}
