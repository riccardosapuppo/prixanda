"use client";
// Lists of changes: the campaigns (every offer, newest first, a page at a
// time) and the approvals (what waits for a signature, and what is approved
// but not live yet). Each row leads to the change's own page.
import { formatCount } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Button, ButtonLink, Chip, Empty, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import { ChangesDocument, type ChangesQuery, type ChangeState, MarketsDocument } from "../../graphql/generated.ts";
import { marketName } from "../../lib/markets.ts";
import { approvesWithoutScheduling, asRole, can, primaryRole, waitingFor, whoDoes } from "../../lib/permissions.ts";
import { useGatewayPages, useGatewayQuery } from "../../lib/react/gateway.tsx";
import { useViewer } from "../../lib/react/session.tsx";
import { formatInstantIn } from "../../lib/time.ts";

type Row = ChangesQuery["changes"]["nodes"][number];

const FILTERS: readonly { readonly id: string; readonly label: string; readonly states: readonly ChangeState[] | null }[] = [
  { id: "all", label: "All", states: null },
  { id: "drafts", label: "Drafts", states: ["DRAFT", "VALIDATED"] },
  { id: "approval", label: "In approval", states: ["IN_APPROVAL"] },
  { id: "approved", label: "Approved and scheduled", states: ["APPROVED", "SCHEDULED"] },
  { id: "live", label: "Live", states: ["ACTIVE"] },
  { id: "closed", label: "Ended, suspended, cancelled", states: ["ENDED", "SUSPENDED", "CANCELLED"] },
];

/** Where a row leads: a draft to its editor, anything else to its approval page. */
export function changeHref(row: { readonly id: string; readonly state: string }): string {
  return row.state === "DRAFT" || row.state === "VALIDATED" ? `/campaigns/edit/?id=${row.id}` : `/campaigns/approval/?id=${row.id}`;
}

function waitingWords(row: Row): string | null {
  if (row.state !== "IN_APPROVAL" || row.requiredSignatures.every((signature) => signature.signed)) return null;
  return waitingFor(row.requiredSignatures);
}

function ChangesTable({ rows, labelledBy }: { readonly rows: readonly Row[]; readonly labelledBy: string }) {
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const names = markets.data?.markets ?? [];
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={labelledBy}>
      <table className="data min-w-[52rem]">
        <thead>
          <tr>
            <th scope="col">Campaign</th>
            <th scope="col" className="wrap">State</th>
            <th scope="col" className="wrap">Markets</th>
            <th scope="col" className="wrap">Created by</th>
            <th scope="col">Last change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const waiting = waitingWords(row);
            return (
              <tr key={row.id}>
                <th scope="row" className="wrap">
                  <Link href={changeHref(row)} className="font-bold">
                    {row.title} <span className="font-semibold text-ink-2">v{row.currentVersion}</span>
                  </Link>
                </th>
                <td className="wrap">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StateChip state={row.state} />
                    {waiting ? <Chip look="waiting" icon="hourglass-medium">{waiting}</Chip> : null}
                  </span>
                </td>
                <td className="wrap">{row.markets.map((code) => marketName(names, code)).join(", ") || "none yet"}</td>
                <td className="wrap">{row.createdBy.label}</td>
                <td>{formatInstantIn(row.updatedAt, CONSOLE_ZONE)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CampaignsScreen() {
  const viewer = useViewer();
  const [filter, setFilter] = useState("all");
  const [pages, setPages] = useState<readonly (string | null)[]>([null]);
  const chosen = FILTERS.find((entry) => entry.id === filter) ?? FILTERS[0];
  const headingId = useId();
  const states = chosen?.states ? [...chosen.states] : null;

  return (
    <>
      <PageHead
        title="Campaigns"
        sub="Every offer, newest first. Each is a versioned change: drafted, checked, approved by someone other than its author, then scheduled."
        actions={can(viewer.roles, "createOffer") ? <ButtonLink href="/campaigns/new/" weight="primary" icon="plus">New campaign</ButtonLink> : null}
      />
      <PageBody>
        {!can(viewer.roles, "createOffer") ? <Locked>{whoDoes("createOffer", { one: "creates campaigns", many: "create campaigns" })}; {asRole(primaryRole(viewer.roles), { start: false })} you read them.</Locked> : null}
        <section className="grid gap-3" aria-labelledby={headingId}>
          <div className="zone-head">
            <h2 id={headingId}>Offers</h2>
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
            <ChangesPage key={`${filter}-${after ?? "first"}`} states={states} after={after} labelledBy={headingId} last={index === pages.length - 1} onMore={(next) => setPages((current) => [...current, next])} />
          ))}
        </section>
      </PageBody>
    </>
  );
}

