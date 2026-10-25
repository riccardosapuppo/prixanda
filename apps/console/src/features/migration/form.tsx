"use client";
// The guided writing of a price migration (business book §8, §14.3), in
// three steps like the guided creation of a campaign: the new price, the
// dates, then the check and the submission. Beside the form, the rules of the
// chosen market, the law apart from the music service's choice (§8.1).
//
// A step's Continue stops only what cannot mean anything; the business checks
// are the engine's. In the last step the console saves the version and asks
// the engine to validate it, then shows the change in business words, every
// finding (price, dates, overlap) with the step that fixes it, who has to
// sign, and the simulation in short. Saving makes a new version; a version
// someone else saved first comes back as a conflict, never overwritten (§6.3).
//
// Only the commercial lead writes price migrations (§12): the other roles read
// the same steps with the fields read-only, and a line that says why; a role
// that reviews finds the way to the approval page.
import { formatMoney, formatPercent } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ConflictPanel, Findings, RefusalCallout, SignaturesList, Steps } from "../../components/change-parts.tsx";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Button, ButtonLink, Callout, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import {
  ChangeDocument, type ChangeQuery, CreatePriceMigrationDocument, MarketsDocument, type MarketsQuery, PlansDocument, PriceChangePoliciesDocument,
  SavePriceMigrationVersionDocument, SubmitChangeDocument, ValidateChangeDocument,
} from "../../graphql/generated.ts";
import { approvalHref, editHref } from "../../lib/kinds.ts";
import { byMarketOrder, planName } from "../../lib/markets.ts";
import {
  checkMigrationStep, emptyMigration, familyRiseExample, increaseWords, MIGRATION_PLANS, MIGRATION_STEP_OF_CHECK, MIGRATION_STEPS, type MigrationContent,
  type MigrationForm, migrationDiffers, migrationFromContent, type MigrationStep, migrationStepOf, toMigrationInput,
} from "../../lib/migration-form.ts";
import type { MarketFacts, Problem } from "../../lib/offer-form.ts";
import { asRole, can, conditionSigner, primaryRole, signatureWords, whoDoes } from "../../lib/permissions.ts";
import { useClock } from "../../lib/react/clock.tsx";
import { useAction, useGatewayQuery, useRefreshChanges } from "../../lib/react/gateway.tsx";
import { useViewer } from "../../lib/react/session.tsx";
import { formatInstantIn, formatLocalWithUtc, parseLocal, zoneCity } from "../../lib/time.ts";
import { ChangeTabs } from "../campaigns/tabs.tsx";
import { ChoiceGroup, SelectField, TextAreaField, TextField } from "../wizard/fields.tsx";
import { MigrationInShort } from "./in-short.tsx";
import { MarketPolicy, type Policy, windowWords } from "./policy.tsx";

type Change = NonNullable<ChangeQuery["change"]>;
type Market = MarketsQuery["markets"][number];
type ResultUnion = { readonly __typename: "Change" } & Change | { readonly __typename: "Refusal"; readonly code: string; readonly reason: string; readonly change: Change | null };

const EDITABLE_STATES = new Set(["DRAFT", "VALIDATED", "IN_APPROVAL", "APPROVED"]);
const LAST: MigrationStep = 2;

function stepFromSearch(value: string | null): MigrationStep {
  const number = Number(value ?? "1");
  return (Number.isInteger(number) && number >= 1 && number <= 3 ? number - 1 : 0) as MigrationStep;
}

function migrationContent(change: Change | null | undefined): MigrationContent | null {
  const content = change?.current.content;
  return content && content.__typename === "PriceMigrationContent" ? content : null;
}

