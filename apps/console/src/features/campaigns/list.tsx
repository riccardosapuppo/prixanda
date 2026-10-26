"use client";
// Lists of changes: the campaigns, the price migrations and the prepaid
// passes (each kind newest first, a page at a time), and the approvals (what
// waits for a signature, and what is approved but not live yet, of every
// kind). Each row leads to the change's own page.
import { formatCount } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { TableScroll } from "../../components/table-scroll.tsx";
import { Button, ButtonLink, Chip, Empty, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import { ChangesDocument, type ChangesQuery, type ChangeState, MarketsDocument } from "../../graphql/generated.ts";
import { marketName } from "../../lib/markets.ts";
import { type ChangeKind, changeHref, kindOf } from "../../lib/kinds.ts";
import { approvesWithoutScheduling, asRole, can, primaryRole, type Right, waitingFor, whoDoes } from "../../lib/permissions.ts";
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

function waitingWords(row: Row): string | null {
  if (row.state !== "IN_APPROVAL" || row.requiredSignatures.every((signature) => signature.signed)) return null;
  return waitingFor(row.requiredSignatures);
}

/** The rows of a list; mixed: changes of several kinds, each named with its kind under its title (the approvals). */
function ChangesTable({ rows, labelledBy, kind = null }: { readonly rows: readonly Row[]; readonly labelledBy: string; readonly kind?: ChangeKind | null }) {
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const names = markets.data?.markets ?? [];
  return (
    <TableScroll labelledBy={labelledBy}>
      <table className="data min-w-[52rem]">
        <thead>
          <tr>
            <th scope="col">{kind ? kindOf(kind).word : "Change"}</th>
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
                  {kind === null ? <span className="block text-xs font-normal text-ink-2">{kindOf(row.kind).word}</span> : null}
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
    </TableScroll>
  );
}

/** What a list of one kind says: its title, its sentence, how to start one, and who may. */
type ListOf = {
  readonly kind: "OFFER" | "PRICE_MIGRATION" | "PREPAID";
  readonly title: string;
  readonly sub: string;
  readonly heading: string;
  readonly newLabel: string;
  readonly writes: Right;
  readonly verb: { readonly one: string; readonly many: string };
  readonly empty: string;
};

const LISTS: Readonly<Record<ListOf["kind"], ListOf>> = {
  OFFER: {
    kind: "OFFER", title: "Campaigns", heading: "Offers", newLabel: "New campaign", writes: "createOffer",
    sub: "Every offer, newest first. Each is a versioned change: drafted, checked, approved by someone other than its author, then scheduled.",
    verb: { one: "creates campaigns", many: "create campaigns" },
    empty: "No campaign here yet. A new campaign starts as a draft that only its author sees changing.",
  },
  PRICE_MIGRATION: {
    kind: "PRICE_MIGRATION", title: "Price migrations", heading: "Migrations", newLabel: "New price migration", writes: "createPriceMigration",
    sub: "A higher price for one plan in one market: new subscribers pay it from a date, and those who already pay are asked or told by their market's rules (§8).",
    verb: { one: "writes price migrations", many: "write price migrations" },
    empty: "No price migration here yet. One starts as a draft, and nobody is asked or told before it is approved, scheduled and launched.",
  },
  PREPAID: {
    kind: "PREPAID", title: "Prepaid passes", heading: "Passes", newLabel: "New prepaid pass", writes: "createPrepaidPass",
    sub: "Months of a plan paid once, sold as a single-use code to keep or to give; never renewed, and never touched by a later price (§9).",
    verb: { one: "writes prepaid passes", many: "write prepaid passes" },
    empty: "No prepaid pass here yet. One starts as a draft, and goes on sale once Finance signed it and its launch published it.",
  },
};

export function CampaignsScreen() {
  return <ChangesScreen list={LISTS.OFFER} />;
}

export function MigrationsScreen() {
  return <ChangesScreen list={LISTS.PRICE_MIGRATION} />;
}

export function PassesScreen() {
  return <ChangesScreen list={LISTS.PREPAID} />;
}

function ChangesScreen({ list }: { readonly list: ListOf }) {
  const viewer = useViewer();
  const [filter, setFilter] = useState("all");
  const chosen = FILTERS.find((entry) => entry.id === filter) ?? FILTERS[0];
  const headingId = useId();
  const states = chosen?.states ? [...chosen.states] : null;
  const base = kindOf(list.kind).base ?? "/campaigns/";

  return (
    <>
      <PageHead
        title={list.title}
        sub={list.sub}
        actions={can(viewer.roles, list.writes) ? <ButtonLink href={`${base}new/`} weight="primary" icon="plus">{list.newLabel}</ButtonLink> : null}
      />
      <PageBody>
        {!can(viewer.roles, list.writes) ? <Locked>{whoDoes(list.writes, list.verb)}; {asRole(primaryRole(viewer.roles), { start: false })} you read them.</Locked> : null}
        <section className="grid gap-3" aria-labelledby={headingId}>
          <div className="zone-head">
            <h2 id={headingId}>{list.heading}</h2>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
              {FILTERS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={filter === entry.id}
                  onClick={() => setFilter(entry.id)}
                  className={`min-h-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-control border px-3 text-sm font-semibold ${filter === entry.id ? "border-ink bg-ink text-stone-0" : "border-edge bg-stone-0 hover:bg-stone-2"}`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          <Changes list={list} states={states} labelledBy={headingId} />
        </section>
      </PageBody>
    </>
  );
}

/** A list of one kind is read this many changes at a time. */
const LIST_PAGE = 25;

/**
 * The changes of one kind, a page at a time. When a change moves (an action,
 * or in the sandbox the worker's word), the pages loaded are read again
 * together, in order from the first, each with the cursor the page before it
 * gives now (useGatewayPages): a change edited or created comes to the top,
 * every page's edge moves with it, and the change at an old edge stays on
 * the list.
 */
function Changes({ list, states, labelledBy }: { readonly list: ListOf; readonly states: ChangeState[] | null; readonly labelledBy: string }) {
  const changes = useGatewayPages(ChangesDocument, (after) => ({ filter: { kind: list.kind, ...(states ? { states } : {}) }, first: LIST_PAGE, after }), (page) => page.changes.next);
  if (changes.isPending) return <Loading what={`the ${list.title.toLowerCase()}`} lines={6} />;
  if (changes.data === undefined) return <ErrorPanel error={changes.error} retry={() => void changes.refetch()} />;
  const rows = changes.data.pages.flatMap((page) => page.changes.nodes);
  if (rows.length === 0) return <Empty icon={kindOf(list.kind).icon}>{list.empty}</Empty>;
  return (
    <>
      <ChangesTable rows={rows} labelledBy={labelledBy} kind={list.kind} />
      {changes.isError ? (
        <ErrorPanel error={changes.error} retry={() => void (changes.isFetchNextPageError ? changes.fetchNextPage() : changes.refetch())} />
      ) : changes.hasNextPage ? (
        <Button size="small" icon="arrow-down" busy={changes.isFetchingNextPage} onClick={() => void changes.fetchNextPage()} className="justify-self-start">
          Show {LIST_PAGE} more
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
            An approved offer starts once {whoDoes("scheduleOffer", { one: "schedules it", many: "schedule it" }, { start: false, either: true })}; a price migration or a prepaid pass once {whoDoes("schedulePrice", { one: "schedules it", many: "schedule it" }, { start: false, either: true })}. {approvesWithoutScheduling()}.
          </p>
        </Queue>
      </PageBody>
    </>
  );
}