function ChangesPage({ states, after, labelledBy, last, onMore }: {
  readonly states: ChangeState[] | null;
  readonly after: string | null;
  readonly labelledBy: string;
  readonly last: boolean;
  readonly onMore: (next: string) => void;
}) {
  const page = useGatewayQuery(ChangesDocument, { filter: { kind: "OFFER", ...(states ? { states } : {}) }, first: 25, after });
  if (page.isPending) return <Loading what="the campaigns" lines={6} />;
  if (page.isError) return <ErrorPanel error={page.error} retry={() => void page.refetch()} />;
  const rows = page.data.changes.nodes;
  if (rows.length === 0 && after === null) {
    return <Empty icon="megaphone">No campaign here yet. A new campaign starts as a draft that only its author sees changing.</Empty>;
  }
  return (
    <>
      <ChangesTable rows={rows} labelledBy={labelledBy} />
      {last && page.data.changes.next ? (
        <Button size="small" icon="arrow-down" onClick={() => onMore(page.data.changes.next ?? "")} className="justify-self-start">
          Show 25 more
        </Button>
      ) : null}
    </>
  );
}

/** The approvals' queues are read this many changes at a time. */
export const QUEUE_PAGE = 50;

/**
 * One queue of the approvals, read a page at a time. The engine gives no
 * total, so while it has more the count says "more than" what is shown, and
 * the next page is one button away: no change of the queue is left out.
 */
function Queue({ title, states, what, empty, children }: {
  readonly title: string;
  readonly states: ChangeState[];
  readonly what: string;
  readonly empty: ReactNode;
  readonly children?: ReactNode;
}) {
  const headingId = useId();
  const queue = useGatewayPages(ChangesDocument, (after) => ({ filter: { states }, first: QUEUE_PAGE, after }), (page) => page.changes.next);
  const rows = queue.data?.pages.flatMap((page) => page.changes.nodes) ?? [];
  const more = queue.hasNextPage;
  return (
    <section className="grid gap-3" aria-labelledby={headingId}>
      <div className="zone-head">
        <h2 id={headingId}>
          {queue.data ? (
            <span className="count">
              {more ? <span className="sr-only">More than </span> : null}
              {formatCount(rows.length)}
              {more ? <span aria-hidden="true">+</span> : null}
            </span>
          ) : null}
          <span>{title}</span>
        </h2>
      </div>
      {queue.isPending ? <Loading what={what} /> : queue.isError ? <ErrorPanel error={queue.error} retry={() => void queue.refetch()} /> : rows.length === 0 ? empty : (
        <ChangesTable rows={rows} labelledBy={headingId} />
      )}
      {more ? (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span>The first {formatCount(rows.length)} are shown, and there are more.</span>
          <Button size="small" icon="arrow-down" busy={queue.isFetchingNextPage} onClick={() => void queue.fetchNextPage()}>
            Show the next {QUEUE_PAGE}
          </Button>
        </p>
      ) : null}
      {children}
    </section>
  );
}

export function ApprovalsScreen() {
  return (
    <>
      <PageHead title="Approvals" sub="Every change is approved by someone other than its author, against the exact version and its fingerprint (§7.2, §7.4)." />
      <PageBody>
        <Queue
          title="Waiting for a signature"
          states={["IN_APPROVAL"]}
          what="the changes in approval"
          empty={<Empty icon="seal-check">Nothing waits for a signature. A change submitted for approval shows up here with who has to sign.</Empty>}
        />
        <Queue
          title="Approved, not live yet"
          states={["APPROVED", "SCHEDULED"]}
          what="the approved changes"
          empty={<Empty icon="calendar-blank">Nothing approved is waiting to start.</Empty>}
        >
          <p className="flex items-baseline gap-2 text-sm text-ink-2">
            <Icon name="info" size={15} className="translate-y-0.5" />
            An approved offer starts once {whoDoes("scheduleOffer", { one: "schedules it", many: "schedule it" }, { start: false, either: true })}; {approvesWithoutScheduling({ start: false })}.
          </p>
        </Queue>
      </PageBody>
    </>
  );
}
