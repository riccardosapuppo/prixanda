"use client";
// The guided writing of a prepaid pass (business book §9, §14.4), in the five
// steps of the guided creation of a campaign: the pass (its plan, its months,
// how long a code can wait, its markets), the price in each market, when it
// is on sale, its page, then the check and the submission. Beside the form,
// the page as the site would show it.
//
// A step's Continue stops only what cannot mean anything; the business checks
// are the engine's (the floor for the months it gives, the dates to come, a
// plan anyone can have, who signs), shown in the last step with the step that
// fixes each one. Only the commercial lead writes passes (§12); Finance signs
// them as a price (§7.3, condition 1).
import { formatMoney, formatSitePrice, type MarketCode, parseAmount } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ConflictPanel, Findings, RefusalCallout, SignaturesList, Steps } from "../../components/change-parts.tsx";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Button, ButtonLink, Callout, ErrorPanel, Loading, Locked, SimulatedTag, StateChip } from "../../components/ui.tsx";
import {
  ChangeDocument, type ChangeQuery, CreatePrepaidPassDocument, MarketsDocument, type MarketsQuery, PlansDocument, SavePrepaidPassVersionDocument,
  SubmitChangeDocument, ValidateChangeDocument,
} from "../../graphql/generated.ts";
import { approvalHref, editHref } from "../../lib/kinds.ts";
import { byMarketOrder, planName } from "../../lib/markets.ts";
import type { MarketFacts, Problem } from "../../lib/offer-form.ts";
import {
  checkPassStep, emptyPass, emptyPassMarket, giftPassExample, PASS_LIMITS, PASS_PLANS, PASS_STEP_OF_CHECK, PASS_STEPS, type PassContent, passDiffers,
  passField, type PassForm, passFromContent, type PassMarketForm, type PassStep, passStepOf, toPassInput,
} from "../../lib/pass-form.ts";
import { asRole, can, conditionSigner, primaryRole, signatureWords, whoDoes } from "../../lib/permissions.ts";
import { useClock } from "../../lib/react/clock.tsx";
import { useAction, useGatewayQuery, useRefreshChanges } from "../../lib/react/gateway.tsx";
import { useViewer } from "../../lib/react/session.tsx";
import { formatInstantIn, formatLocalValue, formatLocalWithUtc, nextWeekday, parseLocal, partsIn, zoneCity } from "../../lib/time.ts";
import { ChangeTabs } from "../campaigns/tabs.tsx";
import { SelectField, TextAreaField, TextField } from "../wizard/fields.tsx";

type Change = NonNullable<ChangeQuery["change"]>;
type Market = MarketsQuery["markets"][number];
type ResultUnion = { readonly __typename: "Change" } & Change | { readonly __typename: "Refusal"; readonly code: string; readonly reason: string; readonly change: Change | null };

const EDITABLE_STATES = new Set(["DRAFT", "VALIDATED", "IN_APPROVAL", "APPROVED"]);
const LAST: PassStep = 4;

function stepFromSearch(value: string | null): PassStep {
  const number = Number(value ?? "1");
  return (Number.isInteger(number) && number >= 1 && number <= 5 ? number - 1 : 0) as PassStep;
}

function passContent(change: Change | null | undefined): PassContent | null {
  const content = change?.current.content;
  return content && content.__typename === "PrepaidPassContent" ? content : null;
}

