"use client";
// Launches (business book §7.5, §14.6): every activation the engine ran,
// newest first, with where it stands and what stopped it; each run leads to
// its timeline, step by step. Below, what starts in the next seven days, and
// what is scheduled or live.
import { Icon } from "design/icon";
import Link from "next/link";
import { useId, useState } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Button, Chip, Empty, ErrorPanel, Loading, StateChip } from "../../components/ui.tsx";
import { ChangesDocument, LaunchesDocument, LaunchRunsDocument, type LaunchState, MarketsDocument } from "../../graphql/generated.ts";
import { approvalHref } from "../../lib/kinds.ts";
import { launchHref, launchLook, type LaunchSummary, launchWords, STEP_NAME } from "../../lib/launch.ts";
import { type MarketInfo, marketName, marketZone } from "../../lib/markets.ts";
import { whoDoes } from "../../lib/permissions.ts";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";
import { formatInstantIn, formatLocalWithUtc } from "../../lib/time.ts";

type Markets = readonly MarketInfo[];

const FILTERS: readonly { readonly id: string; readonly label: string; readonly state: LaunchState | null }[] = [
  { id: "all", label: "All", state: null },
  { id: "running", label: "Running", state: "RUNNING" },
  { id: "failed", label: "Failed", state: "FAILED" },
  { id: "refused", label: "Refused", state: "REFUSED" },
  { id: "done", label: "Published", state: "DONE" },
  { id: "cancelled", label: "Cancelled", state: "CANCELLED" },
];

const PAGE = 20;

/** A launch's state, as a chip: a word, an icon and an edge. */
export function LaunchChip({ launch }: { readonly launch: Pick<LaunchSummary, "state" | "retryAt"> }) {
  const look = launchLook(launch);
  return <Chip look={look.look} icon={look.icon}>{look.word}</Chip>;
}

