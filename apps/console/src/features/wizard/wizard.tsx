"use client";
// The guided creation of a campaign, in five steps: who can take it, the
// price, the dates, the page, then the check and the submission (business
// book §6). Beside the form, the page as the site would show it. Who can
// take it may be narrowed to the fans of an artist (§14.2): the artist from
// the catalog, more than a number of hours of their music in a window of
// days; the engine counts them in the listening data when the version is
// checked.
//
// What a step checks before Continue is only what cannot mean anything (an
// empty name, a price that is not a price, a time the clocks skip). The
// business checks are the engine's: in step 5 the console saves the version
// and asks the engine to validate it, then shows the change in business
// words, every finding, the eligible people counted in the data and who has
// to sign. Saving makes a new version; a version someone else saved first
// comes back as a conflict, never overwritten (§6.3).
//
// Only Marketing creates and submits campaigns (§12): the other roles read
// the same steps with the fields read-only, no Save draft, and a line that
// says why; a role that reviews finds the way to Approvals.
import { formatMoney } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ConflictPanel, Findings, Steps } from "../../components/change-parts.tsx";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Button, ButtonLink, Callout, Chip, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import {
  ChangeDocument, type ChangeQuery, CreateOfferDocument, MarketsDocument, type MarketsQuery, PlansDocument, SaveOfferVersionDocument,
  SubmitChangeDocument, ValidateChangeDocument,
} from "../../graphql/generated.ts";
import { MARKET_ORDER, planName } from "../../lib/markets.ts";
import {
  cannotCarry, checkStep, differsFrom, emptyForm, emptyMarket, FANS_WINDOW_DAYS, formFromContent, LIMITS, type MarketFacts, type MarketForm,
  marketField, type OfferContent, type OfferForm, parseHours, type Problem, type Segment, STEPS, type StepIndex, stepOfField, toInput,
} from "../../lib/offer-form.ts";
import { listeningWords } from "../../lib/diff.ts";
import { approvalHref } from "../../lib/kinds.ts";
import { recordGuide } from "../../lib/react/sandbox.tsx";
import { SANDBOX_MODE } from "../../lib/sandbox.ts";
import { asRole, can, conditionSigner, primaryRole, signatureWords, signerWords, whoDoes } from "../../lib/permissions.ts";
import { useClock } from "../../lib/react/clock.tsx";
import { useAction, useGatewayQueries, useGatewayQuery, useRefreshChanges } from "../../lib/react/gateway.tsx";
import { useViewer } from "../../lib/react/session.tsx";
import { formatInstantIn, formatLocalValue, formatLocalWithUtc, nextWeekday, parseLocal, partsIn, zoneCity } from "../../lib/time.ts";
import { CampaignTabs } from "../campaigns/tabs.tsx";
import { ArtistPicker, useArtistNames } from "./artists.tsx";
import { ChoiceGroup, SelectField, TextAreaField, TextField } from "./fields.tsx";
import { type PreviewPlan, SitePreview } from "./preview.tsx";

type Change = NonNullable<ChangeQuery["change"]>;
type Market = MarketsQuery["markets"][number];
type ResultUnion = { readonly __typename: "Change" } & Change | { readonly __typename: "Refusal"; readonly code: string; readonly reason: string; readonly facts: readonly { readonly name: string; readonly value: string }[]; readonly change: Change | null };

const PAID_PLANS = ["individual", "duo", "family", "student"] as const;
const EDITABLE_STATES = new Set(["DRAFT", "VALIDATED", "IN_APPROVAL", "APPROVED"]);
const STEP_OF_CHECK: Readonly<Record<string, StepIndex>> = {
  floor: 1, overlap: 0, conflict: 0, dates: 2, time_zone: 2, audience: 0, page_text: 3, signatures: 4,
};

/** The saved content without GraphQL's __typename fields, as the form compares it. */
function stripTypename(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTypename);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "__typename").map(([key, entry]) => [key, stripTypename(entry)]));
}

function stepFromSearch(value: string | null): StepIndex {
  const number = Number(value ?? "1");
  return (Number.isInteger(number) && number >= 1 && number <= 5 ? number - 1 : 0) as StepIndex;
}

function offerContent(change: Change | null | undefined): OfferContent | null {
  const content = change?.current.content;
  return content && content.__typename === "OfferContent" ? (content as unknown as OfferContent) : null;
}

/** The example the demo starts from: the Student Autumn Pass of the business book (§14.1). */
export function autumnExample(now: Date): OfferForm {
  const today = partsIn(now, "Europe/Rome");
  const monday = nextWeekday({ ...today, second: 0 }, 1, 9);
  return {
    title: "Student Autumn Pass",
    plan: "student",
    segment: "NEVER_PAID",
    currentPlan: "",
    needsStudentCheck: true,
    group: "student-offers",
    cap: "",
    months: "3",
    fans: false,
    artist: "",
    hours: "",
    days: String(FANS_WINDOW_DAYS),
    markets: [{
      ...emptyMarket("IT", formatLocalValue(monday)),
      fixed: "2.99",
      pageTitle: "Student Autumn Pass",
      pageText: "Three months of Student for 2,99 € a month. Then 5,79 €, the usual Student price.",
      pageTerms: "For verified students in Italy who have never paid for a plan. Three months at 2,99 €, then the Student list price in force. Not combinable with other student offers.",
    }],
  };
}

/**
 * The album release of the business book (§14.2): two months of Individual
 * at €1.99 for the fans of Doppelfenster on Free in Germany (the catalog's
 * artist 4 in the generated data), from the next Friday at midnight in
 * Berlin, when records come out.
 */
