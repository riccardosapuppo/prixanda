"use client";
// The audit log (business book §11): every change of state wrote one event
// in the same transaction as the change, with who, what, before and after,
// when, why and the request it came from. The page says §11.4 word for word,
// with the roles from the team's table (lib/permissions.ts): everyone reads
// the log, the auditor exports it with its head, the auditor and the on-call
// engineer verify the chain. What the chain really guarantees is said on the
// page, no more.
import { BRAND } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { TableScroll } from "../../components/table-scroll.tsx";
import { Button, Callout, Empty, ErrorPanel, Loading, Locked } from "../../components/ui.tsx";
import {
  AuditEventsDocument, type AuditEventsQuery, ExportAuditHeadDocument, PeopleDocument, VerifyAuditChainDocument, type VerifyAuditChainQuery,
} from "../../graphql/generated.ts";
import { asRole, can, inTeamOrder, logRule, primaryRole, ROLE_NAME, type Role, whoDoes } from "../../lib/permissions.ts";
import { useAction, useGateway, useGatewayPages, useGatewayQuery } from "../../lib/react/gateway.tsx";
import { seek } from "../../lib/seek.ts";
import { useViewer } from "../../lib/react/session.tsx";
import { formatInstantIn, formatUtcTime } from "../../lib/time.ts";

type Event = AuditEventsQuery["auditEvents"]["nodes"][number];
type Head = { readonly seq: string; readonly hash: string };

/** The actions the engine writes, for the filter. */
const ACTIONS = [
  "change.created", "change.version_saved", "change.validated", "change.submitted", "change.signed", "change.approved", "change.rejected",
  "change.scheduled", "change.activated", "change.cancelled", "change.suspended", "change.ended", "catalog.published", "audit.exported",
  "student.verified", "subscription.confirmed",
] as const;

/** §11.4, as the page says it. */
export const LOG_RULE = logRule(BRAND.platform);

function actorRole(role: string): string {
  if (role === "SYSTEM") return "The engine's job";
  if (role === "SUBSCRIBER") return "A subscriber, on the site";
  return ROLE_NAME[role as Role] ?? role;
}

/** "draft → validated", from an event's body, when it says so. */
export function movement(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const from = typeof parsed["from"] === "string" ? parsed["from"].replaceAll("_", " ") : null;
    const to = typeof parsed["to"] === "string" ? parsed["to"].replaceAll("_", " ") : null;
    if (from || to) return `${from ?? ""} → ${to ?? ""}`.trim();
    if (typeof parsed["version"] === "number") return `version ${parsed["version"]}`;
    return "";
  } catch {
    return "";
  }
}