export function MigrationEditor({ changeId }: { readonly changeId: string | null }) {
  const viewer = useViewer();
  const clock = useClock();
  const router = useRouter();
  const search = useSearchParams();
  const step = stepFromSearch(search.get("step"));
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const change = useGatewayQuery(ChangeDocument, { id: changeId ?? "" }, { enabled: changeId !== null });

  const loaded = changeId === null ? null : change.data?.change ?? null;
  if (markets.isError) return <EditorFrame changeId={changeId} title="New price migration"><ErrorPanel error={markets.error} retry={() => void markets.refetch()} /></EditorFrame>;
  if (changeId !== null && change.isError) return <EditorFrame changeId={changeId} title="Price migration"><ErrorPanel error={change.error} retry={() => void change.refetch()} /></EditorFrame>;
  if (markets.isPending || (changeId !== null && change.isPending)) return <EditorFrame changeId={changeId} title="Price migration"><Loading what="the price migration" lines={8} /></EditorFrame>;
  if (changeId !== null && (loaded === null || loaded.kind !== "PRICE_MIGRATION")) {
    return (
      <EditorFrame changeId={changeId} title="Price migration">
        <Callout icon="warning" tone="error">There is no price migration #{changeId}. <Link href="/price-migrations/">Back to the price migrations</Link>.</Callout>
      </EditorFrame>
    );
  }
  return <MigrationFormView key={changeId ?? "new"} change={loaded} markets={markets.data.markets} step={step} viewerCanEdit={can(viewer.roles, "createPriceMigration")} now={clock.now()} onStep={(next, id) => {
    const params = new URLSearchParams();
    if (id ?? changeId) params.set("id", id ?? changeId ?? "");
    params.set("step", String(next + 1));
    router.push(`${id ?? changeId ? "/price-migrations/edit/" : "/price-migrations/new/"}?${params.toString()}`, { scroll: false });
  }} onCreated={(id) => router.replace(`${editHref("PRICE_MIGRATION", id)}&step=${step + 1}`, { scroll: false })} />;
}

function EditorFrame({ changeId, title, sub, children }: { readonly changeId: string | null; readonly title: ReactNode; readonly sub?: ReactNode; readonly children: ReactNode }) {
  return (
    <>
      <PageHead
        crumbs={[{ label: "Price migrations", href: "/price-migrations/" }, { label: changeId === null ? "New price migration" : `Change #${changeId}` }]}
        title={title}
        {...(sub ? { sub } : {})}
      />
      <PageBody className="gap-6">
        <ChangeTabs kind="PRICE_MIGRATION" changeId={changeId} current="edit" />
        {children}
      </PageBody>
    </>
  );
}