export function releaseExample(now: Date): OfferForm {
  const friday = nextWeekday({ ...partsIn(now, "Europe/Berlin"), second: 0 }, 5, 0);
  return {
    title: "Nordflur release",
    plan: "individual",
    segment: "FREE_LISTENERS",
    currentPlan: "",
    needsStudentCheck: false,
    group: "release-offers",
    cap: "1500",
    months: "2",
    fans: true,
    artist: "4",
    hours: "3",
    days: String(FANS_WINDOW_DAYS),
    markets: [{
      ...emptyMarket("DE", formatLocalValue(friday)),
      fixed: "1.99",
      pageTitle: "Nordflur is out",
      pageText: "Two months of Individual for 1,99 € a month, for the listeners who kept Doppelfenster on repeat. Then 10,99 €, the usual Individual price.",
      pageTerms: "For listeners on Free in Germany who played Doppelfenster for more than 3 hours in the last 30 days. Two months at 1,99 €, then the Individual list price in force. At most 1,500 redemptions. Not combinable with other release offers.",
    }],
  };
}

export function Wizard({ changeId }: { readonly changeId: string | null }) {
  const viewer = useViewer();
  const clock = useClock();
  const router = useRouter();
  const search = useSearchParams();
  const step = stepFromSearch(search.get("step"));
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const change = useGatewayQuery(ChangeDocument, { id: changeId ?? "" }, { enabled: changeId !== null });

  const loaded = changeId === null ? null : change.data?.change ?? null;
  if (markets.isError) return <WizardFrame changeId={changeId} title="New campaign"><ErrorPanel error={markets.error} retry={() => void markets.refetch()} /></WizardFrame>;
  if (changeId !== null && change.isError) return <WizardFrame changeId={changeId} title="Campaign"><ErrorPanel error={change.error} retry={() => void change.refetch()} /></WizardFrame>;
  if (markets.isPending || (changeId !== null && change.isPending)) return <WizardFrame changeId={changeId} title="Campaign"><Loading what="the campaign" lines={8} /></WizardFrame>;
  if (changeId !== null && loaded === null) {
    return <WizardFrame changeId={changeId} title="Campaign"><Callout icon="warning" tone="error">There is no change #{changeId}. <Link href="/campaigns/">Back to the campaigns</Link>.</Callout></WizardFrame>;
  }
  return <WizardForm key={changeId ?? "new"} change={loaded} markets={markets.data.markets} step={step} viewerCanEdit={can(viewer.roles, "editOffer")} now={clock.now()} onStep={(next, id) => {
    const params = new URLSearchParams();
    if (id ?? changeId) params.set("id", id ?? changeId ?? "");
    params.set("step", String(next + 1));
    router.push(`${id ?? changeId ? "/campaigns/edit/" : "/campaigns/new/"}?${params.toString()}`, { scroll: false });
  }} onCreated={(id) => router.replace(`/campaigns/edit/?id=${id}&step=${step + 1}`, { scroll: false })} />;
}

function WizardFrame({ changeId, title, sub, children }: { readonly changeId: string | null; readonly title: ReactNode; readonly sub?: ReactNode; readonly children: ReactNode }) {
  return (
    <>
      <PageHead
        crumbs={[{ label: "Campaigns", href: "/campaigns/" }, { label: changeId === null ? "New campaign" : `Change #${changeId}` }]}
        title={title}
        {...(sub ? { sub } : {})}
      />
      <PageBody className="gap-6">
        <CampaignTabs changeId={changeId} current="campaign" />
        {children}
      </PageBody>
    </>
  );
}