export function PassEditor({ changeId }: { readonly changeId: string | null }) {
  const viewer = useViewer();
  const clock = useClock();
  const router = useRouter();
  const search = useSearchParams();
  const step = stepFromSearch(search.get("step"));
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const change = useGatewayQuery(ChangeDocument, { id: changeId ?? "" }, { enabled: changeId !== null });

  const loaded = changeId === null ? null : change.data?.change ?? null;
  if (markets.isError) return <EditorFrame changeId={changeId} title="New prepaid pass"><ErrorPanel error={markets.error} retry={() => void markets.refetch()} /></EditorFrame>;
  if (changeId !== null && change.isError) return <EditorFrame changeId={changeId} title="Prepaid pass"><ErrorPanel error={change.error} retry={() => void change.refetch()} /></EditorFrame>;
  if (markets.isPending || (changeId !== null && change.isPending)) return <EditorFrame changeId={changeId} title="Prepaid pass"><Loading what="the prepaid pass" lines={8} /></EditorFrame>;
  if (changeId !== null && (loaded === null || loaded.kind !== "PREPAID")) {
    return <EditorFrame changeId={changeId} title="Prepaid pass"><Callout icon="warning" tone="error">There is no prepaid pass #{changeId}. <Link href="/passes/">Back to the prepaid passes</Link>.</Callout></EditorFrame>;
  }
  return <PassFormView key={changeId ?? "new"} change={loaded} markets={markets.data.markets} step={step} viewerCanEdit={can(viewer.roles, "createPrepaidPass")} now={clock.now()} onStep={(next, id) => {
    const params = new URLSearchParams();
    if (id ?? changeId) params.set("id", id ?? changeId ?? "");
    params.set("step", String(next + 1));
    router.push(`${id ?? changeId ? "/passes/edit/" : "/passes/new/"}?${params.toString()}`, { scroll: false });
  }} onCreated={(id) => router.replace(`${editHref("PREPAID", id)}&step=${step + 1}`, { scroll: false })} />;
}

function EditorFrame({ changeId, title, sub, children }: { readonly changeId: string | null; readonly title: ReactNode; readonly sub?: ReactNode; readonly children: ReactNode }) {
  return (
    <>
      <PageHead
        crumbs={[{ label: "Prepaid passes", href: "/passes/" }, { label: changeId === null ? "New prepaid pass" : `Change #${changeId}` }]}
        title={title}
        {...(sub ? { sub } : {})}
      />
      <PageBody className="gap-6">
        <ChangeTabs kind="PREPAID" changeId={changeId} current="edit" />
        {children}
      </PageBody>
    </>
  );
}