export function AuditScreen() {
  const viewer = useViewer();
  const router = useRouter();
  const search = useSearchParams();
  const change = search.get("change") ?? "";
  const action = search.get("action") ?? "";
  const actor = search.get("actor") ?? "";
  const highlight = search.get("seq");
  const [exported, setExported] = useState<Head | null>(null);
  const people = useGatewayQuery(PeopleDocument, {}, { staleTime: 5 * 60_000 });
  const eventsId = useId();
  const filter = { ...(change ? { subject: `change:${change}` } : {}), ...(action ? { action } : {}), ...(actor ? { actor } : {}) };

  const setFilter = (name: string, value: string) => {
    const params = new URLSearchParams(search.toString());
    if (value) params.set(name, value);
    else params.delete(name);
    params.delete("seq");
    router.replace(`/audit/?${params.toString()}`, { scroll: false });
  };

  return (
    <>
      <PageHead title="Audit log" sub="Newest first. Every change of state wrote one event here, in the same transaction as the change itself (§11.1)." />
      <PageBody>
        <section className="grid grid-cols-1 gap-x-12 gap-y-5 border-t-2 border-ink pt-3 xl:grid-cols-[minmax(0,7fr)_minmax(18rem,4fr)]" aria-labelledby="chain">
          <div className="grid content-start gap-3">
            <h2 id="chain" className="text-xl font-bold">The chain</h2>
            <p className="font-semibold">{LOG_RULE}</p>
            <p className="max-w-[70ch]">
              Each event stores the hash of the one before it, computed by the database under a lock. Recomputing the chain shows an event changed,
              removed or reordered after the fact. It is tamper-evident against the exported head, not immutable: an administrator of the database
              could rewrite every later hash, and only a head exported earlier and kept elsewhere shows that (§11.3).
            </p>
            {can(viewer.roles, "verifyChain") ? <Verify exported={exported} /> : (
              <Locked>{whoDoes("verifyChain", { one: "verifies the chain", many: "verify the chain" })}. {asRole(primaryRole(viewer.roles))} you read every event below.</Locked>
            )}
          </div>
          <div className="grid content-start gap-3 border border-cord bg-stone-0 p-4">
            <h2 className="text-xl font-bold">Export with the head</h2>
            {can(viewer.roles, "exportHead") ? <Export onExported={setExported} /> : (
              <Locked>
                {whoDoes("exportHead", { one: "exports the log, with the head of the chain kept outside the database", many: "export the log, with the head of the chain kept outside the database" })}.{" "}
                {asRole(primaryRole(viewer.roles))} you read it, like everyone on the team.
              </Locked>
            )}
          </div>
        </section>

        <section className="grid gap-3" aria-labelledby={eventsId}>
          <div className="zone-head">
            <h2 id={eventsId}>Events</h2>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <label className="grid gap-1">
              <span className="label">Action</span>
              <select className="input min-w-[13rem]" value={action} onChange={(event) => setFilter("action", event.target.value)}>
                <option value="">All actions</option>
                {ACTIONS.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="label">Who</span>
              <select className="input min-w-[13rem]" value={actor} onChange={(event) => setFilter("actor", event.target.value)}>
                <option value="">Everyone</option>
                {inTeamOrder(people.data?.people ?? []).map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}
                <option value="activation">The activation job</option>
              </select>
            </label>
            <label className="grid gap-1">
              <span className="label">Change number</span>
              <input className="input w-[9rem]" inputMode="numeric" value={change} onChange={(event) => setFilter("change", event.target.value.replace(/\D/g, ""))} />
            </label>
            {change || action || actor ? (
              <Button size="small" weight="quiet" icon="arrow-counter-clockwise" onClick={() => router.replace("/audit/", { scroll: false })}>Clear filters</Button>
            ) : null}
          </div>
          <Events filter={filter} labelledBy={eventsId} highlight={highlight} filtered={Boolean(change || action || actor)} />
        </section>
      </PageBody>
    </>
  );
}

/** The log is read this many events at a time, newest first. */
const EVENTS_PAGE = 50;

/**
 * The events, newest first, a page at a time. An event a link names
 * (`?seq=12`, from an approval, a launch or the head's export) is read for:
 * the pages go on until it is among the events read, then it is highlighted
 * and brought into view; when the log has no such event, or not with these
 * filters, the page says so. A page that fails stops the search where it is
 * (the query's own retries have run by then): the page says so, and the next
 * try is the person's, with Try again.
 */
function Events({ filter, labelledBy, highlight, filtered }: {
  readonly filter: Record<string, string>;
  readonly labelledBy: string;
  readonly highlight: string | null;
  readonly filtered: boolean;
}) {
  const events = useGatewayPages(
    AuditEventsDocument,
    (after) => ({ filter: Object.keys(filter).length ? filter : null, first: EVENTS_PAGE, after }),
    (page) => page.auditEvents.next,
  );
  const rows = events.data?.pages.flatMap((page) => page.auditEvents.nodes) ?? [];
  const found = seek(highlight, { loaded: events.data !== undefined, seqs: rows.map((event) => event.seq), more: events.hasNextPage });
  const reading = events.isFetchingNextPage;
  // A page that failed keeps its cursor: the search waits for the person rather than asking for it again and again.
  const failed = events.isError;
  const { hasNextPage, fetchNextPage } = events;
  const pagesRead = events.data?.pages.length ?? 0;
  useEffect(() => {
    if (found === "seeking" && hasNextPage && !reading && !failed) void fetchNextPage();
  }, [found, hasNextPage, reading, failed, pagesRead, fetchNextPage]);
  useEffect(() => {
    if (found === "found") document.getElementById(`event-${highlight}`)?.scrollIntoView({ block: "center" });
  }, [found, highlight]);

  const named = highlight === null ? null : (
    found === "found" ? (
      <p role="status" className="flex items-baseline gap-2 text-sm"><Icon name="check-circle" size={15} className="translate-y-0.5 text-indigo" />Event #{highlight}, the one the link names, is highlighted below.</p>
    ) : found === "seeking" && failed ? (
      <p role="status" className="flex items-baseline gap-2 text-sm"><Icon name="warning" size={15} className="translate-y-0.5 text-madder" />Event #{highlight} is not reached yet: a page of older events did not load. Try again below.</p>
    ) : found === "seeking" ? (
      <p role="status" className="flex items-baseline gap-2 text-sm text-ink-2"><Icon name="hourglass-medium" size={15} className="translate-y-0.5" />Looking for event #{highlight} among older events: {rows.length} read so far.</p>
    ) : (
      <Callout tone="error" icon="warning" role="alert">
        <p className="font-bold">Event #{highlight} is not in the log{filtered ? " with these filters" : ""}.</p>
        <p>{filtered ? "Clear the filters to look for it in the whole log." : "The link names an event the log does not hold."} The newest events are below.</p>
      </Callout>
    )
  );
  if (events.isPending) return <>{named}<Loading what="the events" lines={8} /></>;
  if (events.isError && events.data === undefined) return <>{named}<ErrorPanel error={events.error} retry={() => void events.refetch()} /></>;
  if (rows.length === 0) return <>{named}<Empty icon="scroll">No event matches these filters.</Empty></>;
  return (
    <>
      {named}
      <TableScroll labelledBy={labelledBy}>
        <table className="data min-w-[64rem]" aria-labelledby={labelledBy}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">When, Rome and UTC</th>
              <th scope="col" className="wrap">Who</th>
              <th scope="col" className="wrap">Action</th>
              <th scope="col" className="wrap">Subject</th>
              <th scope="col" className="wrap">Before → after</th>
              <th scope="col" className="wrap">Reason</th>
              <th scope="col" className="wrap">Request</th>
              <th scope="col">Hash</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => <EventRow key={event.seq} event={event} highlighted={event.seq === highlight} />)}
          </tbody>
        </table>
      </TableScroll>
      {failed ? (
        <ErrorPanel error={events.error} retry={() => void events.fetchNextPage()} />
      ) : events.hasNextPage ? (
        <Button size="small" icon="arrow-down" className="justify-self-start" busy={reading} onClick={() => void events.fetchNextPage()}>Show {EVENTS_PAGE} older events</Button>
      ) : null}
    </>
  );
}

