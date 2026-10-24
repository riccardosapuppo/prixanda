"use client";
// Lists of changes: the campaigns (every offer, newest first, a page at a
// time) and the approvals (what waits for a signature, and what is approved
// but not live yet). Each row leads to the change's own page.
import { formatCount } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useId, useState } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Button, ButtonLink, Chip, Empty, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import { ChangesDocument, type ChangesQuery, type ChangeState, MarketsDocument } from "../../graphql/generated.ts";
import { marketName } from "../../lib/markets.ts";
import { can, ROLE_NAME, whoCan } from "../../lib/permissions.ts";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";
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
  const missing = row.requiredSignatures.filter((signature) => !signature.signed);
  if (row.state !== "IN_APPROVAL" || missing.length === 0) return null;
  return `Waiting for ${missing.map((signature) => (signature.role === "COMMERCIAL_LEAD" ? "the commercial lead or Finance" : ROLE_NAME[signature.role])).join(" and ")}`;
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
        {!can(viewer.roles, "createOffer") ? <Locked>{whoCan("createOffer")} creates campaigns; this role reads them.</Locked> : null}
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

export function ApprovalsScreen() {
  const waiting = useGatewayQuery(ChangesDocument, { filter: { states: ["IN_APPROVAL"] }, first: 50, after: null });
  const approved = useGatewayQuery(ChangesDocument, { filter: { states: ["APPROVED", "SCHEDULED"] }, first: 50, after: null });
  const waitingId = useId();
  const approvedId = useId();
  return (
    <>
      <PageHead title="Approvals" sub="Every change is approved by someone other than its author, against the exact version and its fingerprint (§7.2, §7.4)." />
      <PageBody>
        <section className="grid gap-3" aria-labelledby={waitingId}>
          <div className="zone-head">
            <h2 id={waitingId}>
              <span className="count">{waiting.data ? formatCount(waiting.data.changes.nodes.length) : ""}</span>
              <span>Waiting for a signature</span>
            </h2>
          </div>
          {waiting.isPending ? <Loading what="the changes in approval" /> : waiting.isError ? <ErrorPanel error={waiting.error} retry={() => void waiting.refetch()} /> : waiting.data.changes.nodes.length === 0 ? (
            <Empty icon="seal-check">Nothing waits for a signature. A change submitted for approval shows up here with who has to sign.</Empty>
          ) : <ChangesTable rows={waiting.data.changes.nodes} labelledBy={waitingId} />}
        </section>
        <section className="grid gap-3" aria-labelledby={approvedId}>
          <div className="zone-head">
            <h2 id={approvedId}>
              <span className="count">{approved.data ? formatCount(approved.data.changes.nodes.length) : ""}</span>
              <span>Approved, not live yet</span>
            </h2>
          </div>
          {approved.isPending ? <Loading what="the approved changes" /> : approved.isError ? <ErrorPanel error={approved.error} retry={() => void approved.refetch()} /> : approved.data.changes.nodes.length === 0 ? (
            <Empty icon="calendar-blank">Nothing approved is waiting to start.</Empty>
          ) : <ChangesTable rows={approved.data.changes.nodes} labelledBy={approvedId} />}
          <p className="flex items-baseline gap-2 text-sm text-ink-2">
            <Icon name="info" size={15} className="translate-y-0.5" />
            An approved offer starts once Marketing or the commercial lead schedules it; Finance approves but does not schedule.
          </p>
        </section>
      </PageBody>
    </>
  );
}
