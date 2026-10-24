"use client";
// The audit log (business book §11): every change of state wrote one event
// in the same transaction as the change, with who, what, before and after,
// when, why and the request it came from. Everyone on the team reads it; the
// auditor exports its head, to keep outside the database; the auditor and the
// on-call engineer verify the chain (§11.4, §12.2). What the chain really
// guarantees is said on the page, no more.
import { Icon } from "design/icon";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Button, Callout, Empty, ErrorPanel, Loading, Locked } from "../../components/ui.tsx";
import {
  AuditEventsDocument, type AuditEventsQuery, ExportAuditHeadDocument, PeopleDocument, VerifyAuditChainDocument, type VerifyAuditChainQuery,
} from "../../graphql/generated.ts";
import { can, ROLE_NAME, type Role } from "../../lib/permissions.ts";
import { useAction, useGateway, useGatewayQuery } from "../../lib/react/gateway.tsx";
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

export const ROLES_SENTENCE = "Everyone on the team reads the log. The auditor exports it. The auditor and the on-call engineer verify the chain.";

function actorRole(role: string): string {
  return role === "SYSTEM" ? "The engine's job" : ROLE_NAME[role as Role] ?? role;
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
  const [pages, setPages] = useState<readonly (string | null)[]>([null]);
  const [exported, setExported] = useState<Head | null>(null);
  const people = useGatewayQuery(PeopleDocument, {}, { staleTime: 5 * 60_000 });
  const eventsId = useId();
  const filter = { ...(change ? { subject: `change:${change}` } : {}), ...(action ? { action } : {}), ...(actor ? { actor } : {}) };

  const setFilter = (name: string, value: string) => {
    const params = new URLSearchParams(search.toString());
    if (value) params.set(name, value);
    else params.delete(name);
    params.delete("seq");
    setPages([null]);
    router.replace(`/audit/?${params.toString()}`, { scroll: false });
  };

  return (
    <>
      <PageHead title="Audit log" sub="Newest first. Every change of state wrote one event here, in the same transaction as the change itself (§11.1)." />
      <PageBody>
        <section className="grid grid-cols-1 gap-x-12 gap-y-5 border-t-2 border-ink pt-3 xl:grid-cols-[minmax(0,7fr)_minmax(18rem,4fr)]" aria-labelledby="chain">
          <div className="grid content-start gap-3">
            <h2 id="chain" className="text-xl font-bold">The chain</h2>
            <p className="font-semibold">{ROLES_SENTENCE}</p>
            <p className="max-w-[70ch]">
              Each event stores the hash of the one before it, computed by the database under a lock. Recomputing the chain shows an event changed,
              removed or reordered after the fact. It is tamper-evident against the exported head, not immutable: an administrator of the database
              could rewrite every later hash, and only a head exported earlier and kept elsewhere shows that (§11.3).
            </p>
            {can(viewer.roles, "verifyChain") ? <Verify exported={exported} /> : <Locked>The auditor and the on-call engineer verify the chain.</Locked>}
          </div>
          <div className="grid content-start gap-3 border border-cord bg-stone-0 p-4">
            <h2 className="text-xl font-bold">Export with the head</h2>
            {can(viewer.roles, "exportHead") ? <Export onExported={setExported} /> : <Locked>The auditor exports the log's head.</Locked>}
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
                {(people.data?.people ?? []).map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}
                <option value="activation">The activation job</option>
              </select>
            </label>
            <label className="grid gap-1">
              <span className="label">Change number</span>
              <input className="input w-[9rem]" inputMode="numeric" value={change} onChange={(event) => setFilter("change", event.target.value.replace(/\D/g, ""))} />
            </label>
            {change || action || actor ? (
              <Button size="small" weight="quiet" icon="arrow-counter-clockwise" onClick={() => {
                setPages([null]);
                router.replace("/audit/", { scroll: false });
              }}>Clear filters</Button>
            ) : null}
          </div>
          {pages.map((after, index) => (
            <EventsPage key={`${JSON.stringify(filter)}-${after ?? "first"}`} filter={filter} after={after} labelledBy={eventsId} highlight={highlight} last={index === pages.length - 1} onMore={(next) => setPages((current) => [...current, next])} />
          ))}
        </section>
      </PageBody>
    </>
  );
}

function EventsPage({ filter, after, labelledBy, highlight, last, onMore }: {
  readonly filter: Record<string, string>;
  readonly after: string | null;
  readonly labelledBy: string;
  readonly highlight: string | null;
  readonly last: boolean;
  readonly onMore: (next: string) => void;
}) {
  const page = useGatewayQuery(AuditEventsDocument, { filter: Object.keys(filter).length ? filter : null, first: 50, after });
  useEffect(() => {
    if (highlight && page.data) document.getElementById(`event-${highlight}`)?.scrollIntoView({ block: "center" });
  }, [highlight, page.data]);
  if (page.isPending) return <Loading what="the events" lines={8} />;
  if (page.isError) return <ErrorPanel error={page.error} retry={() => void page.refetch()} />;
  const rows = page.data.auditEvents.nodes;
  if (rows.length === 0 && after === null) return <Empty icon="scroll">No event matches these filters.</Empty>;
  return (
    <>
      <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={labelledBy}>
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
      </div>
      {last && page.data.auditEvents.next ? (
        <Button size="small" icon="arrow-down" className="justify-self-start" onClick={() => onMore(page.data.auditEvents.next ?? "")}>Show 50 older events</Button>
      ) : null}
    </>
  );
}

function EventRow({ event, highlighted }: { readonly event: Event; readonly highlighted: boolean }) {
  const subject = event.subject.startsWith("change:") ? <Link href={`/campaigns/approval/?id=${event.subject.slice(7)}`}>Change #{event.subject.slice(7)}</Link> : event.subject;
  return (
    <tr id={`event-${event.seq}`} className={highlighted ? "bg-silk-saffron" : ""}>
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
        <summary className="cursor-pointer font-semibold text-indigo">Check against an exported head</summary>
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
