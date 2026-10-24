"use client";
// The guided creation of a campaign, in five steps: who can take it, the
// price, the dates, the page, then the check and the submission (business
// book §6). Beside the form, the page as the site would show it.
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
// the same steps with the fields locked and a line that says why.
import { formatMoney } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Button, ButtonLink, Callout, Chip, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import {
  ChangeDocument, type ChangeQuery, CreateOfferDocument, MarketsDocument, type MarketsQuery, PlansDocument, SaveOfferVersionDocument,
  SubmitChangeDocument, ValidateChangeDocument,
} from "../../graphql/generated.ts";
import { MARKET_ORDER, planName } from "../../lib/markets.ts";
import {
  cannotCarry, checkStep, differsFrom, emptyForm, emptyMarket, formFromContent, LIMITS, type MarketFacts, type MarketForm, marketField,
  type OfferContent, type OfferForm, type Problem, type Segment, STEPS, type StepIndex, toInput,
} from "../../lib/offer-form.ts";
import { listeningWords } from "../../lib/diff.ts";
import { can, primaryRole, ROLE_NAME, signatureWords, whoCan } from "../../lib/permissions.ts";
import { useClock } from "../../lib/react/clock.tsx";
import { useAction, useGatewayQuery, useRefreshChanges } from "../../lib/react/gateway.tsx";
import { useViewer } from "../../lib/react/session.tsx";
import { formatInstantIn, formatLocalValue, formatLocalWithUtc, nextWeekday, parseLocal, partsIn, zoneCity } from "../../lib/time.ts";
import { CampaignTabs } from "../campaigns/tabs.tsx";
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
    listening: null,
    markets: [{
      ...emptyMarket("IT", formatLocalValue(monday)),
      fixed: "2.99",
      pageTitle: "Student Autumn Pass",
      pageText: "Three months of Student for 2,99 € a month. Then 5,79 €, the usual Student price.",
      pageTerms: "For verified students in Italy who have never paid for a plan. Three months at 2,99 €, then the Student list price in force. Not combinable with other student offers.",
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

  const plansIt = useGatewayQuery(PlansDocument, { market: form.markets[0]?.market ?? "IT" }, { staleTime: 5 * 60_000 });
  const previewPlans: Record<string, readonly PreviewPlan[]> = {};
  if (plansIt.data && form.markets[0]) {
    previewPlans[form.markets[0].market] = plansIt.data.plans.map((plan) => ({ code: plan.code, name: plan.name, listPrice: plan.listPrice, needsStudentCheck: plan.entitlements.needsStudentCheck }));
  }

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
  const busy = create.isPending || save.isPending || validate.isPending || submit.isPending;
  const failure = create.error ?? save.error ?? validate.error ?? submit.error;

  /** Saves the form as a new version when it differs; returns the change and its version, or null when nothing could be saved. */
  async function persist(): Promise<{ id: string; version: number } | null> {
    setRefusal(null);
    const typed = toInput(form, facts);
    if ("problems" in typed) {
      setTouched(new Set(typed.problems.map((problem) => problem.field)));
      return null;
    }
    if (change === null) {
      const result = (await create.mutateAsync({ offer: typed.input })).createOffer as ResultUnion;
      if (result.__typename === "Refusal") {
        setRefusal({ code: result.code, reason: result.reason });
        return null;
      }
      await refresh();
      onCreated(result.id);
      return { id: result.id, version: result.currentVersion };
    }
    if (conflict === null && !dirty) return { id: change.id, version: base.version };
    const result = (await save.mutateAsync({ changeId: change.id, baseVersion: base.version, offer: typed.input })).saveOfferVersion as ResultUnion;
    if (result.__typename === "Refusal") {
      if (result.code === "STALE_VERSION" && result.change) setStaleRefusal(result.change);
      else setRefusal({ code: result.code, reason: result.reason });
      return null;
    }
    setBase({ version: result.currentVersion, content: offerContent(result) });
    setStaleRefusal(null);
    await refresh();
    return { id: result.id, version: result.currentVersion };
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
    const all = checkStep(form, 4, facts, now);
    if (all.length) {
      setTouched(new Set(all.map((problem) => problem.field)));
      return;
    }
    const done = await persist().catch(() => null);
    if (done === null) return;
    const result = (await validate.mutateAsync({ changeId: done.id, version: done.version }).catch(() => null))?.validateChange as ResultUnion | undefined;
    if (result && result.__typename === "Refusal" && result.code !== "INVALID") setRefusal({ code: result.code, reason: result.reason });
    await refresh();
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
  ) : "A draft that only Marketing changes. Nothing reaches the site before approval and activation.";

  return (
    <WizardFrame changeId={change?.id ?? null} title={title} sub={sub}>
      {uncarried && viewerCanEdit && editableState ? <Locked>{uncarried}</Locked> : null}
      {!viewerCanEdit ? (
        <Locked>{whoCan("createOffer")} creates and submits campaigns{role ? `; as ${ROLE_NAME[role]} you read this one, with the fields locked` : ""}.</Locked>
      ) : !editableState && change ? (
        <Locked>This change is {change.state.toLowerCase()}: it takes no new versions. To offer something else, start a new campaign.</Locked>
      ) : change && (change.state === "IN_APPROVAL" || change.state === "APPROVED") ? (
        <Callout icon="info" tone="quiet">v{change.currentVersion} is {change.state === "IN_APPROVAL" ? "in approval" : "approved"}. Saving an edit makes v{change.currentVersion + 1} and takes it back to draft: approvals given to v{change.currentVersion} do not carry over (§7.2).</Callout>
      ) : null}
      {conflict ? <ConflictPanel conflict={conflict} startedFrom={base.version} onLoad={() => {
        const content = offerContent(conflict);
        if (content) setForm(formFromContent(content));
        setBase({ version: conflict.currentVersion, content });
        setStaleRefusal(null);
        void refresh();
      }} /> : null}
      <Stepper step={step} form={form} facts={facts} now={now} onStep={(next) => onStep(next)} />
      <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-12">
        <form className="grid min-w-0 content-start gap-6" noValidate onSubmit={(event) => event.preventDefault()} aria-labelledby="step-heading">
          <div className="grid gap-0.5">
            <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="text-4xl font-bold leading-tight focus-visible:outline-none">{STEPS[step]}</h2>
            <p className="text-xs text-ink-2">Step {step + 1} of 5</p>
          </div>
          {step === 0 ? <StepAudience form={form} markets={markets} disabled={!canEdit} shown={shown} touch={touch} update={update} now={now} /> : null}
          {step === 1 ? <StepPrice form={form} markets={markets} disabled={!canEdit} shown={shown} touch={touch} update={update} updateMarket={updateMarket} /> : null}
          {step === 2 ? <StepDates form={form} markets={markets} disabled={!canEdit} shown={shown} touch={touch} updateMarket={updateMarket} /> : null}
          {step === 3 ? <StepPage form={form} markets={markets} disabled={!canEdit} shown={shown} touch={touch} updateMarket={updateMarket} /> : null}
          {step === 4 ? (
            <StepCheck
              change={change}
              dirty={dirty}
              canEdit={canEdit}
              busy={busy}
              problems={checkStep(form, 4, facts, now)}
              reason={reason}
              reasonError={reasonTouched && change !== null && change.requiredSignatures.some((signature) => signature.conditions.includes(4)) && reason.trim() === "" ? "Write why the campaign is worth running: the contribution over 12 months is negative, and Finance reads this next to the numbers (§7.3, condition 4)." : null}
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
          <div className="flex flex-wrap items-center gap-3 border-t border-cord pt-4">
            {step > 0 ? <Button icon="arrow-left" onClick={() => onStep((step - 1) as StepIndex)}>Back</Button> : null}
            {canEdit ? <Button weight="quiet" icon="floppy-disk" busy={create.isPending || save.isPending} onClick={() => void onSave()}>Save draft</Button> : null}
            <span className="flex-1" />
            {step < 4 ? <Button weight="primary" iconAfter="arrow-right" onClick={() => void onContinue()}>Continue</Button> : null}
          </div>
        </form>
        <SitePreview form={form} markets={markets} plans={previewPlans} />
      </div>
    </WizardFrame>
  );
}

function Stepper({ step, form, facts, now, onStep }: { readonly step: StepIndex; readonly form: OfferForm; readonly facts: MarketFacts; readonly now: Date; readonly onStep: (step: StepIndex) => void }) {
  return (
    <ol className="m-0 grid list-none grid-cols-5 gap-1 p-0" aria-label="Steps">
      {STEPS.map((name, index) => {
        const done = index < step && checkStep(form, index as StepIndex, facts, now).length === 0;
        const current = index === step;
        return (
          <li key={name}>
            <button type="button" onClick={() => onStep(index as StepIndex)} className="grid w-full gap-0.5 border-0 bg-transparent p-0 pb-1.5 text-left" {...(current ? { "aria-current": "step" as const } : {})}>
              <span className={`mb-1.5 block h-2.5 ${done ? "bg-silk-indigo shadow-[inset_0_2px_0_var(--color-indigo)]" : current ? "weave-open bg-stone-0 shadow-[inset_0_2px_0_var(--color-ink)]" : "bg-stone-2 shadow-[inset_0_2px_0_var(--color-edge)]"}`} />
              <span className="flex items-baseline gap-1.5 text-md font-bold">
                <span className={`font-semibold ${current ? "text-ink underline decoration-2 underline-offset-4 lg:no-underline" : "text-ink-2"}`}>{index + 1}</span>
                <span className={`max-lg:sr-only ${current ? "lg:underline lg:decoration-2 lg:underline-offset-4" : ""}`}>{name}</span>
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-ink-2 max-lg:hidden">
                {done ? <><Icon name="check" size={13} />Done</> : current ? "Now" : "Next"}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
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
          Starting from scratch, or from the example of the business book:
          <Button size="small" weight="quiet" icon="student" onClick={() => update(autumnExample(now))}>Fill in the Student Autumn Pass</Button>
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
      {form.listening ? (
        <p className="flex items-baseline gap-2 border border-cord bg-stone-0 px-3 py-2.5 text-sm">
          <Icon name="headphones" size={16} className="translate-y-0.5 text-indigo" />
          <span>
            <b>Listening rule</b>: only people {listeningWords(form.listening)} (§14.2). It is kept as it was saved: this console does not change it.
          </span>
        </p>
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
        How many people this reaches is counted in the data by the engine when the campaign is checked, in step 5: nobody types it (§6.5).
      </p>
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

/** Below the floor: Finance will sign (§5.4, §7.3 condition 2). The rule is the engine's; this only reads the floor it gives. */
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
      <span>Below the floor in {market.name} ({formatMoney(market.floor)}). The service tops up the artists to the minimum, and Finance will have to sign (§7.3, condition 2).</span>
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

function StepCheck({ change, dirty, canEdit, busy, problems, reason, reasonError, onReason, onCheck, onSubmit, onGoTo, outcome }: {
  readonly change: Change | null;
  readonly dirty: boolean;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly problems: readonly Problem[];
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
    const steps = [...new Set(problems.map((problem) => (problem.field === "title" || problem.field === "plan" || problem.field === "segment" || problem.field === "group" || problem.field === "cap" || problem.field === "markets" || problem.field === "currentPlan" ? 0 : problem.field === "months" || problem.field.endsWith("-fixed") || problem.field.endsWith("-percent") ? 1 : problem.field.includes("Local") ? 2 : 3)))].sort();
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
          <section className="grid gap-2" aria-labelledby="checks-heading">
            <h3 id="checks-heading" className="text-base font-bold">What the engine checked in v{validation.version}</h3>
            <ul role="list" className="grid">
              {validation.findings.length === 0 ? <li className="py-2 text-ink-2">No finding: nothing blocks it and no condition asks for Finance.</li> : null}
              {validation.findings.map((finding, index) => (
                <li key={index} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 border-b border-cord py-2">
                  <Icon name={finding.severity === "BLOCKING" ? "x-circle" : finding.severity === "NEEDS_SIGNATURE" ? "signature" : "info"} size={18} className={`mt-0.5 ${finding.severity === "BLOCKING" ? "text-madder" : "text-indigo"}`} />
                  <span>
                    <b>{finding.severity === "BLOCKING" ? "Blocks the submission" : finding.severity === "NEEDS_SIGNATURE" ? "Asks for a signature" : "For information"}</b>: {finding.message}
                    {finding.severity === "BLOCKING" && STEP_OF_CHECK[finding.check] !== undefined ? (
                      <> <button type="button" className="font-semibold text-indigo underline underline-offset-4" onClick={() => onGoTo(STEP_OF_CHECK[finding.check] ?? 0)}>Go to step {(STEP_OF_CHECK[finding.check] ?? 0) + 1}</button></>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-ink-2"><b className="text-ink">{validation.eligible.toLocaleString("en-GB")}</b> people eligible right now, counted in the simulated data by the engine.</p>
          </section>
          {validation.valid && change ? (
            <section className="grid gap-3" aria-labelledby="signs-heading">
              <h3 id="signs-heading" className="text-base font-bold">Who has to sign</h3>
              <ul role="list" className="grid gap-1.5">
                {change.requiredSignatures.map((signature) => (
                  <li key={signature.role} className="flex flex-wrap items-center gap-2">
                    <Chip look="waiting" icon="hourglass-medium">{signature.role === "COMMERCIAL_LEAD" ? "The commercial lead or Finance" : ROLE_NAME[signature.role]}</Chip>
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
                  hint="Finance reads this next to the numbers."
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
            ) : <Locked>{whoCan("submitOffer")} submits campaigns for approval.</Locked>
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

function ConflictPanel({ conflict, startedFrom, onLoad }: { readonly conflict: Change; readonly startedFrom: number; readonly onLoad: () => void }) {
  const author = conflict.current.author.label;
  return (
    <Callout tone="error" icon="warning" role="alert">
      <p className="font-bold">Someone saved v{conflict.currentVersion} while you were editing v{startedFrom}.</p>
      <p>{author} saved it on {formatInstantIn(conflict.current.createdAt, CONSOLE_ZONE)}. Your edits are still in the form and were not saved: nothing overwrote their version (§6.3).</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="small" icon="arrows-clockwise" onClick={onLoad}>Load v{conflict.currentVersion} and drop my edits</Button>
      </div>
    </Callout>
  );
}