function EventRow({ event, highlighted }: { readonly event: Event; readonly highlighted: boolean }) {
  const subject = event.subject.startsWith("change:") ? <Link href={`/campaigns/approval/?id=${event.subject.slice(7)}`}>Change #{event.subject.slice(7)}</Link> : event.subject;
  return (
    <tr id={`event-${event.seq}`} className={highlighted ? "bg-silk-saffron" : ""} {...(highlighted ? { "aria-current": "true" as const } : {})}>
      <th scope="row" className="pl-2">{event.seq}</th>
      <td>{formatInstantIn(event.at, CONSOLE_ZONE, { seconds: true })}<small className="block text-xs text-ink-2">{formatUtcTime(event.at, { seconds: true })}</small></td>
      <td className="wrap">{actorRole(event.actorRole)}<small className="block text-xs text-ink-2">{event.actor}</small></td>
      <td className="wrap font-semibold">{event.action}</td>
      <td className="wrap">{subject}</td>
      <td className="wrap">{movement(event.body)}</td>
      <td className="wrap min-w-[11rem]">{event.reason ?? ""}</td>
      <td className="wrap text-xs break-all">{event.requestId}</td>
      <td className="font-semibold tracking-[0.02em]" title={event.hash}>{event.hash.slice(0, 8)}</td>
    </tr>
  );
}

/** A verification and the exported head it was asked to check: the message speaks of that head, never of what is typed now. */
type Verified = { readonly anchor: Head | null; readonly result: VerifyAuditChainQuery["verifyAuditChain"] };