function PassFormView({ change, markets, step, viewerCanEdit, now, onStep, onCreated }: {
  readonly change: Change | null;
  readonly markets: readonly Market[];
  readonly step: PassStep;
  readonly viewerCanEdit: boolean;
  readonly now: Date;
  readonly onStep: (step: PassStep, createdId?: string) => void;
  readonly onCreated: (id: string) => void;
}) {
  const viewer = useViewer();
  const refresh = useRefreshChanges();
  const [base, setBase] = useState<{ readonly version: number; readonly content: PassContent | null }>(() => ({ version: change?.currentVersion ?? 0, content: passContent(change) }));
  const baseNow = useRef(base);
  const moveBase = (next: { readonly version: number; readonly content: PassContent | null }) => {
    baseNow.current = next;
    setBase(next);
  };
  const saved = base.content;
  const [form, setForm] = useState<PassForm>(() => (saved ? passFromContent(saved) : emptyPass()));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [staleRefusal, setStaleRefusal] = useState<Change | null>(null);
  const newer = change !== null && change.currentVersion > base.version ? change : null;
  const conflict = staleRefusal ?? newer;
  const [outcome, setOutcome] = useState<{ readonly kind: "saved" | "submitted"; readonly version: number } | null>(null);
  const [refusal, setRefusal] = useState<{ readonly code: string; readonly reason: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const facts: MarketFacts = useMemo(() => Object.fromEntries(markets.map((market) => [market.code, { currency: market.currency, timeZone: market.timeZone, name: market.name }])), [markets]);
  const editableState = change === null || EDITABLE_STATES.has(change.state);
  const canEdit = viewerCanEdit && editableState;
  const dirty = canEdit && passDiffers(form, saved, facts);
  const role = primaryRole(viewer.roles);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const problems = checkPassStep(form, step, facts, now);
  const shown = (field: string) => (touched.has(field) ? problems.find((problem) => problem.field === field)?.message ?? null : null);
  const touch = (field: string) => setTouched((current) => new Set(current).add(field));
  const update = (patch: Partial<PassForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setOutcome(null);
  };
  const updateMarket = (market: string, patch: Partial<PassMarketForm>) => {
    setForm((current) => ({ ...current, markets: current.markets.map((entry) => (entry.market === market ? { ...entry, ...patch } : entry)) }));
    setOutcome(null);
  };

  const create = useAction(CreatePrepaidPassDocument, "create-prepaid-pass");
  const save = useAction(SavePrepaidPassVersionDocument, "save-prepaid-pass-version");
  const validate = useAction(ValidateChangeDocument, "validate-change");
  const submit = useAction(SubmitChangeDocument, "submit-change");
  // From the click to the check's answer, the version being checked is the only one: no second click creates another.
  const [checking, setChecking] = useState(false);
  const busy = checking || create.isPending || save.isPending || validate.isPending || submit.isPending;
  const failure = create.error ?? save.error ?? validate.error ?? submit.error;

  async function persist(options: { readonly open?: boolean } = {}): Promise<{ id: string; version: number; created: boolean } | null> {
    setRefusal(null);
    const typed = toPassInput(form, facts);
    if ("problems" in typed) {
      setTouched(new Set(typed.problems.map((problem) => problem.field)));
      const first = typed.problems[0];
      if (first && passStepOf(first.field) !== step) onStep(passStepOf(first.field));
      return null;
    }
    if (change === null) {
      const result = (await create.mutateAsync({ pass: typed.input })).createPrepaidPass as ResultUnion;
      if (result.__typename === "Refusal") {
        setRefusal({ code: result.code, reason: result.reason });
        return null;
      }
      await refresh();
      // Checking opens the new change only once its validation is stored (onCheck).
      if (options.open !== false) onCreated(result.id);
      return { id: result.id, version: result.currentVersion, created: true };
    }
    if (conflict === null && !dirty) return { id: change.id, version: base.version, created: false };
    const result = (await save.mutateAsync({ changeId: change.id, baseVersion: base.version, pass: typed.input })).savePrepaidPassVersion as ResultUnion;
    if (result.__typename === "Refusal") {
      if (result.code === "STALE_VERSION" && result.change) {
        if (result.change.currentVersion > baseNow.current.version) setStaleRefusal(result.change);
      } else setRefusal({ code: result.code, reason: result.reason });
      return null;
    }
    moveBase({ version: result.currentVersion, content: passContent(result) });
    setStaleRefusal(null);
    await refresh();
    return { id: result.id, version: result.currentVersion, created: false };
  }

  async function onSave() {
    const done = await persist().catch(() => null);
    if (done) setOutcome({ kind: "saved", version: done.version });
  }

  function onContinue() {
    if (problems.length) {
      setTouched((current) => new Set([...current, ...problems.map((problem) => problem.field)]));
      const first = problems[0];
      if (first) document.getElementById(first.field)?.focus();
      return;
    }
    onStep(Math.min(step + 1, LAST) as PassStep);
  }

  async function onCheck() {
    if (checking) return;
    setChecking(true);
    try {
      const all = checkPassStep(form, LAST, facts, now);
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
    if (change === null || conflict !== null) return;
    const result = (await submit.mutateAsync({ changeId: change.id, version: base.version, authorReason: null }).catch(() => null))?.submitChange as ResultUnion | undefined;
    if (result === undefined) return;
    if (result.__typename === "Refusal") {
      setRefusal({ code: result.code, reason: result.reason });
      return;
    }
    setOutcome({ kind: "submitted", version: result.currentVersion });
    await refresh();
  }

  const title = change ? <>{change.title} <span className="h1-v text-ink-2">v{change.currentVersion}</span></> : form.title ? `New prepaid pass: ${form.title}` : "New prepaid pass";
  const sub = change ? (
    <>
      <StateChip state={change.state} />
      <span>Created by {change.createdBy.label} on {formatInstantIn(change.createdAt, CONSOLE_ZONE, { year: true })}</span>
    </>
  ) : `A draft that only ${whoDoes("createPrepaidPass", { one: "changes", many: "change" }, { start: false })}. Nothing is on sale before ${conditionSigner()} signs it and its launch publishes it.`;
  const reviews = can(viewer.roles, "approve") || can(viewer.roles, "reject");

  return (
    <EditorFrame changeId={change?.id ?? null} title={title} sub={sub}>
      {!viewerCanEdit ? (
        <Locked>
          {whoDoes("createPrepaidPass", { one: "writes prepaid passes", many: "write prepaid passes" })} (§12).{" "}
          {change === null
            ? `${asRole(role)} you read them and do not start one.`
            : `${asRole(role)} you read this one, with its fields read-only${reviews ? ", and you review it on its approval page" : ""}.`}
          {change !== null && reviews ? <> <Link href={approvalHref("PREPAID", change.id)}>Open v{change.currentVersion} for approval</Link></> : null}
        </Locked>
      ) : !editableState && change ? (
        <Locked>This pass is {change.state.toLowerCase()}: it takes no new versions. To sell something else, start a new pass.</Locked>
      ) : change && (change.state === "IN_APPROVAL" || change.state === "APPROVED") ? (
        <Callout icon="info" tone="quiet">v{change.currentVersion} is {change.state === "IN_APPROVAL" ? "in approval" : "approved"}. Saving an edit makes v{change.currentVersion + 1} and takes it back to draft: approvals given to v{change.currentVersion} do not carry over (§7.2).</Callout>
      ) : null}
      {conflict ? <ConflictPanel conflict={conflict} startedFrom={base.version} onLoad={() => {
        const content = passContent(conflict);
        if (content) setForm(passFromContent(content));
        moveBase({ version: conflict.currentVersion, content });
        setStaleRefusal(null);
        void refresh();
      }} /> : null}
      <Steps names={PASS_STEPS} current={step} done={(index) => checkPassStep(form, index as PassStep, facts, now).length === 0} onStep={(next) => onStep(next as PassStep)} />
      <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-12">
        <form className="grid min-w-0 content-start gap-6" noValidate onSubmit={(event) => event.preventDefault()} aria-labelledby="step-heading">
          <div className="grid gap-0.5">
            <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="text-4xl font-bold leading-tight focus-visible:outline-none">{PASS_STEPS[step]}</h2>
            <p className="text-xs text-ink-2">Step {step + 1} of {PASS_STEPS.length}</p>
          </div>
          {step === 0 ? <StepPass form={form} markets={markets} disabled={!canEdit} shown={shown} touch={touch} update={update} now={now} /> : null}
          {step === 1 ? <StepPrice form={form} markets={markets} disabled={!canEdit} shown={shown} touch={touch} updateMarket={updateMarket} /> : null}
          {step === 2 ? <StepOnSale form={form} markets={markets} disabled={!canEdit} shown={shown} touch={touch} updateMarket={updateMarket} /> : null}
          {step === 3 ? <StepPage form={form} markets={markets} disabled={!canEdit} shown={shown} touch={touch} updateMarket={updateMarket} /> : null}
          {step === 4 ? (
            <StepCheck change={change} dirty={dirty} canEdit={canEdit} busy={busy} problems={checkPassStep(form, LAST, facts, now)} onCheck={() => void onCheck()} onSubmit={() => void onSubmit()} onGoTo={(next) => onStep(next)} outcome={outcome} />
          ) : null}
          {refusal ? <RefusalCallout refusal={refusal} /> : null}
          {failure ? <ErrorPanel error={failure} /> : null}
          {outcome?.kind === "saved" ? <Callout tone="good" icon="check-circle" role="status">Saved as v{outcome.version}.</Callout> : null}
          <div className="flex flex-wrap items-center gap-3 border-t border-cord pt-4">
            {step > 0 ? <Button icon="arrow-left" onClick={() => onStep((step - 1) as PassStep)}>Back</Button> : null}
            {canEdit ? <Button weight="quiet" icon="floppy-disk" busy={create.isPending || save.isPending} onClick={() => void onSave()}>Save draft</Button> : null}
            <span className="flex-1" />
            {step < LAST ? <Button weight="primary" iconAfter="arrow-right" onClick={onContinue}>Continue</Button> : null}
          </div>
        </form>
        <PassPreview form={form} markets={markets} />
      </div>
    </EditorFrame>
  );
}

type StepProps = {
  readonly form: PassForm;
  readonly markets: readonly Market[];
  readonly disabled: boolean;
  readonly shown: (field: string) => string | null;
  readonly touch: (field: string) => void;
};
type MarketStepProps = StepProps & { readonly updateMarket: (market: string, patch: Partial<PassMarketForm>) => void };

function StepPass({ form, markets, disabled, shown, touch, update, now }: StepProps & { readonly update: (patch: Partial<PassForm>) => void; readonly now: Date }) {
  const ordered = byMarketOrder(markets);
  const toggleMarket = (code: string, on: boolean) => {
    const zone = markets.find((market) => market.code === code)?.timeZone ?? "UTC";
    const starts = formatLocalValue(nextWeekday({ ...partsIn(now, zone), second: 0 }, 1, 9));
    update({ markets: on ? [...form.markets, emptyPassMarket(code, starts)] : form.markets.filter((entry) => entry.market !== code) });
  };
  return (
    <div className="grid gap-5">
      {!disabled && form.title === "" && form.markets.length === 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <Icon name="info" size={15} />
          Starting from scratch, or from the example of the business book (§9.1):
          <Button size="small" weight="quiet" icon="gift" onClick={() => update(giftPassExample(now))}>Fill in the three-month gift pass</Button>
        </p>
      ) : null}
      <TextField id="title" label="Pass name" hint="How the team finds it; the page has its own title in step 4." value={form.title} disabled={disabled} maxLength={200} error={shown("title")} onChange={(value) => update({ title: value })} onBlur={() => touch("title")} />
      <SelectField
        id="plan"
        label="Plan it gives"
        hint="A plan anyone can have: a gift code cannot carry a student verification, so there is no Student pass (§9.3)."
        value={form.plan}
        disabled={disabled}
        placeholder="Choose a plan"
        error={shown("plan")}
        options={PASS_PLANS.map((plan) => ({ value: plan, label: planName(plan) }))}
        onChange={(value) => update({ plan: value })}
        onBlur={() => touch("plan")}
      />
      <div className="grid gap-5 md:grid-cols-2 md:items-end">
        <TextField id="months" label="Months of the plan" hint={`Never renewed. From 1 to ${PASS_LIMITS.monthsMax}.`} value={form.months} disabled={disabled} inputMode="numeric" suffix="mo" error={shown("months")} onChange={(value) => update({ months: value })} onBlur={() => touch("months")} />
        <TextField id="codeValidMonths" label="A code waits to be activated" hint={`From its sale, then it expires. 1 to ${PASS_LIMITS.codeValidMonthsMax}.`} value={form.codeValidMonths} disabled={disabled} inputMode="numeric" suffix="mo" error={shown("codeValidMonths")} onChange={(value) => update({ codeValidMonths: value })} onBlur={() => touch("codeValidMonths")} />
      </div>
      <p className="-mt-2 text-sm text-ink-2">Paid once: then the Free plan. A code sold and not activated in time expires, unused, and stays unearned until then (§9.2).</p>
      <fieldset className="m-0 grid gap-2 border-0 p-0" id="markets" tabIndex={-1} aria-describedby={shown("markets") ? "markets-error" : undefined}>
        <legend className="label mb-1.5 p-0">Markets it is sold in</legend>
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
      <p className="flex items-baseline gap-2 text-sm text-ink-2">
        <Icon name="receipt" size={15} className="translate-y-0.5" />
        A listener buys a code through the simulated provider, keeps it or gives it, and whoever holds it activates it in the pass's market, once (§9.3).
      </p>
    </div>
  );
}

function StepPrice({ form, markets, disabled, shown, touch, updateMarket }: MarketStepProps) {
  return (
    <div className="grid gap-6">
      {form.markets.length === 0 ? <Callout icon="info" tone="quiet">Choose a market in step 1 first.</Callout> : null}
      {form.markets.map((entry) => {
        const market = markets.find((candidate) => candidate.code === entry.market);
        return market ? <PriceBlock key={entry.market} entry={entry} market={market} form={form} disabled={disabled} shown={shown} touch={touch} updateMarket={updateMarket} /> : null;
      })}
    </div>
  );
}

function PriceBlock({ entry, market, form, disabled, shown, touch, updateMarket }: {
  readonly entry: PassMarketForm;
  readonly market: Market;
  readonly form: PassForm;
  readonly disabled: boolean;
  readonly shown: (field: string) => string | null;
  readonly touch: (field: string) => void;
  readonly updateMarket: (market: string, patch: Partial<PassMarketForm>) => void;
}) {
  const plans = useGatewayQuery(PlansDocument, { market: market.code }, { staleTime: 5 * 60_000 });
  const listPrice = plans.data?.plans.find((candidate) => candidate.code === form.plan)?.listPrice ?? null;
  const months = /^\d{1,2}$/.test(form.months.trim()) ? Number(form.months) : 0;
  const times = (money: { readonly amountMinor: string; readonly currency: string }, count: number) => ({ amountMinor: (BigInt(money.amountMinor) * BigInt(count)).toString(), currency: money.currency });
  return (
    <fieldset className="m-0 grid gap-3 border-0 border-t border-cord p-0 pt-3">
      <legend className="float-left mb-2 p-0 text-lg font-bold">{market.name}</legend>
      <p className="clear-both flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
        <span>{form.plan ? planName(form.plan) : "The plan"} at the list price: <b className="text-ink">{listPrice ? formatMoney(listPrice) : form.plan ? "none" : "choose a plan"}</b> a month{listPrice && months ? <>, <b className="text-ink">{formatMoney(times(listPrice, months))}</b> for {months} months</> : null}</span>
        <span>Floor: <b className="text-ink">{formatMoney(market.floor)}</b> a month{months ? <>, <b className="text-ink">{formatMoney(times(market.floor, months))}</b> for {months}</> : null}</span>
      </p>
      <TextField id={passField(market.code, "price")} label={`Price in ${market.name}, VAT included, paid once`} value={entry.price} disabled={disabled} inputMode="decimal" prefix={market.currency === "GBP" ? "£" : "€"} error={shown(passField(market.code, "price"))} onChange={(value) => updateMarket(market.code, { price: value })} onBlur={() => touch(passField(market.code, "price"))} className="max-w-[16rem]" />
      <p className="flex items-baseline gap-2 text-sm">
        <Icon name="info" size={15} className="translate-y-0.5 text-indigo" />
        <span>A fixed price, never a percentage: later list prices do not change what a pass was sold at (§9.1). {conditionSigner({ start: true })} signs it as a price (§7.3, condition 1); below the floor for its months, also for condition 2.</span>
      </p>
    </fieldset>
  );
}

function StepOnSale({ form, markets, disabled, shown, touch, updateMarket }: MarketStepProps) {
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
              <TextField id={passField(market.code, "startsLocal")} type="datetime-local" label={`On sale from, ${city} time`} value={entry.startsLocal} disabled={disabled} error={shown(passField(market.code, "startsLocal"))} onChange={(value) => updateMarket(market.code, { startsLocal: value })} onBlur={() => touch(passField(market.code, "startsLocal"))} />
              <TextField id={passField(market.code, "endsLocal")} type="datetime-local" label={`Until, ${city} time`} hint="Empty: no end announced." value={entry.endsLocal} disabled={disabled} error={shown(passField(market.code, "endsLocal"))} onChange={(value) => updateMarket(market.code, { endsLocal: value })} onBlur={() => touch(passField(market.code, "endsLocal"))} />
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
        It goes on sale through its launch, when the first of these periods starts. Times stay local across clock changes (§3.7).
      </p>
    </div>
  );
}