function MigrationFormView({ change, markets, step, viewerCanEdit, now, onStep, onCreated }: {
  readonly change: Change | null;
  readonly markets: readonly Market[];
  readonly step: MigrationStep;
  readonly viewerCanEdit: boolean;
  readonly now: Date;
  readonly onStep: (step: MigrationStep, createdId?: string) => void;
  readonly onCreated: (id: string) => void;
}) {
  const viewer = useViewer();
  const refresh = useRefreshChanges();
  const [base, setBase] = useState<{ readonly version: number; readonly content: MigrationContent | null }>(() => ({ version: change?.currentVersion ?? 0, content: migrationContent(change) }));
  const baseNow = useRef(base);
  const moveBase = (next: { readonly version: number; readonly content: MigrationContent | null }) => {
    baseNow.current = next;
    setBase(next);
  };
  const saved = base.content;
  const [form, setForm] = useState<MigrationForm>(() => (saved ? migrationFromContent(saved) : emptyMigration()));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [staleRefusal, setStaleRefusal] = useState<Change | null>(null);
  const newer = change !== null && change.currentVersion > base.version ? change : null;
  const conflict = staleRefusal ?? newer;
  const [outcome, setOutcome] = useState<{ readonly kind: "saved" | "submitted"; readonly version: number } | null>(null);
  const [refusal, setRefusal] = useState<{ readonly code: string; readonly reason: string } | null>(null);
  const [reason, setReason] = useState(change?.authorReason ?? "");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const facts: MarketFacts = useMemo(() => Object.fromEntries(markets.map((market) => [market.code, { currency: market.currency, timeZone: market.timeZone, name: market.name }])), [markets]);
  const editableState = change === null || EDITABLE_STATES.has(change.state);
  const canEdit = viewerCanEdit && editableState;
  const dirty = canEdit && migrationDiffers(form, saved, facts);
  const role = primaryRole(viewer.roles);
  const policies = useGatewayQuery(PriceChangePoliciesDocument, {}, { staleTime: 5 * 60_000 });
  const policy = policies.data?.markets.find((entry) => entry.code === form.market)?.priceChangePolicy ?? null;

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const problems = checkMigrationStep(form, step, facts, now);
  const shown = (field: string) => (touched.has(field) ? problems.find((problem) => problem.field === field)?.message ?? null : null);
  const touch = (field: string) => setTouched((current) => new Set(current).add(field));
  const update = (patch: Partial<MigrationForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setOutcome(null);
  };

  const create = useAction(CreatePriceMigrationDocument, "create-price-migration");
  const save = useAction(SavePriceMigrationVersionDocument, "save-price-migration-version");
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
    const typed = toMigrationInput(form, facts);
    if ("problems" in typed) {
      setTouched(new Set(typed.problems.map((problem) => problem.field)));
      const first = typed.problems[0];
      if (first && migrationStepOf(first.field) !== step) onStep(migrationStepOf(first.field));
      return null;
    }
    if (change === null) {
      setCreating(true);
      let result: ResultUnion;
      try {
        result = (await create.mutateAsync({ migration: typed.input })).createPriceMigration as ResultUnion;
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
      // Checking opens the new change only once its validation is stored (onCheck).
      if (options.open !== false) onCreated(result.id);
      return { id: result.id, version: result.currentVersion, created: true };
    }
    if (conflict === null && !dirty) return { id: change.id, version: base.version, created: false };
    const result = (await save.mutateAsync({ changeId: change.id, baseVersion: base.version, migration: typed.input })).savePriceMigrationVersion as ResultUnion;
    if (result.__typename === "Refusal") {
      if (result.code === "STALE_VERSION" && result.change) {
        if (result.change.currentVersion > baseNow.current.version) setStaleRefusal(result.change);
      } else setRefusal({ code: result.code, reason: result.reason });
      return null;
    }
    moveBase({ version: result.currentVersion, content: migrationContent(result) });
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
    onStep(Math.min(step + 1, LAST) as MigrationStep);
  }

  async function onCheck() {
    if (checking) return;
    setChecking(true);
    try {
      const all = checkMigrationStep(form, LAST, facts, now);
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
    const result = (await submit.mutateAsync({ changeId: change.id, version: base.version, authorReason: reason.trim() || null }).catch(() => null))?.submitChange as ResultUnion | undefined;
    if (result === undefined) return;
    if (result.__typename === "Refusal") {
      setRefusal({ code: result.code, reason: result.reason });
      return;
    }
    setOutcome({ kind: "submitted", version: result.currentVersion });
    await refresh();
  }

  const title = change ? <>{change.title} <span className="h1-v text-ink-2">v{change.currentVersion}</span></> : form.title ? `New price migration: ${form.title}` : "New price migration";
  const sub = change ? (
    <>
      <StateChip state={change.state} />
      <span>Created by {change.createdBy.label} on {formatInstantIn(change.createdAt, CONSOLE_ZONE, { year: true })}</span>
    </>
  ) : `A draft that only ${whoDoes("createPriceMigration", { one: "changes", many: "change" }, { start: false })}. Nobody is asked or told, and no price moves, before approval and its launch.`;
  const reviews = can(viewer.roles, "approve") || can(viewer.roles, "reject");

  return (
    <EditorFrame changeId={change?.id ?? null} title={title} sub={sub}>
      {!viewerCanEdit ? (
        <Locked>
          {whoDoes("createPriceMigration", { one: "writes price migrations", many: "write price migrations" })} (§12).{" "}
          {change === null
            ? `${asRole(role)} you read them and do not start one.`
            : `${asRole(role)} you read this one, with its fields read-only${reviews ? ", and you review it on its approval page" : ""}.`}
          {change !== null && reviews ? <> <Link href={approvalHref("PRICE_MIGRATION", change.id)}>Open v{change.currentVersion} for approval</Link></> : null}
        </Locked>
      ) : !editableState && change ? (
        <Locked>This migration is {change.state.toLowerCase()}: it takes no new versions. A price in force is never edited (§4.2): a new price is a new change.</Locked>
      ) : change && (change.state === "IN_APPROVAL" || change.state === "APPROVED") ? (
        <Callout icon="info" tone="quiet">v{change.currentVersion} is {change.state === "IN_APPROVAL" ? "in approval" : "approved"}. Saving an edit makes v{change.currentVersion + 1} and takes it back to draft: approvals given to v{change.currentVersion} do not carry over (§7.2).</Callout>
      ) : null}
      {conflict ? <ConflictPanel conflict={conflict} startedFrom={base.version} onLoad={() => {
        const content = migrationContent(conflict);
        if (content) setForm(migrationFromContent(content));
        moveBase({ version: conflict.currentVersion, content });
        setStaleRefusal(null);
        void refresh();
      }} /> : null}
      <Steps names={MIGRATION_STEPS} current={step} done={(index) => checkMigrationStep(form, index as MigrationStep, facts, now).length === 0} onStep={(next) => onStep(next as MigrationStep)} />
      <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-12">
        <form className="grid min-w-0 content-start gap-6" noValidate onSubmit={(event) => event.preventDefault()} aria-labelledby="step-heading">
          <div className="grid gap-0.5">
            <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="text-4xl font-bold leading-tight focus-visible:outline-none">{MIGRATION_STEPS[step]}</h2>
            <p className="text-xs text-ink-2">Step {step + 1} of {MIGRATION_STEPS.length}</p>
          </div>
          {step === 0 ? <StepPrice form={form} markets={markets} disabled={locked} shown={shown} touch={touch} update={update} now={now} policies={policies.data?.markets ?? []} /> : null}
          {step === 1 ? <StepDates form={form} markets={markets} disabled={locked} shown={shown} touch={touch} update={update} policy={policy} /> : null}
          {step === 2 ? (
            <StepCheck
              change={change}
              dirty={dirty}
              canEdit={canEdit}
              busy={busy}
              problems={checkMigrationStep(form, LAST, facts, now)}
              reason={reason}
              onReason={setReason}
              onCheck={() => void onCheck()}
              onSubmit={() => void onSubmit()}
              onGoTo={(next) => onStep(next)}
              outcome={outcome}
            />
          ) : null}
          {refusal ? <RefusalCallout refusal={refusal} /> : null}
          {failure ? <ErrorPanel error={failure} /> : null}
          {outcome?.kind === "saved" ? <Callout tone="good" icon="check-circle" role="status">Saved as v{outcome.version}.</Callout> : null}
          {creating ? (
            <Callout tone="quiet" icon="hourglass-medium" role="status">
              Saving the new price migration as v1. The fields wait until it is saved, then it opens on its own page, with nothing typed meanwhile lost.
            </Callout>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 border-t border-cord pt-4">
            {step > 0 ? <Button icon="arrow-left" onClick={() => onStep((step - 1) as MigrationStep)}>Back</Button> : null}
            {canEdit ? <Button weight="quiet" icon="floppy-disk" busy={creating || save.isPending} onClick={() => void onSave()}>Save draft</Button> : null}
            <span className="flex-1" />
            {step < LAST ? <Button weight="primary" iconAfter="arrow-right" onClick={onContinue}>Continue</Button> : null}
          </div>
        </form>
        <aside className="grid min-w-0 content-start gap-4 xl:sticky xl:top-4" aria-label="The market's rules">
          {form.market ? <MarketPolicy market={form.market} /> : (
            <p className="flex items-baseline gap-2 border border-dashed border-edge bg-stone px-4 py-3 text-sm text-ink-2">
              <Icon name="scales" size={16} className="translate-y-0.5" />
              Choose a market: its rules appear here, what the law asks apart from what the music service chose (§8.1).
            </p>
          )}
        </aside>
      </div>
    </EditorFrame>
  );
}

type StepProps = {
  readonly form: MigrationForm;
  readonly markets: readonly Market[];
  readonly disabled: boolean;
  readonly shown: (field: string) => string | null;
  readonly touch: (field: string) => void;
  readonly update: (patch: Partial<MigrationForm>) => void;
};

type PolicyRow = { readonly code: string; readonly priceChangePolicy: Policy | null };

function StepPrice({ form, markets, disabled, shown, touch, update, now, policies }: StepProps & { readonly now: Date; readonly policies: readonly PolicyRow[] }) {
  const ordered = byMarketOrder(markets);
  const market = markets.find((candidate) => candidate.code === form.market) ?? null;
  return (
    <div className="grid gap-5">
      {!disabled && form.title === "" && form.market === "" ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <Icon name="info" size={15} />
          Starting from scratch, or from the example of the business book (§14.3):
          <Button size="small" weight="quiet" icon="arrow-up-right" onClick={() => update(familyRiseExample(now))}>Fill in the Family price rise in Germany</Button>
        </p>
      ) : null}
      <TextField id="title" label="Migration name" hint="How the team finds it." value={form.title} disabled={disabled} maxLength={200} error={shown("title")} onChange={(value) => update({ title: value })} onBlur={() => touch("title")} />
      <ChoiceGroup<string>
        id="market"
        legend="Market"
        hint="One market per migration: each has its own rules for those who already pay."
        value={form.market}
        disabled={disabled}
        error={shown("market")}
        onChange={(value) => update({ market: value })}
        onBlur={() => touch("market")}
        options={ordered.map((entry) => {
          const policy = policies.find((row) => row.code === entry.code)?.priceChangePolicy ?? null;
          return {
            value: entry.code,
            label: entry.name,
            detail: policy ? `${policy.law.requirement === "CONSENT" ? "Consent" : "Notice"}: ${windowWords(policy)}` : `${entry.currency}, ${zoneCity(entry.timeZone)} time`,
          };
        })}
      />
      <SelectField id="plan" label="Plan" value={form.plan} disabled={disabled} placeholder="Choose a plan" error={shown("plan")} options={MIGRATION_PLANS.map((plan) => ({ value: plan, label: planName(plan) }))} onChange={(value) => update({ plan: value })} onBlur={() => touch("plan")} />
      {market ? <NewPrice form={form} market={market} disabled={disabled} shown={shown} touch={touch} update={update} /> : (
        <p className="flex items-baseline gap-2 text-sm text-ink-2"><Icon name="tag" size={15} className="translate-y-0.5" />Choose the market first: the price is in its currency, VAT included.</p>
      )}
    </div>
  );
}

function NewPrice({ form, market, disabled, shown, touch, update }: Omit<StepProps, "markets"> & { readonly market: Market }) {
  const plans = useGatewayQuery(PlansDocument, { market: market.code }, { staleTime: 5 * 60_000 });
  const current = plans.data?.plans.find((plan) => plan.code === form.plan)?.listPrice ?? null;
  const increase = increaseWords(current, form.amount);
  return (
    <div className="grid gap-3 border-t border-cord pt-3">
      <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
        <span>List price in force today: <b className="text-ink">{current ? formatMoney(current) : form.plan ? "none" : "choose a plan"}</b></span>
        <span>Floor: <b className="text-ink">{formatMoney(market.floor)}</b></span>
        <span>Artists' minimum: <b className="text-madder">{formatMoney(market.artistsMinimum)}</b> a month</span>
      </p>
      <TextField
        id="amount"
        label={`New price in ${market.name}, VAT included`}
        hint="What new subscribers pay from its start, and what existing ones are asked to accept, or told about."
        value={form.amount}
        disabled={disabled}
        inputMode="decimal"
        prefix={market.currency === "GBP" ? "£" : "€"}
        error={shown("amount")}
        onChange={(value) => update({ amount: value })}
        onBlur={() => touch("amount")}
        className="max-w-[20rem]"
      />
      {increase && current ? (
        increase.amountMinor > 0n ? (
          <p className="flex items-baseline gap-2 text-sm">
            <Icon name="arrow-up-right" size={15} className="translate-y-0.5 text-indigo" />
            <span>
              {formatMoney({ amountMinor: increase.amountMinor.toString(), currency: current.currency })} a month more than {formatMoney(current)} ({formatPercent(increase.basisPoints)} more).
              {" "}{conditionSigner({ start: true })} signs every price migration (§7.3, conditions 1 and 5).
            </span>
          </p>
        ) : (
          <p className="flex items-baseline gap-2 text-sm">
            <Icon name="warning" size={15} className="translate-y-0.5 text-madder" />
            <span>Not above the price in force, {formatMoney(current)}: a migration raises a price, and a lower one is a new list price (§4.2). The engine refuses it when it checks.</span>
          </p>
        )
      ) : null}
    </div>
  );
}

function StepDates({ form, markets, disabled, shown, touch, update, policy }: StepProps & { readonly policy: Policy | null }) {
  const market = markets.find((candidate) => candidate.code === form.market) ?? null;
  if (market === null) return <Callout icon="info" tone="quiet">Choose a market in step 1 first: the dates are local to it.</Callout>;
  const city = zoneCity(market.timeZone);
  const consent = policy?.law.requirement === "CONSENT";
  const price = form.amount.trim() ? `${market.currency === "GBP" ? "£" : "€"}${form.amount.trim()}` : "the new price";
  return (
    <div className="grid gap-6">
      <fieldset className="m-0 grid gap-4 border-0 p-0">
        <legend className="float-left mb-2 p-0 text-lg font-bold">{market.name}, {city} time</legend>
        <div className="clear-both grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-1.5">
            <TextField id="noticesLocal" type="datetime-local" label={`Existing subscribers are ${consent ? "asked" : "told"} from, ${city} time`} value={form.noticesLocal} disabled={disabled} error={shown("noticesLocal")} onChange={(value) => update({ noticesLocal: value })} onBlur={() => touch("noticesLocal")} />
            <p className="text-xs text-ink-2">{parseLocal(form.noticesLocal) ? formatLocalWithUtc(form.noticesLocal, market.timeZone) : "No date yet"}. The migration starts then.</p>
          </div>
          <div className="grid content-start gap-1.5">
            <TextField id="startsLocal" type="datetime-local" label={`New subscribers pay ${price} from, ${city} time`} value={form.startsLocal} disabled={disabled} error={shown("startsLocal")} onChange={(value) => update({ startsLocal: value })} onBlur={() => touch("startsLocal")} />
            <p className="text-xs text-ink-2">{parseLocal(form.startsLocal) ? formatLocalWithUtc(form.startsLocal, market.timeZone) : "No date yet"}. Not before the existing subscribers are {consent ? "asked" : "told"}.</p>
          </div>
        </div>
      </fieldset>
      <section className="grid gap-2 border-t border-cord pt-3" aria-labelledby="from-when">
        <h3 id="from-when" className="text-base font-bold">Who pays it, from when</h3>
        <ul role="list" className="grid gap-2 text-sm">
          <li className="flex items-baseline gap-2"><Icon name="users" size={15} className="translate-y-0.5 text-indigo" /><span><b>New subscribers</b> pay {price} from the start date, like any list price (§4.3).</span></li>
          <li className="flex items-baseline gap-2">
            <Icon name="clock-countdown" size={15} className="translate-y-0.5 text-indigo" />
            <span>
              <b>Existing subscribers</b>{" "}
              {policy === null
                ? `follow ${market.name}'s rules, which the engine does not have yet: it refuses the migration until it does.`
                : consent
                  ? `are asked for their consent, with ${windowWords(policy)}. They pay it from their first charge after a yes, never before the start date; without a yes, the music service's choice applies.`
                  : `are told, with ${windowWords(policy)}. They pay it from their first charge after the notice ends, unless they leave before it.`}
            </span>
          </li>
          <li className="flex items-baseline gap-2"><Icon name="gift" size={15} className="translate-y-0.5 text-indigo" /><span><b>Prepaid passes</b> already sold are never touched (§9.1).</span></li>
        </ul>
        <p className="text-xs text-ink-2">The exact last day of the window, and each subscriber's own date, are the engine's: the check and the simulation give them.</p>
      </section>
      <p className="flex items-baseline gap-2 text-sm text-ink-2">
        <Icon name="clock" size={15} className="translate-y-0.5" />
        Times are local to the market and stay local across clock changes (§3.7). A time the clocks skip or repeat is refused.
      </p>
    </div>
  );
}

function StepCheck({ change, dirty, canEdit, busy, problems, reason, onReason, onCheck, onSubmit, onGoTo, outcome }: {
  readonly change: Change | null;
  readonly dirty: boolean;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly problems: readonly Problem[];
  readonly reason: string;
  readonly onReason: (value: string) => void;
  readonly onCheck: () => void;
  readonly onSubmit: () => void;
  readonly onGoTo: (step: MigrationStep) => void;
  readonly outcome: { readonly kind: "saved" | "submitted"; readonly version: number } | null;
}) {
  const validation = change?.validation ?? null;
  const current = change !== null && validation !== null && validation.version === change.currentVersion && !dirty;
  const nextVersion = change === null ? 1 : dirty ? change.currentVersion + 1 : change.currentVersion;

  if (problems.length) {
    const steps = [...new Set(problems.map((problem) => migrationStepOf(problem.field)))].sort();
    return (
      <Callout tone="error" icon="warning-circle">
        <p className="font-bold">Some steps are not finished.</p>
        <ul className="mt-1 grid gap-1">
          {steps.map((index) => (
            <li key={index}>
              <button type="button" className="font-semibold text-indigo underline underline-offset-4" onClick={() => onGoTo(index)}>Step {index + 1}, {MIGRATION_STEPS[index]}</button>
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
              ? `The engine checks v${nextVersion} as it will be approved: that the price rises above the one in force, that the dates are to come and in order, that no other change already moves this price, the market's rules, and who has to sign.`
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
          <Findings
            version={validation.version}
            findings={validation.findings}
            stepOf={MIGRATION_STEP_OF_CHECK}
            stepNames={MIGRATION_STEPS}
            onGoTo={(next) => onGoTo(next as MigrationStep)}
            none={`No finding: nothing blocks it, and ${conditionSigner()} signs it as every price migration.`}
          />
          <p className="text-sm text-ink-2"><b className="text-ink">{validation.eligible.toLocaleString("en-GB")}</b> existing subscribers of the plan in the market right now, counted in the simulated data by the engine.</p>
          {validation.valid ? (
            <>
              <section className="grid gap-3" aria-labelledby="signs-heading">
                <h3 id="signs-heading" className="text-base font-bold">Who has to sign</h3>
                <SignaturesList signatures={change.requiredSignatures} />
              </section>
              <section className="grid gap-3" aria-labelledby="short-heading">
                <h3 id="short-heading" className="text-base font-bold">The simulation, in short</h3>
                <MigrationInShort changeId={change.id} version={change.currentVersion} />
              </section>
            </>
          ) : null}
          {validation.valid && change.state === "VALIDATED" ? (
            canEdit ? (
              <section className="grid gap-3" aria-labelledby="submit-heading">
                <h3 id="submit-heading" className="sr-only">Submit</h3>
                <TextAreaField id="author-reason" label="Why the price rises. Optional." hint={`${conditionSigner({ start: true })} reads this next to the numbers.`} rows={3} value={reason} maxLength={2000} onChange={onReason} />
                <Button weight="primary" icon="paper-plane-tilt" busy={busy} onClick={onSubmit} className="justify-self-start">Submit v{change.currentVersion} for approval</Button>
              </section>
            ) : <Locked>{whoDoes("createPriceMigration", { one: "submits price migrations for approval", many: "submit price migrations for approval" })}.</Locked>
          ) : null}
          {!validation.valid ? (
            <Callout tone="error" icon="warning">v{validation.version} cannot be submitted until the blocking findings are fixed. Fixing them makes a new version, checked again.</Callout>
          ) : null}
        </>
      ) : null}
      {outcome?.kind === "submitted" && change ? (
        <div className="grid gap-2 border-2 border-indigo bg-stone-0 p-4" role="status">
          <p className="flex items-center gap-2 text-lg font-bold"><Icon name="paper-plane-tilt" size={18} />v{outcome.version} is in approval.</p>
          <p>{change.requiredSignatures.map((signature) => `${signatureWords(signature)} has to sign`).join("; ")}. You wrote it, so someone else approves it (§7.4).</p>
          <ButtonLink href={approvalHref("PRICE_MIGRATION", change.id)} size="small" iconAfter="arrow-right" className="justify-self-start">Open the approval page</ButtonLink>
        </div>
      ) : change && change.state === "IN_APPROVAL" && !dirty && outcome === null ? (
        <Callout icon="hourglass-medium" tone="quiet">
          v{change.currentVersion} is in approval: {change.requiredSignatures.filter((signature) => !signature.signed).map((signature) => `${signatureWords(signature)} has to sign`).join("; ") || "every signature is there"}.{" "}
          <Link href={approvalHref("PRICE_MIGRATION", change.id)}>Open the approval page</Link>
        </Callout>
      ) : null}
    </div>
  );
}