function Verify({ exported }: { readonly exported: Head | null }) {
  const gateway = useGateway();
  const [verified, setVerified] = useState<Verified | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState("");
  const [hash, setHash] = useState("");
  // Each edit of the anchor, and each request, takes a new ticket: an answer
  // that comes back for an older ticket is not shown.
  const ticket = useRef(0);
  const edit = (next: { seq?: string; hash?: string }) => {
    ticket.current += 1;
    setVerified(null);
    setFailure(null);
    setBusy(false);
    if (next.seq !== undefined) setSeq(next.seq);
    if (next.hash !== undefined) setHash(next.hash);
  };
  useEffect(() => {
    if (exported) edit({ seq: exported.seq, hash: exported.hash });
  }, [exported]);
  const typedSeq = seq.trim();
  const typedHash = hash.trim();
  const anchored = typedSeq !== "" && /^[0-9a-f]{64}$/.test(typedHash);
  const partial = !anchored && (typedSeq !== "" || typedHash !== "");
  const run = async () => {
    const mine = ++ticket.current;
    const anchor = anchored ? { seq: typedSeq, hash: typedHash } : null;
    setBusy(true);
    setFailure(null);
    setVerified(null);
    try {
      const data = await gateway.run(VerifyAuditChainDocument, { anchor });
      if (mine === ticket.current) setVerified({ anchor, result: data.verifyAuditChain });
    } catch (error) {
      if (mine === ticket.current) setFailure(error);
    } finally {
      if (mine === ticket.current) setBusy(false);
    }
  };
  const result = verified?.result ?? null;
  const against = verified?.anchor ? `the exported head #${verified.anchor.seq} (${verified.anchor.hash.slice(0, 8)}…)` : null;
  return (
    <div className="grid gap-3">
      <details className="grid gap-2">
        <summary className="cursor-pointer font-semibold text-indigo pointer-coarse:py-3">Check against an exported head</summary>
        <div className="mt-2 grid gap-3 md:grid-cols-[8rem_minmax(0,1fr)]">
          <label className="grid gap-1"><span className="label">Event #</span><input className="input" inputMode="numeric" value={seq} onChange={(event) => edit({ seq: event.target.value.replace(/\D/g, "") })} /></label>
          <label className="grid gap-1"><span className="label">Its hash (64 hexadecimal digits)</span><input className="input" value={hash} onChange={(event) => edit({ hash: event.target.value.trim().toLowerCase() })} /></label>
        </div>
        {partial ? <p className="hint">An exported head needs its event number and its 64-digit hash: until both are there, the chain is checked on its own.</p> : null}
      </details>
      <Button weight="primary" icon="shield-check" busy={busy} onClick={() => void run()} className="justify-self-start">Verify the chain</Button>
      {failure ? <ErrorPanel error={failure} /> : null}
      {result ? (
        result.ok ? (
          <Callout tone="good" icon="check-circle" role="status">
            The chain holds: {result.events.toLocaleString("en-GB")} events recomputed{result.head ? `, head #${result.head.seq} ${result.head.hash.slice(0, 8)}` : ""}.
            {against ? ` It leads to ${against}, the head this check was given.` : " Checked without an exported head: check it against one to know the chain was not rewritten whole."}
          </Callout>
        ) : (
          <Callout tone="error" icon="link-break" role="alert">
            {against ? `Checked against ${against}: ` : ""}the chain breaks{result.brokenAt ? ` at event #${result.brokenAt}` : ""}: {result.why ?? "an event does not follow the one before it."} The runbook "the audit chain does not add up" says what to do next.
          </Callout>
        )
      ) : null}
    </div>
  );
}

function Export({ onExported }: { readonly onExported: (head: Head) => void }) {
  const exporting = useAction(ExportAuditHeadDocument, "export-audit-head");
  const [head, setHead] = useState<Head | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const run = async () => {
    const data = await exporting.mutateAsync({}).catch(() => null);
    if (data === null) return;
    if (data.exportAuditHead.__typename === "Refusal") {
      setRefusal(data.exportAuditHead.reason);
      return;
    }
    const exported = { seq: data.exportAuditHead.seq, hash: data.exportAuditHead.hash };
    setHead(exported);
    onExported(exported);
  };
  const download = () => {
    if (head === null) return;
    const blob = new Blob([`${JSON.stringify({ seq: head.seq, hash: head.hash, exportedAt: new Date().toISOString() }, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `audit-head-${head.seq}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="grid gap-3">
      <p>The engine writes the export in the log itself (audit.exported), and gives the head to keep outside the database.</p>
      <Button icon="export" busy={exporting.isPending} onClick={() => void run()} className="justify-self-start">Export the head</Button>
      {exporting.error ? <ErrorPanel error={exporting.error} /> : null}
      {refusal ? <Callout tone="error" icon="warning">{refusal}</Callout> : null}
      {head ? (
        <div className="grid gap-2">
          <p className="font-semibold">Exported head: event #{head.seq}</p>
          <p className="code">{head.hash}</p>
          <Button size="small" weight="quiet" icon="download-simple" onClick={download} className="justify-self-start">Save it as a file</Button>
          <p className="flex items-baseline gap-1.5 text-xs text-ink-2"><Icon name="info" size={13} className="translate-y-0.5" />Keep it somewhere the database's administrators cannot write.</p>
        </div>
      ) : null}
    </div>
  );
}
