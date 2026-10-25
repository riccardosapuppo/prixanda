"use client";
// One launch, moment by moment (business book §7.5, §14.6): its five steps
// in order (done, running, failed, to be tried again, to do), with when each
// ran, its attempts, its last error and what it wrote; why the launch stopped
// or waits; what the site shows right now, which is the catalog of before
// until the publish step is done; how it ended; its incidents; and the audit
// events it wrote. While it runs, the page reads it again every two seconds.
//
// The on-call engineer tries a failed, refused or waiting launch again, or
// gives up one that has not published, after a confirmation that names the
// run and the change (§12); every other role reads why it cannot, and the
// server would refuse it anyway.
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "design/icon";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { PageBody, PageHead } from "../../components/frame.tsx";
import { Button, Callout, Chip, Empty, ErrorPanel, Loading, Locked } from "../../components/ui.tsx";
import { AuditEventsDocument, CancelLaunchDocument, LaunchRunDocument, RetryLaunchDocument } from "../../graphql/generated.ts";
import {
  elapsed, INCIDENT_KIND, INCIDENT_LOOK, type LaunchDetail, launchActions, launchWords, MAX_FAILURES, now, publication, STEP_LOOK, STEP_NAME, stepCounts, stepLook,
} from "../../lib/launch.ts";
import { approvalHref } from "../../lib/kinds.ts";
import { marketName, marketZone } from "../../lib/markets.ts";
import { asRole, can, primaryRole, whoDoes } from "../../lib/permissions.ts";
import { useAction, useGatewayQuery } from "../../lib/react/gateway.tsx";
import { useViewer } from "../../lib/react/session.tsx";
import { useWatch } from "../../lib/react/watch.tsx";
import { formatClockIn, formatInstantIn, formatLocalWithUtc, formatUtcTime } from "../../lib/time.ts";
import { LaunchChip } from "./launches.tsx";

type Result = { readonly __typename: "LaunchRun" } | { readonly __typename: "Refusal"; readonly code: string; readonly reason: string };

export function LaunchRunScreen() {
  const id = useSearchParams().get("id") ?? "";
  const valid = /^\d+$/.test(id);
  // While the launch runs, it is read again every two seconds; otherwise at the pace of a page that watches (a launch
  // that failed can be tried again from another seat).
  const watch = useWatch();
  const query = useGatewayQuery(LaunchRunDocument, { id }, {
    enabled: valid,
    ...watch,
    refetchInterval: (data) => (data?.launch?.state === "RUNNING" ? 2_000 : watch.refetchInterval ?? false),
  });
  const launch = query.data?.launch ?? null;

  const head = (
    <PageHead
      crumbs={[{ label: "Launches", href: "/launches/" }, { label: launch?.run ?? `Launch #${id}` }]}
      title={launch ? `Launch timeline: ${launch.run}` : "Launch timeline"}
      sub={launch && query.data ? (
        <>
          <LaunchChip launch={launch} />
          <span>
            <Link href={approvalHref(launch.kind, launch.change.id)}>{launch.title} v{launch.version}</Link>, {marketName(query.data.markets, launch.starts.market)}.
            Starts {formatLocalWithUtc(launch.starts.local, marketZone(query.data.markets, launch.starts.market))}
          </span>
        </>
      ) : null}
    />
  );
  if (!valid) return <>{head}<PageBody><Empty icon="rocket-launch">This address names no launch. Open one from the launches.</Empty></PageBody></>;
  if (query.isPending) return <>{head}<PageBody><Loading what="the launch" lines={8} /></PageBody></>;
  if (query.isError) return <>{head}<PageBody><ErrorPanel error={query.error} retry={() => void query.refetch()} /></PageBody></>;
  if (launch === null) return <>{head}<PageBody><Empty icon="rocket-launch">The engine has no launch with that number.</Empty></PageBody></>;
  const zone = marketZone(query.data.markets, launch.starts.market);
  return (
    <>
      {head}
      <PageBody>
        <Why launch={launch} zone={zone} />
        <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(18rem,5fr)] xl:gap-12">
          <Steps launch={launch} zone={zone} />
          <div className="grid content-start gap-6">
            <LiveNow launch={launch} zone={zone} />
            <OnCall launch={launch} />
          </div>
        </div>
        <Incidents launch={launch} zone={zone} />
        <Events launch={launch} zone={zone} />
      </PageBody>
    </>
  );
}

