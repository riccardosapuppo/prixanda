"use client";
// The parts every guided form of a change shares, so that a price migration
// and a prepaid pass read like the guided creation of a campaign: the steps
// across the top, the engine's findings with the way back to the step that
// fixes each one, who has to sign, a refusal said in the engine's words, the
// panel that appears when someone else saved a newer version (§6.3), and what
// a page of a change says when the markets, and their time zones, did not
// load.
import { Icon } from "design/icon";
import type { ReactNode } from "react";
import { signerWords } from "../lib/permissions.ts";
import { formatInstantIn } from "../lib/time.ts";
import { CONSOLE_ZONE } from "./frame.tsx";
import { Button, Callout, Chip, ErrorPanel } from "./ui.tsx";

/**
 * The markets did not load, and with them their time zones. A page that
 * shows a change's times, or schedules its launch, waits for them: a local
 * time read in UTC instead of its market's would be off by an hour or two,
 * and nothing says so. The page says what is missing, with Try again.
 */
export function MarketsUnavailable({ error, retry }: { readonly error: unknown; readonly retry: () => void }) {
  return (
    <div className="grid max-w-3xl gap-3">
      <p className="max-w-[65ch]">
        The markets did not load, and with them their time zones: this page shows no times, and nothing can be scheduled from it, until they do.
      </p>
      <ErrorPanel error={error} retry={retry} />
    </div>
  );
}

/** The steps of a guided form: each a button, the current one marked for assistive technology, the done ones woven. */
export function Steps({ names, current, done, onStep }: {
  readonly names: readonly string[];
  readonly current: number;
  readonly done: (index: number) => boolean;
  readonly onStep: (index: number) => void;
}) {
  return (
    <ol className="m-0 grid list-none gap-1 p-0" style={{ gridTemplateColumns: `repeat(${names.length}, minmax(0, 1fr))` }} aria-label="Steps">
      {names.map((name, index) => {
        const finished = index < current && done(index);
        const here = index === current;
        return (
          <li key={name}>
            <button type="button" onClick={() => onStep(index)} className="grid w-full gap-0.5 border-0 bg-transparent p-0 pb-1.5 text-left" {...(here ? { "aria-current": "step" as const } : {})}>
              <span className={`mb-1.5 block h-2.5 ${finished ? "bg-silk-indigo shadow-[inset_0_2px_0_var(--color-indigo)]" : here ? "weave-open bg-stone-0 shadow-[inset_0_2px_0_var(--color-ink)]" : "bg-stone-2 shadow-[inset_0_2px_0_var(--color-edge)]"}`} />
              <span className="flex items-baseline gap-1.5 text-md font-bold">
                <span className={`font-semibold ${here ? "text-ink underline decoration-2 underline-offset-4 lg:no-underline" : "text-ink-2"}`}>{index + 1}</span>
                <span className={`max-lg:sr-only ${here ? "lg:underline lg:decoration-2 lg:underline-offset-4" : ""}`}>{name}</span>
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-ink-2 max-lg:hidden">
                {finished ? <><Icon name="check" size={13} />Done</> : here ? "Now" : "Next"}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export type Finding = {
  readonly check: string;
  readonly severity: string;
  readonly market: string | null;
  readonly message: string;
};

/** What the engine checked in a version: each finding, and for one that blocks, the step that fixes it. */
export function Findings({ version, findings, stepOf, stepNames, onGoTo, none }: {
  readonly version: number;
  readonly findings: readonly Finding[];
  readonly stepOf: Readonly<Record<string, number>>;
  readonly stepNames: readonly string[];
  readonly onGoTo: (step: number) => void;
  readonly none: ReactNode;
}) {
  return (
    <section className="grid gap-2" aria-labelledby="checks-heading">
      <h3 id="checks-heading" className="text-base font-bold">What the engine checked in v{version}</h3>
      <ul role="list" className="grid">
        {findings.length === 0 ? <li className="py-2 text-ink-2">{none}</li> : null}
        {findings.map((finding, index) => {
          const step = finding.severity === "BLOCKING" ? stepOf[finding.check] : undefined;
          return (
            <li key={index} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 border-b border-cord py-2" data-check={finding.check}>
              <Icon name={finding.severity === "BLOCKING" ? "x-circle" : finding.severity === "NEEDS_SIGNATURE" ? "signature" : "info"} size={18} className={`mt-0.5 ${finding.severity === "BLOCKING" ? "text-madder" : "text-indigo"}`} />
              <span>
                <b>{finding.severity === "BLOCKING" ? "Blocks the submission" : finding.severity === "NEEDS_SIGNATURE" ? "Asks for a signature" : "For information"}</b>: {finding.message}
                {step !== undefined ? (
                  <> <button type="button" className="font-semibold text-indigo underline underline-offset-4" onClick={() => onGoTo(step)}>Go to step {step + 1}, {stepNames[step]}</button></>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export type Signature = { readonly role: string; readonly conditions: readonly number[]; readonly why: string; readonly signed: boolean };

/** Who has to sign a version, and why, in the engine's words (§7.3). */
export function SignaturesList({ signatures }: { readonly signatures: readonly Signature[] }) {
  return (
    <ul role="list" className="grid gap-1.5">
      {signatures.map((signature) => (
        <li key={signature.role} className="flex flex-wrap items-center gap-2">
          {signature.signed ? <Chip look="done" icon="check-circle">Signed</Chip> : <Chip look="waiting" icon="hourglass-medium">{signerWords(signature as Parameters<typeof signerWords>[0], { start: true })}</Chip>}
          <span className="text-sm">{signature.why}</span>
        </li>
      ))}
    </ul>
  );
}

/** A refusal of the engine, said as an answer: its code in words, and its sentence. */
export function RefusalCallout({ refusal }: { readonly refusal: { readonly code: string; readonly reason: string } }) {
  return (
    <Callout tone="error" icon="warning" role="alert">
      <p className="font-bold">The engine said no ({refusal.code.toLowerCase().replaceAll("_", " ")}).</p>
      <p>{refusal.reason}</p>
    </Callout>
  );
}

/** Someone saved a newer version while this form was open: their version is untouched, and the person chooses (§6.3). */
export function ConflictPanel({ conflict, startedFrom, onLoad }: {
  readonly conflict: { readonly currentVersion: number; readonly current: { readonly author: { readonly label: string }; readonly createdAt: string } };
  readonly startedFrom: number;
  readonly onLoad: () => void;
}) {
  return (
    <Callout tone="error" icon="warning" role="alert">
      <p className="font-bold">Someone saved v{conflict.currentVersion} while you were editing v{startedFrom}.</p>
      <p>{conflict.current.author.label} saved it on {formatInstantIn(conflict.current.createdAt, CONSOLE_ZONE)}. Your edits are still in the form and were not saved: nothing overwrote their version (§6.3).</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="small" icon="arrows-clockwise" onClick={onLoad}>Load v{conflict.currentVersion} and drop my edits</Button>
      </div>
    </Callout>
  );
}