function WizardForm({ change, markets, step, viewerCanEdit, now, onStep, onCreated }: {
  readonly change: Change | null;
  readonly markets: readonly Market[];
  readonly step: StepIndex;
  readonly viewerCanEdit: boolean;
  readonly now: Date;
  readonly onStep: (step: StepIndex, createdId?: string) => void;
  readonly onCreated: (id: string) => void;
}) {
  const viewer = useViewer();
  const refresh = useRefreshChanges();
  // The version the form was loaded from, and its content: what a save starts
  // from (§6.3). It moves only after a save of ours or a reload the person
  // asks for, never because the query read a newer version in the meantime.
  const [base, setBase] = useState<{ readonly version: number; readonly content: OfferContent | null }>(() => ({ version: change?.currentVersion ?? 0, content: offerContent(change) }));
  // The base as it is now, for an answer that arrives after the person moved it.
  const baseNow = useRef(base);
  const moveBase = (next: { readonly version: number; readonly content: OfferContent | null }) => {
    baseNow.current = next;
    setBase(next);
  };
  const saved = base.content;
  const [form, setForm] = useState<OfferForm>(() => (saved ? formFromContent(saved) : emptyForm()));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [staleRefusal, setStaleRefusal] = useState<Change | null>(null);
  // A version newer than the one the form started from: someone else saved it.
  const newer = change !== null && change.currentVersion > base.version ? change : null;
  const conflict = staleRefusal ?? newer;
  const [outcome, setOutcome] = useState<{ readonly kind: "saved" | "submitted"; readonly version: number } | null>(null);
  const [refusal, setRefusal] = useState<{ readonly code: string; readonly reason: string } | null>(null);
  const [reason, setReason] = useState(change?.authorReason ?? "");
  const [reasonTouched, setReasonTouched] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const facts: MarketFacts = useMemo(() => Object.fromEntries(markets.map((market) => [market.code, { currency: market.currency, timeZone: market.timeZone, name: market.name }])), [markets]);
  const editableState = change === null || EDITABLE_STATES.has(change.state);
  // A version holding something the form does not know is read here, never saved from here.
  const uncarried = change === null ? null : cannotCarry(change.current.content.__typename === "OfferContent" ? stripTypename(change.current.content) : null);
  const canEdit = viewerCanEdit && editableState && uncarried === null;
  const dirty = canEdit && differsFrom(form, saved, facts);
  const role = primaryRole(viewer.roles);

  // The plans of every market the campaign is for: the page beside the form shows any of them.
  const plansByMarket = useGatewayQueries(PlansDocument, form.markets.map((entry) => ({ market: entry.market })), { staleTime: 5 * 60_000 });
  const previewPlans: Record<string, readonly PreviewPlan[]> = {};
  form.markets.forEach((entry, index) => {
    const plans = plansByMarket[index]?.data?.plans;
    if (plans) previewPlans[entry.market] = plans.map((plan) => ({ code: plan.code, name: plan.name, listPrice: plan.listPrice, needsStudentCheck: plan.entitlements.needsStudentCheck }));
  });

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const problems = checkStep(form, step, facts, now);
  const shown = (field: string) => (touched.has(field) ? problems.find((problem) => problem.field === field)?.message ?? null : null);
  const touch = (field: string) => setTouched((current) => new Set(current).add(field));
  const update = (patch: Partial<OfferForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setOutcome(null);
  };
  const updateMarket = (market: string, patch: Partial<MarketForm>) => {
    setForm((current) => ({ ...current, markets: current.markets.map((entry) => (entry.market === market ? { ...entry, ...patch } : entry)) }));
    setOutcome(null);
  };

  const create = useAction(CreateOfferDocument, "create-offer");
  const save = useAction(SaveOfferVersionDocument, "save-offer-version");
  const validate = useAction(ValidateChangeDocument, "validate-change");
  const submit = useAction(SubmitChangeDocument, "submit-change");
  // From the click to the check's answer, the version being checked is the only one: no second click creates another.
  const [checking, setChecking] = useState(false);
  // From the click that creates the change until its own page opens, the
  // fields wait: that page starts from what was saved, so anything typed
  // meanwhile would be lost without a word. The page says it is saving.
  const [creating, setCreating] = useState(false);
  const busy = checking || creating || create.isPending || save.isPending || validate.isPending || submit.isPending;
  const locked = !canEdit || creating;
  const failure = create.error ?? save.error ?? validate.error ?? submit.error;

  /** Saves the form as a new version when it differs; returns the change and its version, or null when nothing could be saved. */
  async function persist(options: { readonly open?: boolean } = {}): Promise<{ id: string; version: number; created: boolean } | null> {
    setRefusal(null);
    const typed = toInput(form, facts);
    if ("problems" in typed) {
      setTouched(new Set(typed.problems.map((problem) => problem.field)));
      return null;
    }
    if (change === null) {
      setCreating(true);
      let result: ResultUnion;
      try {
        result = (await create.mutateAsync({ offer: typed.input })).createOffer as ResultUnion;
      } catch (error) {
        setCreating(false);
        throw error;
      }
      if (result.__typename === "Refusal") {
        setCreating(false);
        setRefusal({ code: result.code, reason: result.reason });
        return null;
      }
      await refresh();
      // In the demo, "Try this" follows the campaign created here (lib/guide.ts).
      if (SANDBOX_MODE) recordGuide({ changeId: result.id });
      // Checking opens the new change only once its validation is stored (onCheck).
      if (options.open !== false) onCreated(result.id);
      return { id: result.id, version: result.currentVersion, created: true };
    }
    if (conflict === null && !dirty) return { id: change.id, version: base.version, created: false };
    const result = (await save.mutateAsync({ changeId: change.id, baseVersion: base.version, offer: typed.input })).saveOfferVersion as ResultUnion;
    if (result.__typename === "Refusal") {
      // A refusal names the version that made this save stale. If the person
      // has loaded that version since (the answer came late), the conflict is
      // already settled: it does not come back.
      if (result.code === "STALE_VERSION" && result.change) {
        if (result.change.currentVersion > baseNow.current.version) setStaleRefusal(result.change);
      } else setRefusal({ code: result.code, reason: result.reason });
      return null;
    }
    moveBase({ version: result.currentVersion, content: offerContent(result) });
    setStaleRefusal(null);
    await refresh();
    return { id: result.id, version: result.currentVersion, created: false };
  }

  async function onSave() {
    const done = await persist().catch(() => null);
    if (done) setOutcome({ kind: "saved", version: done.version });
  }

  async function onContinue() {
    if (problems.length) {
      setTouched((current) => new Set([...current, ...problems.map((problem) => problem.field)]));
      const first = problems[0];
      if (first) document.getElementById(first.field)?.focus();
      return;
    }
    onStep(Math.min(step + 1, 4) as StepIndex);
  }

  async function onCheck() {
    if (checking) return;
    setChecking(true);
    try {
      const all = checkStep(form, 4, facts, now);
      if (all.length) {
        setTouched(new Set(all.map((problem) => problem.field)));
        return;
      }
      const done = await persist({ open: false }).catch(() => null);
      if (done === null) return;
      const result = (await validate.mutateAsync({ changeId: done.id, version: done.version }).catch(() => null))?.validateChange as ResultUnion | undefined;
      if (result && result.__typename === "Refusal" && result.code !== "INVALID") setRefusal({ code: result.code, reason: result.reason });
      await refresh();
      if (done.created) onCreated(done.id);
    } finally {
      setChecking(false);
    }
  }

  async function onSubmit() {
    if (change === null) return;
    setReasonTouched(true);
    const needsReason = change.requiredSignatures.some((signature) => signature.conditions.includes(4));
    if (needsReason && reason.trim() === "") {
      document.getElementById("author-reason")?.focus();
      return;
    }
    if (conflict !== null) return;
    const result = (await submit.mutateAsync({ changeId: change.id, version: base.version, authorReason: reason.trim() || null }).catch(() => null))?.submitChange as ResultUnion | undefined;
    if (result === undefined) return;
    if (result.__typename === "Refusal") {
      setRefusal({ code: result.code, reason: result.reason });
      return;
    }
    setOutcome({ kind: "submitted", version: result.currentVersion });
    await refresh();
  }

  const title = change ? <>{change.title} <span className="h1-v text-ink-2">v{change.currentVersion}</span></> : form.title ? `New campaign: ${form.title}` : "New campaign";
  const sub = change ? (
    <>
      <StateChip state={change.state} />
      <span>Created by {change.createdBy.label} on {formatInstantIn(change.createdAt, CONSOLE_ZONE, { year: true })}</span>
    </>
  ) : `A draft that only ${whoDoes("editOffer", { one: "changes", many: "change" }, { start: false })}. Nothing reaches the site before approval and activation.`;
  // A role that reviews (signs or sends back) finds where it does so: the approval page.
  const reviews = can(viewer.roles, "approve") || can(viewer.roles, "reject");

  return (
    <WizardFrame changeId={change?.id ?? null} title={title} sub={sub}>
      {uncarried && viewerCanEdit && editableState ? <Locked>{uncarried}</Locked> : null}
      {!viewerCanEdit ? (
        <Locked>
          {whoDoes("createOffer", { one: "creates and submits campaigns", many: "create and submit campaigns" })}.{" "}
          {change === null
            ? `${asRole(role)} you read the campaigns and do not start one.`
            : `${asRole(role)} you read this one, with its fields read-only${reviews ? ", and you review it in Approvals" : ""}.`}
          {change !== null && reviews ? <> <Link href={approvalHref("OFFER", change.id)}>Open v{change.currentVersion} in Approvals</Link></> : null}
        </Locked>
      ) : !editableState && change ? (
        <Locked>This change is {change.state.toLowerCase()}: it takes no new versions. To offer something else, start a new campaign.</Locked>
      ) : change && (change.state === "IN_APPROVAL" || change.state === "APPROVED") ? (
        <Callout icon="info" tone="quiet">v{change.currentVersion} is {change.state === "IN_APPROVAL" ? "in approval" : "approved"}. Saving an edit makes v{change.currentVersion + 1} and takes it back to draft: approvals given to v{change.currentVersion} do not carry over (§7.2).</Callout>
      ) : null}
      {conflict ? <ConflictPanel conflict={conflict} startedFrom={base.version} onLoad={() => {
        const content = offerContent(conflict);
        if (content) setForm(formFromContent(content));
        moveBase({ version: conflict.currentVersion, content });
        setStaleRefusal(null);
        void refresh();
      }} /> : null}
      <Steps names={STEPS} current={step} done={(index) => checkStep(form, index as StepIndex, facts, now).length === 0} onStep={(next) => onStep(next as StepIndex)} />
      <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-12">
        <form className="grid min-w-0 content-start gap-6" noValidate onSubmit={(event) => event.preventDefault()} aria-labelledby="step-heading">
          <div className="grid gap-0.5">
            <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="text-4xl font-bold leading-tight focus-visible:outline-none">{STEPS[step]}</h2>
            <p className="text-xs text-ink-2">Step {step + 1} of 5</p>
          </div>
          {step === 0 ? <StepAudience form={form} markets={markets} disabled={locked} shown={shown} touch={touch} update={update} now={now} /> : null}
          {step === 1 ? <StepPrice form={form} markets={markets} disabled={locked} shown={shown} touch={touch} update={update} updateMarket={updateMarket} /> : null}
          {step === 2 ? <StepDates form={form} markets={markets} disabled={locked} shown={shown} touch={touch} updateMarket={updateMarket} /> : null}
          {step === 3 ? <StepPage form={form} markets={markets} disabled={locked} shown={shown} touch={touch} updateMarket={updateMarket} /> : null}
          {step === 4 ? (
            <StepCheck
              change={change}
              dirty={dirty}
              canEdit={canEdit}
              busy={busy}
              problems={checkStep(form, 4, facts, now)}
              fansDays={form.fans ? Number(form.days) : null}
              reason={reason}
              reasonError={reasonTouched && change !== null && change.requiredSignatures.some((signature) => signature.conditions.includes(4)) && reason.trim() === "" ? `Write why the campaign is worth running: the contribution over 12 months is negative, and ${conditionSigner()} reads this next to the numbers (§7.3, condition 4).` : null}
              onReason={setReason}
              onCheck={() => void onCheck()}
              onSubmit={() => void onSubmit()}
              onGoTo={(next) => onStep(next)}
              outcome={outcome}
            />
          ) : null}
          {refusal ? <Callout tone="error" icon="warning" role="alert"><p className="font-bold">The engine said no ({refusal.code.toLowerCase().replaceAll("_", " ")}).</p><p>{refusal.reason}</p></Callout> : null}
          {failure ? <ErrorPanel error={failure} /> : null}
          {outcome?.kind === "saved" ? <Callout tone="good" icon="check-circle" role="status">Saved as v{outcome.version}.</Callout> : null}
          {creating ? (
            <Callout tone="quiet" icon="hourglass-medium" role="status">
              Saving the new campaign as v1. The fields wait until it is saved, then it opens on its own page, with nothing typed meanwhile lost.
            </Callout>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 border-t border-cord pt-4">
            {step > 0 ? <Button icon="arrow-left" onClick={() => onStep((step - 1) as StepIndex)}>Back</Button> : null}
            {canEdit ? <Button weight="quiet" icon="floppy-disk" busy={creating || save.isPending} onClick={() => void onSave()}>Save draft</Button> : null}
            <span className="flex-1" />
            {step < 4 ? <Button weight="primary" iconAfter="arrow-right" onClick={() => void onContinue()}>Continue</Button> : null}
          </div>
        </form>
        <SitePreview form={form} markets={markets} plans={previewPlans} />
      </div>
    </WizardFrame>
  );
}

type StepProps = {
  readonly form: OfferForm;
  readonly markets: readonly Market[];
  readonly disabled: boolean;
  readonly shown: (field: string) => string | null;
  readonly touch: (field: string) => void;
};

function StepAudience({ form, markets, disabled, shown, touch, update, now }: StepProps & { readonly update: (patch: Partial<OfferForm>) => void; readonly now: Date }) {
  const ordered = MARKET_ORDER.map((code) => markets.find((market) => market.code === code)).filter((market): market is Market => market !== undefined);
  const toggleMarket = (code: string, on: boolean) => {
    const zone = markets.find((market) => market.code === code)?.timeZone ?? "UTC";
    const starts = formatLocalValue(nextWeekday({ ...partsIn(now, zone), second: 0 }, 1, 9));
    update({ markets: on ? [...form.markets, emptyMarket(code, starts)] : form.markets.filter((entry) => entry.market !== code) });
  };
  return (
    <div className="grid gap-5">
      {!disabled && form.title === "" && form.markets.length === 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <Icon name="info" size={15} />
          Starting from scratch, or from an example of the business book:
          <Button size="small" weight="quiet" icon="student" onClick={() => update(autumnExample(now))}>Fill in the Student Autumn Pass</Button>
          <Button size="small" weight="quiet" icon="vinyl-record" onClick={() => update(releaseExample(now))}>Fill in the Nordflur release</Button>
        </p>
      ) : null}
      <TextField id="title" label="Campaign name" hint="How the team finds it; the page has its own title in step 4." value={form.title} disabled={disabled} maxLength={LIMITS.title} error={shown("title")} onChange={(value) => update({ title: value })} onBlur={() => touch("title")} />
      <fieldset className="m-0 grid gap-2 border-0 p-0" id="markets" tabIndex={-1} aria-describedby={shown("markets") ? "markets-error" : undefined}>
        <legend className="label mb-1.5 p-0">Markets</legend>
        <div className="flex flex-wrap gap-2">
          {ordered.map((market) => (
            <label key={market.code} className="choice-card min-w-[9rem] grid-cols-[auto_minmax(0,1fr)]">
              <input type="checkbox" checked={form.markets.some((entry) => entry.market === market.code)} disabled={disabled} onChange={(event) => toggleMarket(market.code, event.target.checked)} onBlur={() => touch("markets")} />
              <span>{market.name}<small className="block text-xs text-ink-2">{market.currency}, {zoneCity(market.timeZone)} time</small></span>
            </label>
          ))}
        </div>
        {shown("markets") ? <p className="field-error" id="markets-error"><Icon name="warning-circle" size={16} />{shown("markets")}</p> : null}
      </fieldset>
      <SelectField id="plan" label="Plan" value={form.plan} disabled={disabled} placeholder="Choose a plan" error={shown("plan")} options={PAID_PLANS.map((plan) => ({ value: plan, label: planName(plan) }))} onChange={(value) => update({ plan: value, needsStudentCheck: value === "student" ? true : form.needsStudentCheck })} onBlur={() => touch("plan")} />
      <ChoiceGroup<Segment>
        id="segment"
        legend="Who can take it"
        value={form.segment}
        disabled={disabled}
        error={shown("segment")}
        onChange={(value) => update({ segment: value })}
        onBlur={() => touch("segment")}
        options={[
          { value: "NEVER_PAID", label: "People who have never paid", detail: "New subscribers only: nobody pays less for what they already have." },
          { value: "FREE_LISTENERS", label: "Listeners on Free now" },
          { value: "SUBSCRIBERS_OF_PLAN", label: "Subscribers of a plan", detail: "For example, Duo subscribers moving to Family." },
        ]}
      />
      {form.segment === "SUBSCRIBERS_OF_PLAN" ? (
        <SelectField id="currentPlan" label="Their plan now" value={form.currentPlan} disabled={disabled} placeholder="Choose a plan" error={shown("currentPlan")} options={PAID_PLANS.map((plan) => ({ value: plan, label: planName(plan) }))} onChange={(value) => update({ currentPlan: value })} onBlur={() => touch("currentPlan")} />
      ) : null}
      {form.segment === "NEVER_PAID" || form.segment === "FREE_LISTENERS" || form.fans ? (
        <FansFields form={form} markets={markets} disabled={disabled} shown={shown} touch={touch} update={update} />
      ) : null}
      <label className="choice-card">
        <input type="checkbox" checked={form.needsStudentCheck} disabled={disabled || form.plan === "student"} onChange={(event) => update({ needsStudentCheck: event.target.checked })} />
        <span>Verified students only<small className="block text-xs text-ink-2">A simulated provider checks the student; a check is valid 12 months (§10). The Student plan always needs it.</small></span>
      </label>
      <div className="grid gap-5 md:grid-cols-2">
        <TextField id="group" label="Group" hint="Offers in the same group never stack (§6.1): lower case, like student-offers." value={form.group} disabled={disabled} error={shown("group")} onChange={(value) => update({ group: value })} onBlur={() => touch("group")} />
        <TextField id="cap" label="Cap on redemptions" hint="Empty: no cap." value={form.cap} disabled={disabled} inputMode="numeric" error={shown("cap")} onChange={(value) => update({ cap: value })} onBlur={() => touch("cap")} />
      </div>
      <p className="flex items-baseline gap-2 text-sm text-ink-2">
        <Icon name="users" size={15} className="translate-y-0.5" />
        How many people this reaches, the engine counts in the data once the version is saved and checked, in step 5: nobody types it (§6.5).
      </p>
    </div>
  );
}

/** Who the fans are, in words, once the rule is complete: "Listeners on Free in Germany who played Doppelfenster for more than 3 hours in the last 30 days." */
function fansWords(form: OfferForm, markets: readonly Market[], artist: string | undefined): string | null {
  const seconds = parseHours(form.hours);
  const days = Number(form.days);
  if (form.artist === "" || seconds === null || !Number.isInteger(days) || days < 1) return null;
  const where = form.markets.map((entry) => markets.find((market) => market.code === entry.market)?.name ?? entry.market).join(", ") || "the markets of step 1";
  const who = form.segment === "NEVER_PAID" ? `People in ${where} who have never paid,` : form.segment === "FREE_LISTENERS" ? `Listeners on Free in ${where}` : `People in ${where}`;
  const rule = listeningWords({ artistId: Number(form.artist), minSeconds: seconds, withinDays: days }, new Map(artist ? [[Number(form.artist), artist]] : []));
  return `${who} ${rule}.`;
}

function FansFields({ form, markets, disabled, shown, touch, update }: StepProps & { readonly update: (patch: Partial<OfferForm>) => void }) {
  const names = useArtistNames(form.artist === "" ? [] : [Number(form.artist)]);
  const words = fansWords(form, markets, names.get(Number(form.artist)));
  return (
    <div className="grid gap-3">
      <label className="choice-card">
        <input type="checkbox" id="fans" checked={form.fans} disabled={disabled} onChange={(event) => update({ fans: event.target.checked })} />
        <span>
          Only the fans of an artist
          <small className="block text-xs text-ink-2">For an album release: the people who played the artist for more than a set time lately, read from the listening data (§14.2).</small>
        </span>
      </label>
      {form.fans ? (
        <div className="ml-2.5 grid gap-5 border-l border-cord pl-5">
          <ArtistPicker value={form.artist} disabled={disabled} error={shown("artist")} markets={markets} onChange={(id) => update({ artist: id })} onBlur={() => touch("artist")} />
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField id="hours" label="Hours played" hint="A fan played the artist for more than this in the window: 3, or 1.5." value={form.hours} disabled={disabled} inputMode="decimal" suffix="h" error={shown("hours")} onChange={(value) => update({ hours: value })} onBlur={() => touch("hours")} />
            <TextField id="days" label="Window" hint={`The days before the day it is counted, from 1 to ${LIMITS.listeningDaysMax}: the book counts the last ${FANS_WINDOW_DAYS} (§14.2).`} value={form.days} disabled={disabled} inputMode="numeric" suffix="days" error={shown("days")} onChange={(value) => update({ days: value })} onBlur={() => touch("days")} />
          </div>
          <p className="flex items-baseline gap-2 text-sm">
            <Icon name="headphones" size={16} className="translate-y-0.5 text-indigo" />
            <span>{words ?? "Choose the artist, the hours and the window: the rule reads back here in words."}</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}

function StepPrice({ form, markets, disabled, shown, touch, update, updateMarket }: StepProps & { readonly update: (patch: Partial<OfferForm>) => void; readonly updateMarket: (market: string, patch: Partial<MarketForm>) => void }) {
  return (
    <div className="grid gap-6">
      {form.markets.length === 0 ? <Callout icon="info" tone="quiet">Choose a market in step 1 first.</Callout> : null}
      {form.markets.map((entry) => {
        const market = markets.find((candidate) => candidate.code === entry.market);
        if (!market) return null;
        return <PriceBlock key={entry.market} entry={entry} market={market} plan={form.plan} disabled={disabled} shown={shown} touch={touch} updateMarket={updateMarket} />;
      })}
      <TextField id="months" label="Months at the offer price" hint={`Then the list price in force at that time (§6.1). From 1 to ${LIMITS.monthsMax}.`} value={form.months} disabled={disabled} inputMode="numeric" suffix="mo" error={shown("months")} onChange={(value) => update({ months: value })} onBlur={() => touch("months")} className="max-w-[16rem]" />
    </div>
  );
}

function PriceBlock({ entry, market, plan, disabled, shown, touch, updateMarket }: {
  readonly entry: MarketForm;
  readonly market: Market;
  readonly plan: string;
  readonly disabled: boolean;
  readonly shown: (field: string) => string | null;
  readonly touch: (field: string) => void;
  readonly updateMarket: (market: string, patch: Partial<MarketForm>) => void;
}) {
  const plans = useGatewayQuery(PlansDocument, { market: market.code }, { staleTime: 5 * 60_000 });
  const listPrice = plans.data?.plans.find((candidate) => candidate.code === plan)?.listPrice ?? null;
  return (
    <fieldset className="m-0 grid gap-3 border-0 border-t border-cord p-0 pt-3">
      <legend className="float-left mb-2 p-0 text-lg font-bold">{market.name}</legend>
      <p className="clear-both flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
        <span>List price in force: <b className="text-ink">{listPrice ? formatMoney(listPrice) : plan ? "none" : "choose a plan"}</b></span>
        <span>Floor: <b className="text-ink">{formatMoney(market.floor)}</b></span>
        <span>Artists' minimum: <b className="text-madder">{formatMoney(market.artistsMinimum)}</b> a month</span>
      </p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`How the price is set in ${market.name}`}>
        {(["fixed", "percent"] as const).map((kind) => (
          <label key={kind} className="choice-card grid-cols-[auto_minmax(0,1fr)] py-2">
            <input type="radio" name={`${market.code}-kind`} checked={entry.priceKind === kind} disabled={disabled} onChange={() => updateMarket(market.code, { priceKind: kind })} />
            <span>{kind === "fixed" ? "A fixed price" : "A percentage off the list price"}</span>
          </label>
        ))}
      </div>
      {entry.priceKind === "fixed" ? (
        <TextField id={marketField(market.code, "fixed")} label={`Offer price in ${market.name}, VAT included`} value={entry.fixed} disabled={disabled} inputMode="decimal" prefix={market.currency === "GBP" ? "£" : "€"} error={shown(marketField(market.code, "fixed"))} onChange={(value) => updateMarket(market.code, { fixed: value })} onBlur={() => touch(marketField(market.code, "fixed"))} className="max-w-[16rem]" />
      ) : (
        <TextField id={marketField(market.code, "percent")} label={`Off the list price in ${market.name}`} hint="The engine computes the price and rounds it to the currency's minor unit." value={entry.percent} disabled={disabled} inputMode="decimal" suffix="%" error={shown(marketField(market.code, "percent"))} onChange={(value) => updateMarket(market.code, { percent: value })} onBlur={() => touch(marketField(market.code, "percent"))} className="max-w-[16rem]" />
      )}
      <FloorLine entry={entry} market={market} />
    </fieldset>
  );
}

/** Below the floor: the finance condition's signer will sign (§5.4, §7.3 condition 2). The rule is the engine's; this only reads the floor it gives. */
function FloorLine({ entry, market }: { readonly entry: MarketForm; readonly market: Market }) {
  if (entry.priceKind !== "fixed") return null;
  const typed = entry.fixed.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) return null;
  const [units = "0", minor = ""] = typed.split(".");
  const amount = BigInt(units) * 100n + BigInt((minor + "00").slice(0, 2));
  if (amount >= BigInt(market.floor.amountMinor)) {
    return <p className="flex items-baseline gap-2 text-sm"><Icon name="check-circle" size={15} className="translate-y-0.5 text-indigo" />At or above the floor in {market.name}: the artists' share covers the minimum.</p>;
  }
  return (
    <p className="flex items-baseline gap-2 text-sm">
      <Icon name="warning" size={15} className="translate-y-0.5 text-madder" />
      <span>Below the floor in {market.name} ({formatMoney(market.floor)}). The service tops up the artists to the minimum, and {conditionSigner()} will have to sign (§7.3, condition 2).</span>
    </p>
  );
}

function StepDates({ form, markets, disabled, shown, touch, updateMarket }: StepProps & { readonly updateMarket: (market: string, patch: Partial<MarketForm>) => void }) {
  return (
    <div className="grid gap-6">
      {form.markets.length === 0 ? <Callout icon="info" tone="quiet">Choose a market in step 1 first.</Callout> : null}
      {form.markets.map((entry) => {
        const market = markets.find((candidate) => candidate.code === entry.market);
        if (!market) return null;
        const city = zoneCity(market.timeZone);
        return (
          <fieldset key={entry.market} className="m-0 grid gap-3 border-0 border-t border-cord p-0 pt-3">
            <legend className="float-left mb-2 p-0 text-lg font-bold">{market.name}, {city} time</legend>
            <div className="clear-both grid gap-4 md:grid-cols-2">
              <TextField id={marketField(market.code, "startsLocal")} type="datetime-local" label={`Starts, ${city} time`} value={entry.startsLocal} disabled={disabled} error={shown(marketField(market.code, "startsLocal"))} onChange={(value) => updateMarket(market.code, { startsLocal: value })} onBlur={() => touch(marketField(market.code, "startsLocal"))} />
              <TextField id={marketField(market.code, "endsLocal")} type="datetime-local" label={`Ends, ${city} time`} hint="Empty: no end announced." value={entry.endsLocal} disabled={disabled} error={shown(marketField(market.code, "endsLocal"))} onChange={(value) => updateMarket(market.code, { endsLocal: value })} onBlur={() => touch(marketField(market.code, "endsLocal"))} />
            </div>
            <p className="flex items-baseline gap-2 text-sm">
              <Icon name="calendar-check" size={15} className="translate-y-0.5 text-ink-2" />
              <span>
                {parseLocal(entry.startsLocal) ? formatLocalWithUtc(entry.startsLocal, market.timeZone) : "No start yet"}
                {entry.endsLocal && parseLocal(entry.endsLocal) ? ` until ${formatLocalWithUtc(entry.endsLocal, market.timeZone)}` : ", no end announced"}
              </span>
            </p>
          </fieldset>
        );
      })}
      <p className="flex items-baseline gap-2 text-sm text-ink-2">
        <Icon name="clock" size={15} className="translate-y-0.5" />
        Times are local to each market and stay local across clock changes (§3.7): 09:00 in Rome stays 09:00 in Rome. A time the clocks skip or repeat is refused.
      </p>
    </div>
  );
}

function StepPage({ form, markets, disabled, shown, touch, updateMarket }: StepProps & { readonly updateMarket: (market: string, patch: Partial<MarketForm>) => void }) {
  return (
    <div className="grid gap-6">
      {form.markets.length === 0 ? <Callout icon="info" tone="quiet">Choose a market in step 1 first.</Callout> : null}
      {form.markets.map((entry) => {
        const market = markets.find((candidate) => candidate.code === entry.market);
        if (!market) return null;
        return (
          <fieldset key={entry.market} className="m-0 grid gap-4 border-0 border-t border-cord p-0 pt-3">
            <legend className="float-left mb-2 p-0 text-lg font-bold">The page in {market.name}</legend>
            <TextField className="clear-both" id={marketField(market.code, "pageTitle")} label="Title" value={entry.pageTitle} disabled={disabled} maxLength={LIMITS.pageTitle} error={shown(marketField(market.code, "pageTitle"))} onChange={(value) => updateMarket(market.code, { pageTitle: value })} onBlur={() => touch(marketField(market.code, "pageTitle"))} />
            <TextAreaField id={marketField(market.code, "pageText")} label="Text" hint="Write prices the way the country writes them: 2,99 € in Italy, £2.49 in the United Kingdom." rows={3} value={entry.pageText} disabled={disabled} maxLength={LIMITS.pageText} error={shown(marketField(market.code, "pageText"))} onChange={(value) => updateMarket(market.code, { pageText: value })} onBlur={() => touch(marketField(market.code, "pageText"))} />
            <TextAreaField id={marketField(market.code, "pageTerms")} label="Terms" rows={4} value={entry.pageTerms} disabled={disabled} maxLength={LIMITS.pageTerms} error={shown(marketField(market.code, "pageTerms"))} onChange={(value) => updateMarket(market.code, { pageTerms: value })} onBlur={() => touch(marketField(market.code, "pageTerms"))} />
          </fieldset>
        );
      })}
      <p className="flex items-baseline gap-2 text-sm text-ink-2">
        <Icon name="tag" size={15} className="translate-y-0.5" />
        The struck-through price on the page is the list price in force that day, read from the price list, never typed here (§6.2).
      </p>
    </div>
  );
}

function StepCheck({ change, dirty, canEdit, busy, problems, fansDays, reason, reasonError, onReason, onCheck, onSubmit, onGoTo, outcome }: {
  readonly change: Change | null;
  readonly dirty: boolean;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly problems: readonly Problem[];
  /** The window of a fans' campaign, in days; null when it is for everyone in its segment. */
  readonly fansDays: number | null;
  readonly reason: string;
  readonly reasonError: string | null;
  readonly onReason: (value: string) => void;
  readonly onCheck: () => void;
  readonly onSubmit: () => void;
  readonly onGoTo: (step: StepIndex) => void;
  readonly outcome: { readonly kind: "saved" | "submitted"; readonly version: number } | null;
}) {
  const validation = change?.validation ?? null;
  const current = change !== null && validation !== null && validation.version === change.currentVersion && !dirty;
  const needsReason = change?.requiredSignatures.some((signature) => signature.conditions.includes(4)) ?? false;
  const nextVersion = change === null ? 1 : dirty ? change.currentVersion + 1 : change.currentVersion;

  if (problems.length) {
    const steps = [...new Set(problems.map((problem) => stepOfField(problem.field)))].sort();
    return (
      <Callout tone="error" icon="warning-circle">
        <p className="font-bold">Some steps are not finished.</p>
        <ul className="mt-1 grid gap-1">
          {steps.map((index) => (
            <li key={index}>
              <button type="button" className="font-semibold text-indigo underline underline-offset-4" onClick={() => onGoTo(index as StepIndex)}>Step {index + 1}, {STEPS[index]}</button>
            </li>
          ))}
        </ul>
      </Callout>
    );
  }

  return (
    <div className="grid gap-6">
      {!current ? (
        <div className="grid gap-3">
          <p className="max-w-[65ch]">
            {canEdit
              ? `The engine checks v${nextVersion} as it will be approved: the price against the floor, clashes with other offers for the same people, dates and time zones, the audience, the page, and who has to sign.`
              : "This version has not been checked yet."}
          </p>
          {canEdit ? (
            <Button weight="primary" icon="shield-check" busy={busy} onClick={onCheck} className="justify-self-start">
              {dirty || change === null ? `Save v${nextVersion} and check it` : `Check v${nextVersion}`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {current && validation ? (
        <>
          {change?.sentence ? <p className="sentence" aria-label="The change in business words">{change.sentence}</p> : null}
          <Findings
            version={validation.version}
            findings={validation.findings}
            stepOf={STEP_OF_CHECK}
            stepNames={STEPS}
            onGoTo={(next) => onGoTo(next as StepIndex)}
            none={`No finding: nothing blocks it and no condition asks for ${conditionSigner()}.`}
          />
          <p className="text-sm text-ink-2">
            <b className="text-ink">{validation.eligible.toLocaleString("en-GB")}</b> people eligible right now, counted in the simulated data by the engine
            {fansDays !== null ? `: their listening of the ${fansDays} full ${fansDays === 1 ? "day" : "days"} before today, in each market's calendar.` : "."}
          </p>
          {validation.valid && change ? (
            <section className="grid gap-3" aria-labelledby="signs-heading">
              <h3 id="signs-heading" className="text-base font-bold">Who has to sign</h3>
              <ul role="list" className="grid gap-1.5">
                {change.requiredSignatures.map((signature) => (
                  <li key={signature.role} className="flex flex-wrap items-center gap-2">
                    <Chip look="waiting" icon="hourglass-medium">{signerWords(signature, { start: true })}</Chip>
                    <span className="text-sm">{signature.why}</span>
                  </li>
                ))}
              </ul>
              <p className="text-sm">
                <Link href={`/campaigns/simulation/?id=${change.id}`}>Open the simulation</Link> to see what the campaign costs and earns under its assumptions, and the break-even.
              </p>
            </section>
          ) : null}
          {validation.valid && change && change.state === "VALIDATED" ? (
            canEdit ? (
              <section className="grid gap-3" aria-labelledby="submit-heading">
                <h3 id="submit-heading" className="sr-only">Submit</h3>
                <TextAreaField
                  id="author-reason"
                  label={needsReason ? "Why is it worth running? Required: the simulated contribution over 12 months is negative." : "Why is it worth running? Optional."}
                  hint={`${conditionSigner({ start: true })} reads this next to the numbers.`}
                  rows={4}
                  value={reason}
                  maxLength={2000}
                  error={reasonError}
                  onChange={onReason}
                />
                <Button weight="primary" icon="paper-plane-tilt" busy={busy} onClick={onSubmit} className="justify-self-start">
                  Submit v{change.currentVersion} for approval
                </Button>
              </section>
            ) : <Locked>{whoDoes("submitOffer", { one: "submits campaigns for approval", many: "submit campaigns for approval" })}.</Locked>
          ) : null}
        </>
      ) : null}
      {outcome?.kind === "submitted" && change ? (
        <div className="grid gap-2 border-2 border-indigo bg-stone-0 p-4" role="status">
          <p className="flex items-center gap-2 text-lg font-bold"><Icon name="paper-plane-tilt" size={18} />v{outcome.version} is in approval.</p>
          <p>
            {change.requiredSignatures.map((signature) => `${signatureWords(signature)} has to sign`).join("; ")}. You wrote it, so someone else approves it (§7.4).
          </p>
          <ButtonLink href={`/campaigns/approval/?id=${change.id}`} size="small" iconAfter="arrow-right" className="justify-self-start">Open the approval page</ButtonLink>
        </div>
      ) : change && change.state === "IN_APPROVAL" && !dirty && outcome === null ? (
        <Callout icon="hourglass-medium" tone="quiet">
          v{change.currentVersion} is in approval: {change.requiredSignatures.filter((signature) => !signature.signed).map((signature) => `${signatureWords(signature)} has to sign`).join("; ") || "every signature is there"}.{" "}
          <Link href={`/campaigns/approval/?id=${change.id}`}>Open the approval page</Link>
        </Callout>
      ) : null}
      {validation && !validation.valid && current ? (
        <Callout tone="error" icon="warning">v{validation.version} cannot be submitted until the blocking findings are fixed. Fixing them makes a new version, checked again.</Callout>
      ) : null}
    </div>
  );
}