/** Why the launch stopped, or waits; and how it ended. */
function Why({ launch, zone }: { readonly launch: LaunchDetail; readonly zone: string }) {
  if (launch.state === "DONE" || launch.state === "CANCELLED") {
    return launch.resolution ? <Callout tone={launch.state === "DONE" ? "good" : "plain"} icon={launch.state === "DONE" ? "check-circle" : "x-circle"}><p className="[overflow-wrap:anywhere]"><b>How it ended:</b> {launchWords(launch.resolution, zone, { capital: false })}</p></Callout> : null;
  }
  if (launch.cause === null) return null;
  const waits = launch.state === "RUNNING" && launch.retryAt !== null;
  return (
    <Callout tone={waits ? "quiet" : "error"} icon={waits ? "clock-countdown" : "warning"} role={waits ? "status" : "alert"}>
      <p className="font-bold">{waits ? "Why it waits" : launch.state === "REFUSED" ? "Why it was refused" : "Why it stopped"}</p>
      <p className="[overflow-wrap:anywhere]">{launchWords(launch.cause, zone)}</p>
      {waits && launch.retryAt ? <p>The engine tries the {STEP_NAME[launch.currentStep ?? ""]?.toLowerCase() ?? "failed"} step again at {formatInstantIn(launch.retryAt, zone, { seconds: true })} ({formatUtcTime(launch.retryAt, { seconds: true })}).</p> : null}
      {launch.state === "REFUSED" ? <p>Trying again would find the same until someone changes something: nothing was published, and the change stays scheduled.</p> : null}
    </Callout>
  );
}

