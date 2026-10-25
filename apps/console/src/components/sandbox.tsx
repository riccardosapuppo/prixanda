"use client";
// The console in the demo's sandbox (stage 8; docs/business.md §13.3, §14.6):
// the start, while the worker loads the engine's Python code, its database
// and the schema in this browser; the demo's controls and its "Try this" in
// the rail; and at the foot of every page the line on where the data stays,
// with the panel about the sandbox and Start over. On the console served
// with a gateway, none of it shows.
import { SANDBOX, SOURCE_URL } from "design";
import { Icon } from "design/icon";
import { useQueryClient } from "@tanstack/react-query";
import { LAUNCH_STEPS, type LaunchStep } from "sandbox/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { ChangeDocument, LaunchRunsDocument } from "../graphql/generated.ts";
import { currentStep, type GuideFacts, guideSteps, NO_FACTS, recoveredFrom } from "../lib/guide.ts";
import { useGatewayQuery } from "../lib/react/gateway.tsx";
import { DEMO_STATUS_KEY, recordGuide, useDemoStatus, useGuideRecord, useSandbox, useSandboxStatus } from "../lib/react/sandbox.tsx";
import { runCommand, type Sandbox } from "../lib/sandbox.ts";
import { formatInstantIn } from "../lib/time.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { Button, Callout } from "./ui.tsx";

/** Where the console writes "now" in the demo: Rome, as everywhere else. */
const ZONE = "Europe/Rome";
const RELOADED = "console-sandbox-reloaded-for-build";

/** The demo starting in this browser, or why it cannot; nothing once it is ready. */
export function SandboxStart() {
  const sandbox = useSandbox();
  if (sandbox === null) return null;
  return <Start sandbox={sandbox} />;
}

function Start({ sandbox }: { readonly sandbox: Sandbox }) {
  const status = useSandboxStatus(sandbox);
  // Another deploy's worker: reload once to meet it; if the same comes back, say so.
  const otherBuild = status.state === "other-build" ? status.info.build : null;
  let reloadedOnce = false;
  try {
    reloadedOnce = otherBuild !== null && window.sessionStorage.getItem(RELOADED) === otherBuild;
  } catch {
    reloadedOnce = otherBuild !== null;
  }
  useEffect(() => {
    if (otherBuild === null || reloadedOnce) return;
    try {
      window.sessionStorage.setItem(RELOADED, otherBuild);
    } catch {
      return;
    }
    window.location.reload();
  }, [otherBuild, reloadedOnce]);

  if (status.state === "ready" || (status.state === "other-build" && !reloadedOnce)) return null;
  if (status.state === "starting") {
    const share = status.of > 0 ? Math.round((status.done / status.of) * 100) : 0;
    return (
      <section className="grid max-w-2xl gap-3 border border-cord bg-stone-0 px-5 py-4" role="status" aria-live="polite" data-sandbox="starting" aria-labelledby="sandbox-start">
        <h2 id="sandbox-start" className="flex items-center gap-2 text-2xl font-bold"><Icon name="hourglass-medium" size={20} className="text-indigo" />Starting the demo in this browser</h2>
        <p className="max-w-[65ch]">{status.step ?? "The first visit takes a few seconds: the engine's Python code, its database and the schema load from this page's own files."}</p>
        <div
          className="h-2.5 w-full max-w-md bg-stone-2 shadow-[inset_0_2px_0_var(--color-edge)]"
          role="progressbar"
          aria-label="Starting the demo"
          aria-valuemin={0}
          aria-valuemax={Math.max(status.of, 1)}
          aria-valuenow={status.done}
          aria-valuetext={status.of > 0 ? `Step ${status.done} of ${status.of}` : "Starting"}
        >
          <div className="h-full bg-silk-indigo shadow-[inset_0_2px_0_var(--color-indigo)]" style={{ width: `${share}%` }} />
        </div>
        <p className="text-xs text-ink-2">{status.of > 0 ? `Step ${status.done} of ${status.of}. ` : ""}Nothing is sent anywhere: everything runs here, and the next tab of the demo is ready at once.</p>
      </section>
    );
  }
  const reason = status.state === "other-build"
    ? "This page belongs to another version of the demo than the one running in this browser, and reloading did not bring them together."
    : status.browser
      ? `This browser has no ${status.reason} here, which the demo needs. A recent Chrome, Edge, Firefox or Safari has it, outside a private window, which can refuse the storage the demo keeps its data in.`
      : `The demo's engine stopped while it started: ${status.reason}.`;
  return (
    <Callout tone="error" icon="warning" role="alert" className="max-w-2xl" >
      <p className="font-bold" data-sandbox="failed">The demo cannot run in this browser</p>
      <p>{reason}</p>
      <Button size="small" icon="arrows-clockwise" className="mt-2" onClick={() => window.location.reload()}>Reload the page</Button>
    </Callout>
  );
}

/** Start over: asks once, then the demo goes back to its first data in every tab; the worker tells each, and each reloads. */
function useStartOver(sandbox: Sandbox) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setFailed(null);
    // Done, the worker tells every tab and each reloads: until then the dialog stays busy.
    try {
      const answer = await runCommand(sandbox, "reset");
      if (!answer.ok) {
        setFailed(answer.error);
        setBusy(false);
      }
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  return { asking, busy, failed, ask: () => setAsking(true), cancel: () => setAsking(false), confirm };
}