function RunsTable({ rows, markets, labelledBy }: { readonly rows: readonly LaunchSummary[]; readonly markets: Markets; readonly labelledBy: string }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={labelledBy}>
      <table className="data min-w-[56rem]">
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col" className="wrap">Change</th>
            <th scope="col" className="wrap">State</th>
            <th scope="col" className="wrap">Starts</th>
            <th scope="col" className="wrap">Where it stands</th>
            <th scope="col">Attempts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const zone = marketZone(markets, row.starts.market);
            return (
              <tr key={row.id}>
                <th scope="row"><Link href={launchHref(row.id)} className="font-bold">{row.run}</Link></th>
                <td className="wrap">
                  <Link href={approvalHref(row.kind, row.change.id)}>{row.title}</Link> <span className="text-ink-2">v{row.version}</span>
                </td>
                <td className="wrap"><LaunchChip launch={row} /></td>
                <td className="wrap">{marketName(markets, row.starts.market)}: {formatLocalWithUtc(row.starts.local, zone)}</td>
                <td className="wrap">
                  {row.state === "DONE" && row.finishedAt ? `All five steps, done ${formatInstantIn(row.finishedAt, zone, { seconds: true })}`
                    : row.currentStep ? `${STEP_NAME[row.currentStep] ?? row.currentStep}${row.retryAt ? `, tried again at ${formatInstantIn(row.retryAt, zone, { seconds: true })}` : ""}`
                      : row.startedAt ? "" : `Due ${formatInstantIn(row.dueAt, zone)}`}
                  {row.cause && row.state !== "DONE" ? <span className="block text-sm text-ink-2 [overflow-wrap:anywhere]">{launchWords(row.cause, zone)}</span> : null}
                </td>
                <td>{row.attempts}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RunsPage({ state, after, labelledBy, last, onMore }: {
  readonly state: LaunchState | null;
  readonly after: string | null;
  readonly labelledBy: string;
  readonly last: boolean;
  readonly onMore: (next: string) => void;
}) {
  const page = useGatewayQuery(LaunchRunsDocument, { filter: state ? { state } : null, first: PAGE, after });
  if (page.isPending) return <Loading what="the launches" lines={5} />;
  if (page.isError) return <ErrorPanel error={page.error} retry={() => void page.refetch()} />;
  const rows = page.data.launches.nodes;
  if (rows.length === 0 && after === null) {
    return (
      <Empty icon="rocket-launch">
        No launch here yet. The engine begins one a minute before a scheduled change starts, and runs it step by step.
      </Empty>
    );
  }
  return (
    <>
      <RunsTable rows={rows} markets={page.data.markets} labelledBy={labelledBy} />
      {last && page.data.launches.next ? (
        <Button size="small" icon="arrow-down" onClick={() => onMore(page.data.launches.next ?? "")} className="justify-self-start">
          Show {PAGE} more
        </Button>
      ) : null}
    </>
  );
}

export function LaunchesScreen() {
  const [filter, setFilter] = useState("all");
  const [pages, setPages] = useState<readonly (string | null)[]>([null]);
  const chosen = FILTERS.find((entry) => entry.id === filter) ?? FILTERS[0];
  const scheduled = useGatewayQuery(ChangesDocument, { filter: { states: ["SCHEDULED", "ACTIVE"] }, first: 50, after: null });
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const upcoming = useGatewayQuery(LaunchesDocument, {});
  const runsId = useId();
  const headingId = useId();
  const weekId = useId();
  return (
    <>
      <PageHead title="Launches" sub="Every activation the engine ran, step by step, and what starts next. Until a launch publishes, the catalog of before stays live." />
      <PageBody>
        <section className="grid gap-3" aria-labelledby={runsId}>
          <div className="zone-head">
            <h2 id={runsId}>Runs, newest first</h2>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
              {FILTERS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={filter === entry.id}
                  onClick={() => {
                    setFilter(entry.id);
                    setPages([null]);
                  }}
                  className={`min-h-9 rounded-control border px-3 text-sm font-semibold ${filter === entry.id ? "border-ink bg-ink text-stone-0" : "border-edge bg-stone-0 hover:bg-stone-2"}`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          {pages.map((after, index) => (
            <RunsPage key={`${filter}-${after ?? "first"}`} state={chosen?.state ?? null} after={after} labelledBy={runsId} last={index === pages.length - 1} onMore={(next) => setPages((current) => [...current, next])} />
          ))}
          <p className="flex max-w-[72ch] items-baseline gap-2 text-sm text-ink-2">
            <Icon name="info" size={15} className="translate-y-0.5" />
            <span>
              Each step runs in a transaction of its own; a step that fails is tried again after 5, 15, 45 and 135 seconds, and after five failures the
              launch fails and opens an incident (§7.5). {whoDoes("retryLaunch", { one: "tries again or gives up a launch that stopped", many: "try again or give up a launch that stopped" })}.
            </span>
          </p>
        </section>
        <section className="grid gap-3" aria-labelledby={weekId}>
          <div className="zone-head"><h2 id={weekId}>Starting in the next 7 days</h2></div>
          {upcoming.isPending ? <Loading what="the next seven days" /> : upcoming.isError ? <ErrorPanel error={upcoming.error} retry={() => void upcoming.refetch()} /> : upcoming.data.overview.launchesNext7Days.length === 0 ? (
            <Empty icon="calendar-blank">Nothing has a start date in the next seven days.</Empty>
          ) : (
            <ul role="list" className="grid">
              {upcoming.data.overview.launchesNext7Days.map((launch) => (
                <li key={`${launch.change.id}-${launch.starts.market}`} className="grid gap-1.5 border-b border-cord py-3">
                  <span className="flex flex-wrap items-center justify-between gap-3">
                    <Link href={approvalHref(launch.change.kind, launch.change.id)} className="font-bold">{launch.title} v{launch.change.currentVersion}</Link>
                    <StateChip state={launch.state} />
                  </span>
                  <span className="text-sm text-ink-2">{marketName(upcoming.data.markets, launch.starts.market)}: {formatLocalWithUtc(launch.starts.local, marketZone(upcoming.data.markets, launch.starts.market))}</span>
                  {launch.atRisk && launch.risk ? <span className="flex items-baseline gap-2 text-sm"><Icon name="warning" size={15} className="translate-y-0.5" />{launch.risk}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="grid gap-3" aria-labelledby={headingId}>
          <div className="zone-head"><h2 id={headingId}>Scheduled and live</h2></div>
          {scheduled.isPending ? <Loading what="the scheduled changes" /> : scheduled.isError ? <ErrorPanel error={scheduled.error} retry={() => void scheduled.refetch()} /> : scheduled.data.changes.nodes.length === 0 ? (
            <Empty icon="rocket-launch">Nothing is scheduled or live. An approved offer appears here once {whoDoes("scheduleOffer", { one: "schedules it", many: "schedule it" }, { start: false, either: true })}.</Empty>
          ) : (
            <ul role="list" className="grid">
              {scheduled.data.changes.nodes.map((change) => (
                <li key={change.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-cord py-3">
                  <span className="grid gap-1">
                    <Link href={approvalHref(change.kind, change.id)} className="font-bold">{change.title} v{change.currentVersion}</Link>
                    <span className="text-xs text-ink-2">{change.markets.map((code) => marketName(markets.data?.markets ?? [], code)).join(", ")} · last change {formatInstantIn(change.updatedAt, CONSOLE_ZONE)}</span>
                  </span>
                  <StateChip state={change.state} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageBody>
    </>
  );
}