function Steps({ launch, zone }: { readonly launch: LaunchDetail; readonly zone: string }) {
  const headingId = useId();
  return (
    <section className="grid content-start gap-3" aria-labelledby={headingId}>
      <div className="zone-head">
        <h2 id={headingId}>Steps</h2>
        <span className="text-sm text-ink-2">{stepCounts(launch.steps, launch)}</span>
      </div>
      <ol className="m-0 grid list-none p-0">
        {launch.steps.map((step) => {
          const look = STEP_LOOK[stepLook(step, launch)];
          return (
            <li key={step.name} className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-cord py-3 first:border-t-0">
              <span className="text-sm tabular-nums text-ink-2">
                {step.startedAt ? (
                  <>
                    {formatClockIn(step.startedAt, zone)}
                    {launch.startedAt ? <span className="block text-xs">{elapsed(launch.startedAt, step.finishedAt ?? step.startedAt)}</span> : null}
                  </>
                ) : "not yet"}
              </span>
              <div className="grid gap-1">
                <h3 className="flex flex-wrap items-center gap-2 text-base font-bold">
                  {STEP_NAME[step.name] ?? step.name}
                  <Chip look={look.look} icon={look.icon}>{look.word}</Chip>
                  {step.attempts > 1 || step.state === "FAILED" ? <span className="text-sm font-normal text-ink-2">attempt {step.attempts} of {MAX_FAILURES}</span> : null}
                </h3>
                <p className="text-sm text-ink-2">{step.purpose}</p>
                {step.error ? <p className="text-sm [overflow-wrap:anywhere]"><b>Last attempt:</b> {launchWords(step.error, zone)}</p> : null}
                {step.facts.length ? (
                  <dl className="m-0 flex flex-wrap gap-x-5 gap-y-0.5 text-sm">
                    {step.facts.map((fact) => (
                      <div key={fact.name} className="flex min-w-0 gap-1.5"><dt className="shrink-0 text-ink-2">{fact.name}</dt><dd className="m-0 min-w-0 font-semibold [overflow-wrap:anywhere]">{launchWords(fact.value, zone, { capital: false })}</dd></div>
                    ))}
                  </dl>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-ink-2">{label}</dt>
      <dd className="m-0 font-semibold">{children}</dd>
    </div>
  );
}

/**
 * Two things kept apart: what is live today (the change's state now, and the
 * newest catalog the log says was published), and what this launch itself
 * published, which is history. When today is not what the launch left (the
 * change suspended or ended since, a later catalog live), the page says so.
 */
function LiveNow({ launch, zone }: { readonly launch: LaunchDetail; readonly zone: string }) {
  const latest = useGatewayQuery(AuditEventsDocument, { filter: { action: "catalog.published" }, first: 1, after: null }, {
    refetchInterval: launch.state === "RUNNING" ? 2_000 : false,
  });
  const newest = latest.data?.auditEvents.nodes[0] ?? null;
  const liveCatalog = newest?.subject.startsWith("catalog:") ? newest.subject.slice("catalog:".length) : null;
  const today = now(launch, liveCatalog);
  const left = publication(launch);
  const publish = launch.steps.find((step) => step.name === "publish");
  return (
    <div className="grid content-start gap-4">
      <section className="grid content-start gap-3 border border-cord bg-stone-0 p-4" aria-labelledby="live-now">
        <h2 id="live-now" className="text-xl font-bold">Live now</h2>
        <dl className="m-0 grid gap-3">
          <Fact label="Catalog">
            <span className="text-4xl font-bold tabular-nums">{latest.isPending ? "…" : today.catalog ? `#${today.catalog}` : "not known"}</span>
            {newest ? <span className="block text-sm font-normal text-ink-2">published {formatInstantIn(newest.at, zone, { seconds: true })}, the newest in the log</span> : null}
          </Fact>
          <Fact label="On the site">{today.words}</Fact>
        </dl>
        {latest.isError ? <ErrorPanel error={latest.error} retry={() => void latest.refetch()} /> : null}
        {today.differs ? <Callout icon="warning"><p>{today.differs}</p></Callout> : null}
      </section>
      <section className="grid content-start gap-3 border border-cord bg-stone p-4" aria-labelledby="launch-published">
        <h2 id="launch-published" className="text-lg font-bold">What this launch published</h2>
        <dl className="m-0 grid gap-3">
          <Fact label={left.published ? "Catalog" : "Catalog that stayed live"}>
            {left.catalog ? `#${left.catalog}` : "not known yet"}
            {left.published && left.at ? <span className="block text-sm font-normal text-ink-2">{formatInstantIn(left.at, zone, { seconds: true })}</span> : null}
          </Fact>
          <Fact label="What it did">{left.words}</Fact>
          {publish ? <Fact label="Publish attempts">{publish.attempts} of {MAX_FAILURES}</Fact> : null}
          <Fact label="Attempts, all steps together">{launch.attempts}</Fact>
        </dl>
      </section>
    </div>
  );
}

/** What the on-call engineer can do now, behind a confirmation; for everyone else, who can. */
function OnCall({ launch }: { readonly launch: LaunchDetail }) {
  const viewer = useViewer();
  const client = useQueryClient();
  const role = primaryRole(viewer.roles);
  const actions = launchActions(launch);
  const retryButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<"retry" | "cancel" | null>(null);
  const [confirming, setConfirming] = useState<"retry" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const retry = useAction(RetryLaunchDocument, "retry-launch");
  const cancel = useAction(CancelLaunchDocument, "cancel-launch");
  const failure = retry.error ?? cancel.error;
  const step = (STEP_NAME[launch.currentStep ?? ""] ?? "stopped").toLowerCase();

  const after = async (result: Result | undefined, words: string) => {
    setConfirming(null);
    if (result === undefined) return;
    if (result.__typename === "Refusal") {
      setRefusal(`${result.reason} (${result.code.toLowerCase().replaceAll("_", " ")})`);
    } else {
      setRefusal(null);
      setDone(words);
      setOpen(null);
      setReason("");
    }
    await client.invalidateQueries({ predicate: (query) => ["LaunchRun", "LaunchRuns", "Home", "Change", "Changes", "AuditEvents"].includes(String(query.queryKey[0])) });
  };

  if (!actions.retry && !actions.cancel) {
    // What the person just did stays said, though nothing more is left to do.
    if (done) return <Callout tone="good" icon="check-circle" role="status">{done}</Callout>;
    return launch.state === "DONE" ? (
      <p className="text-sm text-ink-2">
        Published: there is nothing to try again. To take the change off the site, {whoDoes("suspend", { one: "suspends it", many: "suspend it" }, { start: false, either: true })} on its{" "}
        <Link href={approvalHref(launch.kind, launch.change.id)}>approval page</Link>, with a reason.
      </p>
    ) : null;
  }
  if (!can(viewer.roles, "retryLaunch") && !can(viewer.roles, "cancelLaunch")) {
    return (
      <Locked>
        {whoDoes("retryLaunch", { one: "tries again or gives up a launch that stopped", many: "try again or give up a launch that stopped" })}. {asRole(role)} you read it.
      </Locked>
    );
  }

  const ask = (kind: "retry" | "cancel") => {
    if (kind === "cancel" && reason.trim().length < 3) {
      setReasonError("Write why the launch is given up: it goes into the audit log, and the change is cancelled with it.");
      document.getElementById("launch-reason")?.focus();
      return;
    }
    setReasonError(null);
    setConfirming(kind);
  };

  return (
    <section className="grid content-start gap-3 border-t-2 border-ink pt-3" aria-labelledby="on-call">
      <h2 id="on-call" className="text-xl font-bold">What you can do</h2>
      {done ? <Callout tone="good" icon="check-circle" role="status">{done}</Callout> : null}
      {refusal ? <Callout tone="error" icon="warning" role="alert"><p className="font-bold">The engine refused it.</p><p>{refusal}</p></Callout> : null}
      {failure ? <ErrorPanel error={failure} /> : null}
      <div className="flex flex-wrap gap-3">
        {actions.retry && can(viewer.roles, "retryLaunch") ? (
          <Button ref={retryButton} weight="primary" icon="arrow-counter-clockwise" onClick={() => setOpen(open === "retry" ? null : "retry")} aria-expanded={open === "retry"} aria-controls="launch-reason-form">
            Try again from the {step} step
          </Button>
        ) : null}
        {actions.cancel && can(viewer.roles, "cancelLaunch") ? (
          <Button ref={cancelButton} icon="prohibit" onClick={() => setOpen(open === "cancel" ? null : "cancel")} aria-expanded={open === "cancel"} aria-controls="launch-reason-form">
            Give up the launch
          </Button>
        ) : null}
      </div>
      {open ? (
        <form id="launch-reason-form" className="grid gap-2" onSubmit={(event) => {
          event.preventDefault();
          ask(open);
        }}>
          <label htmlFor="launch-reason" className="label">
            {open === "retry" ? "What was done so that it can go through (optional)" : "Why the launch is given up"}
          </label>
          <textarea id="launch-reason" className="input" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} aria-invalid={reasonError ? true : undefined} aria-describedby={reasonError ? "launch-reason-error" : undefined} />
          {reasonError ? <p className="field-error" id="launch-reason-error"><Icon name="warning-circle" size={16} />{reasonError}</p> : null}
          <Button type="submit" icon={open === "retry" ? "arrow-counter-clockwise" : "prohibit"} className="justify-self-start">
            {open === "retry" ? `Try ${launch.run} again` : `Give up ${launch.run}`}
          </Button>
        </form>
      ) : null}

      <ConfirmDialog
        open={confirming === "retry"}
        title={`Try ${launch.run} again?`}
        confirmLabel={`Try ${launch.run} again`}
        confirmIcon="arrow-counter-clockwise"
        busy={retry.isPending}
        onCancel={() => setConfirming(null)}
        returnFocus={retryButton}
        onConfirm={async () => {
          const result = (await retry.mutateAsync({ launchId: launch.id, reason: reason.trim() || null }).catch(() => null))?.retryLaunch as Result | undefined;
          await after(result, `${launch.run} runs again from its ${step} step. The audit log has it, with this request's id.`);
        }}
      >
        <p>The engine runs the launch of {launch.title} v{launch.version} again from its {step} step, now.</p>
        <p>{reason.trim() ? <>Your note goes into the audit log: <q>{reason.trim()}</q></> : "No note: the audit log records who tried it again, and when."}</p>
        <Callout icon="warning"><b>Its start may have passed:</b> if every step goes through, the change is live at once.</Callout>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === "cancel"}
        title={`Give up ${launch.run}?`}
        confirmLabel={`Give up ${launch.run}`}
        confirmIcon="prohibit"
        busy={cancel.isPending}
        onCancel={() => setConfirming(null)}
        returnFocus={cancelButton}
        onConfirm={async () => {
          const result = (await cancel.mutateAsync({ launchId: launch.id, reason: reason.trim() }).catch(() => null))?.cancelLaunch as Result | undefined;
          await after(result, `${launch.run} was given up and ${launch.title} v${launch.version} is cancelled, with your reason. The catalog of before stays live.`);
        }}
      >
        <p>{launch.title} v{launch.version} is cancelled with this reason, and the catalog of before stays live:</p>
        <blockquote className="said m-0"><p>{reason.trim()}</p></blockquote>
        <Callout icon="warning"><b>This can't be undone.</b> To offer it again, {whoDoes("createOffer", { one: "starts a new campaign", many: "start a new campaign" }, { start: false, either: true })}.</Callout>
      </ConfirmDialog>
    </section>
  );
}

function Incidents({ launch, zone }: { readonly launch: LaunchDetail; readonly zone: string }) {
  if (launch.incidents.length === 0) return null;
  return (
    <section className="grid content-start gap-3" aria-labelledby="incidents">
      <div className="zone-head"><h2 id="incidents">Incidents</h2></div>
      <ul role="list" className="grid">
        {launch.incidents.map((incident) => {
          const look = INCIDENT_LOOK[incident.state];
          return (
            <li key={incident.id} className="grid gap-1 border-t border-cord py-3 first:border-t-0">
              <p className="flex flex-wrap items-center gap-2">
                <Chip look={look.look} icon={look.icon}>{look.word}</Chip>
                <b>{INCIDENT_KIND[incident.kind]}</b>
                <span className="text-sm text-ink-2">opened {formatInstantIn(incident.openedAt, zone, { seconds: true })}{incident.closedAt ? `, closed ${formatInstantIn(incident.closedAt, zone, { seconds: true })}` : ""}</span>
              </p>
              <p className="text-sm [overflow-wrap:anywhere]">{launchWords(incident.summary, zone)}</p>
              {incident.resolution ? <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">{launchWords(incident.resolution, zone)}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The audit events the launch wrote, oldest first. The log is read by the
 * subjects a launch writes under (its change, itself, the catalog it
 * published) and kept to the launch's own; any it names that those readings
 * do not hold still shows, as a link into the log.
 */
function Events({ launch, zone }: { readonly launch: LaunchDetail; readonly zone: string }) {
  const seqs = new Set(launch.auditEventSeqs);
  const byChange = useGatewayQuery(AuditEventsDocument, { filter: { subject: `change:${launch.change.id}` }, first: 100, after: null }, { enabled: seqs.size > 0 });
  const byLaunch = useGatewayQuery(AuditEventsDocument, { filter: { subject: `launch:${launch.id}` }, first: 100, after: null });
  const byCatalog = useGatewayQuery(AuditEventsDocument, { filter: { subject: `catalog:${launch.snapshotAfter ?? ""}` }, first: 20, after: null }, { enabled: launch.snapshotAfter !== null });
  const events = [...(byChange.data?.auditEvents.nodes ?? []), ...(byLaunch.data?.auditEvents.nodes ?? []), ...(byCatalog.data?.auditEvents.nodes ?? [])]
    .filter((event, index, all) => (seqs.has(event.seq) || event.subject === `launch:${launch.id}`) && all.findIndex((other) => other.seq === event.seq) === index)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  const unread = byChange.isPending || byLaunch.isPending ? [] : [...seqs].filter((seq) => !events.some((event) => event.seq === seq));
  return (
    <section className="grid content-start gap-3" aria-labelledby="launch-events">
      <div className="zone-head">
        <h2 id="launch-events">Audit events</h2>
        <Link href={`/audit/?change=${launch.change.id}`} className="inline-flex items-center gap-1.5 text-sm font-semibold pointer-coarse:-my-3 pointer-coarse:py-3"><Icon name="scroll" size={16} />Open the audit log</Link>
      </div>
      {byChange.isError ? <ErrorPanel error={byChange.error} /> : byLaunch.isError ? <ErrorPanel error={byLaunch.error} /> : events.length === 0 && unread.length === 0 ? (
        <p className="text-sm text-ink-2">{launch.startedAt ? "None yet: the steps write their events when they commit." : "The launch has not begun: it begins a minute before the start."}</p>
      ) : (
        <ul role="list" className="grid">
          {events.map((event) => (
            <li key={event.seq} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-t border-cord py-2 text-sm first:border-t-0">
              <Link href={`/audit/?seq=${event.seq}`} className="font-bold tabular-nums pointer-coarse:-mx-3.5 pointer-coarse:p-3.5">#{event.seq}</Link>
              <span>
                <b>{event.action}</b> <span className="text-ink-2">{formatInstantIn(event.at, zone, { seconds: true })}</span>
                {event.reason ? <span className="block text-ink-2">{event.reason}</span> : null}
              </span>
              <code className="text-xs">{event.hash.slice(0, 8)}</code>
            </li>
          ))}
          {unread.map((seq) => (
            <li key={seq} className="border-t border-cord py-2 text-sm"><Link href={`/audit/?seq=${seq}`} className="font-bold tabular-nums pointer-coarse:-mx-3.5 pointer-coarse:p-3.5">#{seq}</Link> <span className="text-ink-2">in the log</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}