function StepPage({ form, markets, disabled, shown, touch, updateMarket }: MarketStepProps) {
  return (
    <div className="grid gap-6">
      {form.markets.length === 0 ? <Callout icon="info" tone="quiet">Choose a market in step 1 first.</Callout> : null}
      {form.markets.map((entry) => {
        const market = markets.find((candidate) => candidate.code === entry.market);
        if (!market) return null;
        return (
          <fieldset key={entry.market} className="m-0 grid gap-4 border-0 border-t border-cord p-0 pt-3">
            <legend className="float-left mb-2 p-0 text-lg font-bold">The page in {market.name}</legend>
            <TextField className="clear-both" id={passField(market.code, "pageTitle")} label="Title" value={entry.pageTitle} disabled={disabled} maxLength={120} error={shown(passField(market.code, "pageTitle"))} onChange={(value) => updateMarket(market.code, { pageTitle: value })} onBlur={() => touch(passField(market.code, "pageTitle"))} />
            <TextAreaField id={passField(market.code, "pageText")} label="Text" hint="Write prices the way the country writes them: 29,99 € in Italy, £24.99 in the United Kingdom." rows={3} value={entry.pageText} disabled={disabled} maxLength={2000} error={shown(passField(market.code, "pageText"))} onChange={(value) => updateMarket(market.code, { pageText: value })} onBlur={() => touch(passField(market.code, "pageText"))} />
            <TextAreaField id={passField(market.code, "pageTerms")} label="Terms" hint="Say that it never renews and that later prices do not touch it." rows={4} value={entry.pageTerms} disabled={disabled} maxLength={4000} error={shown(passField(market.code, "pageTerms"))} onChange={(value) => updateMarket(market.code, { pageTerms: value })} onBlur={() => touch(passField(market.code, "pageTerms"))} />
          </fieldset>
        );
      })}
    </div>
  );
}