function StartOverDialog({ open, busy, failed, onCancel, onConfirm }: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly failed: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<void>;
}) {
  const about = SANDBOX.about;
  return (
    <ConfirmDialog open={open} title={`${about.startOver}?`} confirmLabel={busy ? about.startingOver : about.confirmAction} confirmIcon="arrow-counter-clockwise" cancelLabel={about.keep} busy={busy} onCancel={onCancel} onConfirm={onConfirm}>
      <p>{about.confirm}</p>
      {failed ? <Callout tone="error" icon="warning" role="alert"><p>{failed}</p></Callout> : null}
    </ConfirmDialog>
  );
}

/** The foot of every page in the demo: where the data stays, and the panel about the sandbox with Start over. */
export function SandboxFoot() {
  const sandbox = useSandbox();
  if (sandbox === null) return null;
  return <Foot sandbox={sandbox} />;
}

function Foot({ sandbox }: { readonly sandbox: Sandbox }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const startOver = useStartOver(sandbox);
  const about = SANDBOX.about;
  return (
    <footer className="mt-auto grid gap-2 border-t border-cord px-4 py-4 text-sm text-ink-2 md:px-6 2xl:px-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="max-w-[90ch]">
          {SANDBOX.line.before}
          <a href={SOURCE_URL} rel="noopener">{SANDBOX.line.link}</a>
          {SANDBOX.line.after}
        </p>
        <Button size="small" weight="quiet" icon="info" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((was) => !was)}>{about.title}</Button>
      </div>
      <section id={panel} hidden={!open} aria-label={about.title} className="grid gap-3 border border-cord bg-stone-0 px-4 py-3 text-ink">
        <dl className="m-0 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[about.where, about.reset, about.limits, about.simulated, about.real].map((part) => (
            <div key={part.title} className="grid gap-0.5">
              <dt className="font-bold">{part.title}</dt>
              <dd className="m-0 text-sm">{part.text}</dd>
            </div>
          ))}
          <div className="grid gap-0.5">
            <dt className="font-bold">{about.notices.title}</dt>
            <dd className="m-0 text-sm">{about.notices.before}<a href={about.notices.href}>{about.notices.link}</a></dd>
          </div>
        </dl>
        <Button size="small" icon="arrow-counter-clockwise" className="justify-self-start" onClick={startOver.ask}>{about.startOver}</Button>
      </section>
      <StartOverDialog open={startOver.asking} busy={startOver.busy} failed={startOver.failed} onCancel={startOver.cancel} onConfirm={startOver.confirm} />
    </footer>
  );
}

/** The demo's "Try this" and its controls, in the rail. */
export function DemoPanel({ shown }: { readonly shown: boolean }) {
  const sandbox = useSandbox();
  if (sandbox === null) return null;
  return <Panel sandbox={sandbox} shown={shown} />;
}