function StepCheck({ change, dirty, canEdit, busy, problems, onCheck, onSubmit, onGoTo, outcome }: {
  readonly change: Change | null;
  readonly dirty: boolean;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly problems: readonly Problem[];
  readonly onCheck: () => void;
  readonly onSubmit: () => void;
  readonly onGoTo: (step: PassStep) => void;
  readonly outcome: { readonly kind: "saved" | "submitted"; readonly version: number } | null;
}) {
  const validation = change?.validation ?? null;
  const current = change !== null && validation !== null && validation.version === change.currentVersion && !dirty;
  const nextVersion = change === null ? 1 : dirty ? change.currentVersion + 1 : change.currentVersion;
  if (problems.length) {
    const steps = [...new Set(problems.map((problem) => passStepOf(problem.field)))].sort();
    return (
      <Callout tone="error" icon="warning-circle">
        <p className="font-bold">Some steps are not finished.</p>
        <ul className="mt-1 grid gap-1">
          {steps.map((index) => (
            <li key={index}>
              <button type="button" className="font-semibold text-indigo underline underline-offset-4" onClick={() => onGoTo(index)}>Step {index + 1}, {PASS_STEPS[index]}</button>
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
              ? `The engine checks v${nextVersion} as it will be approved: the price for the months it gives against the floor, a plan anyone can have, the dates and time zones, the page in each market, and who has to sign.`
              : "This version has not been checked yet."}
          </p>
          {canEdit ? (
            <Button weight="primary" icon="shield-check" busy={busy} onClick={onCheck} className="justify-self-start">
              {dirty || change === null ? `Save v${nextVersion} and check it` : `Check v${nextVersion}`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {current && validation && change ? (
        <>
          {change.sentence ? <p className="sentence" aria-label="The change in business words">{change.sentence}</p> : null}
          <Findings version={validation.version} findings={validation.findings} stepOf={PASS_STEP_OF_CHECK} stepNames={PASS_STEPS} onGoTo={(next) => onGoTo(next as PassStep)} none={`No finding: nothing blocks it, and ${conditionSigner()} signs it as a price.`} />
          {validation.valid ? (
            <section className="grid gap-3" aria-labelledby="signs-heading">
              <h3 id="signs-heading" className="text-base font-bold">Who has to sign</h3>
              <SignaturesList signatures={change.requiredSignatures} />
            </section>
          ) : null}
          {validation.valid && change.state === "VALIDATED" ? (
            canEdit ? (
              <Button weight="primary" icon="paper-plane-tilt" busy={busy} onClick={onSubmit} className="justify-self-start">Submit v{change.currentVersion} for approval</Button>
            ) : <Locked>{whoDoes("createPrepaidPass", { one: "submits prepaid passes for approval", many: "submit prepaid passes for approval" })}.</Locked>
          ) : null}
          {!validation.valid ? <Callout tone="error" icon="warning">v{validation.version} cannot be submitted until the blocking findings are fixed. Fixing them makes a new version, checked again.</Callout> : null}
        </>
      ) : null}
      {outcome?.kind === "submitted" && change ? (
        <div className="grid gap-2 border-2 border-indigo bg-stone-0 p-4" role="status">
          <p className="flex items-center gap-2 text-lg font-bold"><Icon name="paper-plane-tilt" size={18} />v{outcome.version} is in approval.</p>
          <p>{change.requiredSignatures.map((signature) => `${signatureWords(signature)} has to sign`).join("; ")}. You wrote it, so someone else approves it (§7.4).</p>
          <ButtonLink href={approvalHref("PREPAID", change.id)} size="small" iconAfter="arrow-right" className="justify-self-start">Open the approval page</ButtonLink>
        </div>
      ) : change && change.state === "IN_APPROVAL" && !dirty && outcome === null ? (
        <Callout icon="hourglass-medium" tone="quiet">
          v{change.currentVersion} is in approval: {change.requiredSignatures.filter((signature) => !signature.signed).map((signature) => `${signatureWords(signature)} has to sign`).join("; ") || "every signature is there"}.{" "}
          <Link href={approvalHref("PREPAID", change.id)}>Open the approval page</Link>
        </Callout>
      ) : null}
    </div>
  );
}

/** The page of the first market as the site would show it: the price paid once, the months, the words; a demonstration, said so. */
function PassPreview({ form, markets }: { readonly form: PassForm; readonly markets: readonly Market[] }) {
  const entry = form.markets[0] ?? null;
  const market = entry ? markets.find((candidate) => candidate.code === entry.market) ?? null : null;
  const amount = entry && market ? parseAmount(entry.price.trim(), market.currency) : null;
  const price = entry && market && amount !== null && amount > 0n ? formatSitePrice({ amountMinor: amount.toString(), currency: market.currency }, entry.market as MarketCode) : null;
  return (
    <aside className="grid min-w-0 content-start gap-3 xl:sticky xl:top-4" aria-label="The page as the site would show it">
      <p className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-2">
        <span className="font-semibold">{market ? `The page in ${market.name}, as the site would show it` : "The page, as the site would show it"}</span>
        <SimulatedTag>Demonstration: no real payment</SimulatedTag>
      </p>
      <div className="grid gap-3 border border-cord bg-stone-0 p-5">
        {entry && market ? (
          <>
            <p className="text-3xl font-bold leading-tight">{entry.pageTitle || "The page's title"}</p>
            <p className="text-6xl font-bold leading-none tracking-[-0.01em]">{price ?? <span className="text-xl font-semibold text-ink-2">Price not set yet</span>}</p>
            <p className="flex items-center gap-2 text-sm font-semibold"><Icon name="gift" size={15} className="text-indigo" />{planName(form.plan || "individual")} for {form.months || "?"} months, paid once</p>
            <p className="max-w-[48ch] leading-relaxed">{entry.pageText || "The page's text."}</p>
            <p className="max-w-[48ch] border-t border-cord pt-2 text-xs leading-relaxed text-ink-2">{entry.pageTerms || "The terms."}</p>
            <p className="text-xs text-ink-2">A code to keep or to give; it waits up to {form.codeValidMonths || "?"} months to be activated, and never renews.</p>
          </>
        ) : (
          <p className="text-ink-2">Choose a market in step 1: its page appears here as you write it.</p>
        )}
      </div>
    </aside>
  );
}