function Panel({ sandbox, shown }: { readonly sandbox: Sandbox; readonly shown: boolean }) {
  const status = useSandboxStatus(sandbox);
  const ready = status.state === "ready";
  return (
    <div className={`${shown ? "grid" : "hidden"} w-full gap-4 border-t border-rail-line pt-3 lg:grid lg:px-2.5`}>
      {ready ? <TryThis /> : null}
      {ready ? <Controls sandbox={sandbox} /> : null}
      {/* A demo that could not start says why on the page itself; here, only while it starts. */}
      {status.state === "starting" ? <p className="text-xs text-rail-ink-2">The demo's controls come once it has started.</p> : null}
    </div>
  );
}

/** The steps of the recruiter's path, ticking themselves as they happen. */
function TryThis() {
  const record = useGuideRecord();
  const change = useGatewayQuery(ChangeDocument, { id: record.changeId ?? "" }, { enabled: record.changeId !== null });
  const launches = useGatewayQuery(LaunchRunsDocument, { filter: { changeId: record.changeId ?? "" }, first: 5, after: null }, { enabled: record.changeId !== null });
  const found = change.data?.change ?? null;
  const facts: GuideFacts = found === null ? NO_FACTS : {
    state: found.state,
    signed: found.approvals.length > 0,
    recovered: (launches.data?.launches.nodes ?? []).some(recoveredFrom),
  };
  const steps = guideSteps(record, facts);
  const now = currentStep(steps);
  const live = facts.state === "ACTIVE";
  const headingId = useId();
  return (
    <section className="grid gap-2" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-sm font-bold text-rail-ink">Try this</h2>
      <ol className="m-0 grid list-none gap-1.5 p-0 text-xs leading-snug">
        {steps.map((step, index) => {
          const here = step.id === now;
          return (
            <li key={step.id} className={`grid grid-cols-[1rem_minmax(0,1fr)] gap-x-1.5 ${here ? "font-semibold text-rail-ink" : "text-rail-ink-2"}`} {...(here ? { "aria-current": "step" as const } : {})}>
              <Icon name={step.done ? "check-circle" : here ? "arrow-right" : "circle-dashed"} size={15} className={step.done ? "text-rail-ink" : ""} />
              <span>
                <span className="sr-only">{step.done ? "Done: " : here ? "Next: " : "Then: "}</span>
                {index + 1}. {step.words}
                {step.id === "site" ? <> <a className="text-rail-ink underline underline-offset-2" href="/" target="_blank" rel="noopener" onClick={() => recordGuide({ siteOpened: true })}>Open the site</a></> : null}
                {step.id === "found" && live ? <> <a className="text-rail-ink underline underline-offset-2" href="/" target="_blank" rel="noopener" onClick={() => recordGuide({ foundOnSite: true })}>Open the site again</a></> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {now === null ? <p className="text-xs text-rail-ink">Every step is done. Start over to see it again from the start.</p> : null}
    </section>
  );
}

/** The demo's commands: skip to the next launch due, a simulated fault in a launch's step, and Start over. */
function Controls({ sandbox }: { readonly sandbox: Sandbox }) {
  const status = useDemoStatus(sandbox, true);
  const client = useQueryClient();
  const [step, setStep] = useState<LaunchStep>("publish");
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<"skip" | "arm" | "clear" | null>(null);
  const startOver = useStartOver(sandbox);
  const stepId = useId();
  const headingId = useId();
  const saidRef = useRef<HTMLParagraphElement>(null);
  const demo = status.data ?? null;

  const act = async (kind: "skip" | "arm" | "clear") => {
    setBusy(kind);
    setSaid(null);
    try {
      if (kind === "skip") {
        // The clock stops at the change's start, its launch already run (through the simulated fault, when one was armed).
        const armed = status.data?.armed ?? null;
        const answer = await runCommand(sandbox, "skip-to-next-launch");
        setSaid(answer.ok
          ? `The demo's clock moved from ${formatInstantIn(answer.result.from, ZONE)} to ${formatInstantIn(answer.result.to, ZONE)}, the change's start: its launch ran${armed ? `, met the simulated fault at ${armed} and recovered` : ""}. Launches show it step by step.`
          : answer.error);
      } else if (kind === "arm") {
        const answer = await runCommand(sandbox, "arm-fault", { step });
        if (!answer.ok) setSaid(answer.error);
      } else {
        const answer = await runCommand(sandbox, "clear-fault");
        if (!answer.ok) setSaid(answer.error);
      }
    } catch (error) {
      setSaid(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
      await client.invalidateQueries({ queryKey: DEMO_STATUS_KEY });
    }
  };

  return (
    <section className="grid gap-2.5" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-sm font-bold text-rail-ink">Demo controls</h2>
      <div className="grid gap-1">
        <button type="button" className="btn btn--small justify-start border-rail-ink-2 bg-transparent text-rail-ink" disabled={busy !== null || demo === null || demo.nextDue === null} onClick={() => void act("skip")} aria-describedby={`${headingId}-due`}>
          <Icon name="skip-forward" size={16} />
          Skip to the launch
        </button>
        <p id={`${headingId}-due`} className="text-2xs text-rail-ink-2">
          {demo === null ? "Reading the demo's clock." : demo.nextDue === null ? "No launch is due: schedule an approved change first." : `The next launch is due ${formatInstantIn(demo.nextDue, ZONE)}.`}
        </p>
      </div>
      <div className="grid gap-1">
        {demo?.armed ? (
          <>
            <p className="text-xs text-rail-ink"><b>Fault armed at {demo.armed}.</b> The next launch fails there once, and the engine's own code recovers it.</p>
            <button type="button" className="btn btn--small justify-start border-rail-ink-2 bg-transparent text-rail-ink" disabled={busy !== null} onClick={() => void act("clear")}>
              <Icon name="x" size={16} />
              Clear the fault
            </button>
          </>
        ) : (
          <>
            <label htmlFor={stepId} className="text-xs text-rail-ink-2">Cause a fault at the step</label>
            <div className="flex gap-1.5">
              <select id={stepId} className="rail-select min-w-0 flex-1" value={step} onChange={(event) => setStep(event.target.value as LaunchStep)}>
                {LAUNCH_STEPS.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <button type="button" className="btn btn--small border-rail-ink-2 bg-transparent text-rail-ink" disabled={busy !== null} onClick={() => void act("arm")}>
                <Icon name="warning" size={16} />
                Arm
              </button>
            </div>
          </>
        )}
        <p className="text-2xs text-rail-ink-2">Simulated, and said so: real faults run on the full system (§14.6).</p>
      </div>
      {said ? <p ref={saidRef} className="text-xs text-rail-ink" role="status">{said}</p> : null}
      <button type="button" className="btn btn--small justify-start border-rail-ink-2 bg-transparent text-rail-ink" onClick={startOver.ask}>
        <Icon name="arrow-counter-clockwise" size={16} />
        {SANDBOX.about.startOver}
      </button>
      <StartOverDialog open={startOver.asking} busy={startOver.busy} failed={startOver.failed} onCancel={startOver.cancel} onConfirm={startOver.confirm} />
    </section>
  );
}
