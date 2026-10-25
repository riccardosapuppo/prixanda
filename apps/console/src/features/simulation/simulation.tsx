"use client";
// The simulation of a campaign against not running it (business book §6.6):
// the verdict first, then where it breaks even, the money with the offer and
// without it, the people, the risks, and on the side the assumptions, each
// with its source, which a person may change and put back. Every number is
// the engine's: the console sends the assumptions and shows what comes back.
import { formatCount, formatMoney, formatPercent, type MoneyLike } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Button, Callout, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import { type AssumptionName, ChangeDocument, type ChangeQuery, MarketsDocument, SimulateOfferDocument, type SimulateOfferQuery } from "../../graphql/generated.ts";
import { marketName } from "../../lib/markets.ts";
import { can, conditionSigner, otherwiseSigner, ROLES, TEAM, whoDoes } from "../../lib/permissions.ts";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";
import { useViewer } from "../../lib/react/session.tsx";
import { formatInstantIn } from "../../lib/time.ts";
import { CampaignTabs } from "../campaigns/tabs.tsx";

type Simulation = Extract<SimulateOfferQuery["simulateOffer"], { readonly __typename: "Simulation" }>;
type Change = NonNullable<ChangeQuery["change"]>;

const EDITABLE: readonly { readonly name: AssumptionName; readonly label: string; readonly hint: string }[] = [
  { name: "TAKE_UP", label: "Take-up", hint: "Share of the eligible audience that takes the offer" },
  { name: "INCREMENTAL", label: "Incremental share", hint: "Takers who would not have subscribed without the offer" },
  { name: "RETENTION", label: "Retention", hint: "Takers who stay at the list price after the offer" },
];

/** The engine names who typed a value in lower case ("typed by marketing"); the console names roles as the team's table says them. */
const TYPED_BY: Readonly<Record<string, string>> = Object.fromEntries(ROLES.map((role) => [TEAM.roles[role].said.toLowerCase(), TEAM.roles[role].said]));

/** "typed by marketing at 2026-10-24T18:13:05Z" as "Typed by Marketing at 24 Oct 20:13 Rome". */
export function sourceWords(source: string): string {
  const text = source
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/, (instant) => formatInstantIn(instant, CONSOLE_ZONE))
    .replace(/^typed by (.+?) at /, (_, who: string) => `typed by ${TYPED_BY[who] ?? who} at `);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "12" or "12.5" percent as basis points; null when it is not a share from 0 to 100. */
export function percentInput(text: string): number | null {
  const match = /^\s*(\d{1,3})(?:[.,](\d{1,2}))?\s*%?\s*$/.exec(text);
  if (match === null) return null;
  const value = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return value <= 10_000 ? value : null;
}

const negative = (money: MoneyLike) => BigInt(money.amountMinor) < 0n;
const absolute = (money: MoneyLike): MoneyLike => ({ amountMinor: (negative(money) ? -BigInt(money.amountMinor) : BigInt(money.amountMinor)).toString(), currency: money.currency });

export function SimulationScreen() {
  const search = useSearchParams();
  const id = search.get("id") ?? "";
  const viewer = useViewer();
  const change = useGatewayQuery(ChangeDocument, { id }, { enabled: /^\d+$/.test(id) });
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const data = change.data?.change ?? null;
  const offer = data?.current.content.__typename === "OfferContent" ? data.current.content : null;
  const sold = offer ? offer.prices.map((price) => price.market) : [];
  const market = sold.includes(search.get("market") ?? "") ? (search.get("market") ?? "") : (sold[0] ?? "");

  const head = (
    <PageHead
      crumbs={[{ label: "Campaigns", href: "/campaigns/" }, { label: data ? `${data.title} v${data.currentVersion}` : `Change #${id}`, href: `/campaigns/edit/?id=${id}` }, { label: "Simulation" }]}
      title={data ? `Simulation: ${data.title}` : "Simulation"}
      sub={data?.sentence ? <span>v{data.currentVersion}: {data.sentence}</span> : data ? <span><StateChip state={data.state} /> v{data.currentVersion} has not been checked yet.</span> : null}
      simulated
    />
  );

  if (change.isPending || markets.isPending) return <>{head}<PageBody><Loading what="the campaign" lines={8} /></PageBody></>;
  if (change.isError) return <>{head}<PageBody><ErrorPanel error={change.error} retry={() => void change.refetch()} /></PageBody></>;
  if (data === null || offer === null) return <>{head}<PageBody><Callout tone="error" icon="warning">There is no campaign #{id} to simulate. <Link href="/campaigns/">Back to the campaigns</Link>.</Callout></PageBody></>;

  return (
    <>
      {head}
      <PageBody className="gap-6">
        <CampaignTabs changeId={data.id} current="simulation" />
        {!can(viewer.roles, "simulate") ? (
          <Locked>{whoDoes("simulate", { one: "runs simulations", many: "run simulations" })}. The approval page shows this campaign's figures in short.</Locked>
        ) : sold.length === 0 ? (
          <Callout icon="info" tone="quiet">v{data.currentVersion} has no price yet: give it one in the campaign's step 2, and it can be simulated.</Callout>
        ) : (
          <Simulator key={`${data.id}-${data.currentVersion}-${market}`} change={data} market={market} sold={sold} marketNames={markets.data?.markets ?? []} />
        )}
      </PageBody>
    </>
  );
}

function Simulator({ change, market, sold, marketNames }: { readonly change: Change; readonly market: string; readonly sold: readonly string[]; readonly marketNames: readonly { readonly code: string; readonly name: string; readonly timeZone: string; readonly currency: string }[] }) {
  const router = useRouter();
  const [typed, setTyped] = useState<Partial<Record<AssumptionName, number>>>({});
  const overrides = useMemo(() => Object.entries(typed).map(([name, value]) => ({ name: name as AssumptionName, value: value ?? 0 })), [typed]);
  const result = useGatewayQuery(SimulateOfferDocument, { changeId: change.id, version: change.currentVersion, market, overrides: overrides.length ? overrides : null }, { keepPrevious: true, staleTime: 60_000 });
  const simulation = result.data?.simulateOffer.__typename === "Simulation" ? result.data.simulateOffer : null;
  const refusal = result.data?.simulateOffer.__typename === "Refusal" ? result.data.simulateOffer : null;

  return (
    <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(19rem,23rem)] xl:gap-12">
      <div className="grid min-w-0 content-start gap-8">
        {sold.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink-2">Market</span>
            <div className="inline-flex rounded-control border border-edge bg-stone-0" role="group" aria-label="Market">
              {sold.map((code) => (
                <button key={code} type="button" aria-pressed={code === market} onClick={() => router.replace(`/campaigns/simulation/?id=${change.id}&market=${code}`, { scroll: false })} className={`min-h-9 pointer-coarse:min-h-11 px-3 text-sm font-semibold [&+&]:border-l [&+&]:border-edge ${code === market ? "bg-ink text-stone-0" : "hover:bg-stone-2"}`}>
                  {marketName(marketNames, code)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {result.isError ? <ErrorPanel error={result.error} retry={() => void result.refetch()} /> : null}
        {refusal ? <Callout tone="error" icon="warning" role="alert"><p className="font-bold">Nothing to simulate yet.</p><p>{refusal.reason}</p></Callout> : null}
        {result.isPending ? <Loading what="the simulation" lines={8} /> : simulation ? <Results simulation={simulation} change={change} market={marketName(marketNames, market)} busy={result.isFetching} /> : null}
      </div>
      <aside className="grid min-w-0 content-start gap-6 xl:sticky xl:top-4" aria-label="Assumptions and signatures">
        {simulation ? <Assumptions simulation={simulation} typed={typed} onType={setTyped} busy={result.isFetching} /> : null}
        {simulation ? <WhoSigns simulation={simulation} /> : null}
      </aside>
    </div>
  );
}

function Results({ simulation, change, market, busy }: { readonly simulation: Simulation; readonly change: Change; readonly market: string; readonly busy: boolean }) {
  const contribution = simulation.difference.contribution;
  const loses = negative(contribution);
  const months = simulation.horizonMonths;
  const retention = simulation.assumptions.find((assumption) => assumption.name === "RETENTION")?.value ?? 0;
  const takeUp = simulation.assumptions.find((assumption) => assumption.name === "TAKE_UP")?.value ?? 0;
  const incremental = simulation.assumptions.find((assumption) => assumption.name === "INCREMENTAL")?.value ?? 0;
  const breakEven = simulation.breakEvenRetentionBasisPoints;
  const offer = change.current.content.__typename === "OfferContent" ? change.current.content : null;
  const offerMonths = offer?.monthsAtOfferPrice ?? 0;
  const threshold = simulation.financeConditions.find((condition) => condition.number === 3);

  return (
    <div className="grid gap-8" aria-busy={busy || undefined}>
      <section className="grid gap-3" aria-labelledby="verdict">
        <h2 id="verdict" className="max-w-[30ch] text-[clamp(1.5rem,1.1rem+0.9vw,2rem)] leading-tight font-bold tracking-[-0.01em] text-balance">
          At these assumptions the campaign {loses ? "loses" : "earns"}{" "}
          <span className={`whitespace-nowrap ${loses ? "underline decoration-madder decoration-[3px] underline-offset-[0.14em]" : ""}`}>{formatMoney(absolute(contribution))}</span> over {months} months in {market}.
        </h2>
        <p className="flex items-baseline gap-2 text-lg font-semibold">
          <Icon name="scales" size={18} className="translate-y-0.5 text-indigo" />
          {breakEven === null || breakEven < 0
            ? "No retention makes it break even: even if every taker stayed, it would not pay for itself over the horizon."
            : `It breaks even if at least ${formatPercent(breakEven)} of takers stay at the list price.`}
        </p>
        <ShareScale assumed={retention} breakEven={breakEven} what="Retention" caption="Retention after the offer months" />
        <p className="max-w-[70ch] text-sm text-ink-2">The simulation applies the business book's formulas (§6.6) to these assumptions. It does not forecast and learns nothing from data.</p>
      </section>

      <section className="grid gap-4 border-t-2 border-ink pt-3" aria-labelledby="money">
        <h2 id="money" className="text-xl font-bold">With the offer and without, over {months} months</h2>
        <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="money">
          <table className="data min-w-[30rem]">
            <thead>
              <tr><th scope="col">Net of VAT</th><th scope="col">With the offer</th><th scope="col">Without</th><th scope="col">Difference</th></tr>
            </thead>
            <tbody>
              <tr><th scope="row">Revenue without VAT</th><td>{formatMoney(simulation.withOffer.revenue)}</td><td>{formatMoney(simulation.withoutOffer.revenue)}</td><td>{formatMoney(simulation.difference.revenue)}</td></tr>
              <tr><th scope="row">Owed to artists</th><td>{formatMoney(simulation.withOffer.artists)}</td><td>{formatMoney(simulation.withoutOffer.artists)}</td><td>{formatMoney(simulation.difference.artists)}</td></tr>
              <tr><th scope="row">Payment costs</th><td>{formatMoney(simulation.withOffer.paymentCosts)}</td><td>{formatMoney(simulation.withoutOffer.paymentCosts)}</td><td>{formatMoney(simulation.difference.paymentCosts)}</td></tr>
            </tbody>
            <tfoot>
              <tr><th scope="row">Contribution</th><td /><td /><td>{formatMoney(contribution)}</td></tr>
            </tfoot>
          </table>
        </div>
        <p className="flex items-baseline gap-2 text-xs text-ink-2">
          <Icon name="info" size={14} className="translate-y-0.5" />
          With the offer: the {formatCount(simulation.takers)} takers over {months} months. Without: the {formatCount(simulation.cannibalized)} of them who would have paid the list price anyway. The contribution is compared, not the two columns: they are different people.
        </p>
        <dl className="m-0 flex flex-wrap gap-x-8 gap-y-3 border border-cord bg-stone-0 px-4 py-3">
          <div className="grid"><dt className="text-xs text-ink-2">Discount cost</dt><dd className="m-0 text-lg font-bold">{formatMoney(simulation.discountCost)}</dd></div>
          <div className="grid"><dt className="text-xs text-ink-2">Top-up cost</dt><dd className="m-0 text-lg font-bold">{formatMoney(simulation.topUpCost)}</dd></div>
          {threshold ? <div className="grid max-w-[24rem]"><dt className="text-xs text-ink-2">Together, against {conditionSigner()}'s threshold</dt><dd className="m-0 font-semibold">{threshold.detail}</dd></div> : null}
        </dl>
      </section>

      <section className="grid gap-4 border-t-2 border-ink pt-3" aria-labelledby="people">
        <h2 id="people" className="text-xl font-bold">People</h2>
        <ol className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-3">
          <Flow figure={formatCount(simulation.eligible)} words="eligible, counted in the simulated data" />
          <Flow arrow figure={formatCount(simulation.takers)} words={`take the offer, at ${formatPercent(takeUp)} take-up`} />
          <Flow arrow figure={formatCount(simulation.stayers)} words={`stay at the list price after month ${offerMonths}, at ${formatPercent(retention)} retention`} />
        </ol>
        <p className="flex items-baseline gap-2">
          <Icon name="users" size={16} className="translate-y-0.5" />
          <span><b>{formatCount(simulation.cannibalized)}</b> of the {formatCount(simulation.takers)} takers would have paid the list price anyway ({formatPercent(10_000 - incremental)} not incremental): that is the discount cost.</span>
        </p>
      </section>

      <section className="grid gap-3 border-t-2 border-ink pt-3" aria-labelledby="risks">
        <h2 id="risks" className="text-xl font-bold">Risks</h2>
        <ul role="list" className="grid">
          {loses ? <Risk icon="warning">At these assumptions the campaign loses {formatMoney(absolute(contribution))} over {months} months: the author has to say why it is still worth running, and {conditionSigner()} signs (§7.3, condition 4).</Risk> : null}
          {simulation.financeConditions.filter((condition) => condition.met && condition.number !== 4).map((condition) => (
            <Risk key={condition.number} icon="warning">{condition.detail}. {conditionSigner({ start: true })} signs (§7.3, condition {condition.number}).</Risk>
          ))}
          <Risk icon="info">Top-up cost: {formatMoney(simulation.topUpCost)}, what keeping the artists at their minimum costs over the offer months.</Risk>
          <Risk icon="info">Discount cost: {formatMoney(simulation.discountCost)}, revenue given up on the {formatCount(simulation.cannibalized)} takers who would have paid anyway.</Risk>
        </ul>
      </section>
    </div>
  );
}

function Flow({ figure, words, arrow = false }: { readonly figure: string; readonly words: string; readonly arrow?: boolean }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 border-t border-cord pt-2">
      {arrow ? <Icon name="arrow-right" size={16} className="row-span-2 text-ink-2" /> : <span className="row-span-2" />}
      <b className="text-3xl font-bold leading-tight">{figure}</b>
      <span className="col-start-2 text-sm text-ink-2">{words}</span>
    </li>
  );
}

function Risk({ icon, children }: { readonly icon: "warning" | "info"; readonly children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 border-b border-cord py-2">
      <Icon name={icon} size={18} className={`mt-0.5 ${icon === "warning" ? "text-madder" : "text-indigo"}`} />
      <span>{children}</span>
    </li>
  );
}

/** A share from 0 to 100% (retention, acceptance): the assumption above the line, the break-even below, the gap between them woven. */
export function ShareScale({ assumed, breakEven, what, caption }: { readonly assumed: number; readonly breakEven: number | null; readonly what: string; readonly caption: string }) {
  const at = (bp: number) => `${Math.min(100, Math.max(0, bp / 100))}%`;
  const even = breakEven !== null && breakEven >= 0 ? breakEven : null;
  const low = even === null ? assumed : Math.min(assumed, even);
  const high = even === null ? assumed : Math.max(assumed, even);
  const margin = even !== null && assumed >= even;
  return (
    <div className="relative mb-5 grid max-w-[46rem] gap-1.5 py-11" role="img" aria-label={`${what} scale: ${formatPercent(assumed)} assumed${even === null ? ", no break-even" : `, break-even at ${formatPercent(even)}`}.`}>
      <div className="relative h-3 bg-stone-2 shadow-[inset_0_0_0_1px_var(--color-edge)]">
        {even !== null ? (
          <div className={`absolute top-0 bottom-0 ${margin ? "bg-silk-saffron shadow-[inset_0_0_0_1px_var(--color-saffron)]" : "weave-cross bg-stone-0 shadow-[inset_0_0_0_1px_var(--color-ink)]"}`} style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />
        ) : null}
        <div className={`absolute bottom-0 grid h-[3.1rem] content-start text-xs leading-snug whitespace-nowrap ${assumed > 7000 ? "-translate-x-full border-r-2 border-ink pr-1.5 text-right" : "border-l-2 border-ink pl-1.5"}`} style={{ left: at(assumed) }}>
          <b className="text-md">{formatPercent(assumed)}</b>assumed
        </div>
        {even !== null ? (
          <div className={`absolute top-0 grid h-[3.1rem] content-end text-xs leading-snug whitespace-nowrap ${even > 7000 ? "-translate-x-full border-r-2 border-dashed border-ink pr-1.5 text-right" : "border-l-2 border-dashed border-ink pl-1.5"}`} style={{ left: at(even) }}>
            <b className="text-md">{formatPercent(even)}</b>break-even
          </div>
        ) : null}
      </div>
      <div className="absolute inset-x-0 bottom-0 flex justify-between gap-3 text-2xs text-ink-2" aria-hidden="true">
        <span>0%</span>
        <span>100%</span>
      </div>
      <p className="absolute right-0 bottom-[-1.4rem] left-0 text-center text-2xs text-ink-2">{caption}</p>
    </div>
  );
}

function Assumptions({ simulation, typed, onType, busy }: {
  readonly simulation: Simulation;
  readonly typed: Partial<Record<AssumptionName, number>>;
  readonly onType: (next: Partial<Record<AssumptionName, number>>) => void;
  readonly busy: boolean;
}) {
  const headingId = useId();
  const value = (name: AssumptionName) => simulation.assumptions.find((assumption) => assumption.name === name);
  const eligible = value("ELIGIBLE");
  const horizon = value("HORIZON_MONTHS");
  return (
    <section className="grid gap-3 border border-ink-3 bg-stone-0 p-4" aria-labelledby={headingId} aria-busy={busy || undefined}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="text-xl font-bold">Assumptions</h2>
        <Button size="small" weight="quiet" icon="arrow-counter-clockwise" disabled={Object.keys(typed).length === 0} onClick={() => onType({})}>Reset</Button>
      </div>
      {eligible ? <Fixed label="Eligible audience" value={formatCount(eligible.value)} source={sourceWords(eligible.source)} icon="database" /> : null}
      {EDITABLE.map((entry) => {
        const assumption = value(entry.name);
        return assumption ? (
          <AssumptionField key={entry.name} name={entry.name} label={entry.label} hint={entry.hint} value={assumption.value} source={sourceWords(assumption.source)} typed={entry.name in typed} onApply={(bp) => onType({ ...typed, [entry.name]: bp })} />
        ) : null;
      })}
      {horizon ? <Fixed label="Horizon" value={`${horizon.value} months`} source={sourceWords(horizon.source)} icon="calendar-blank" /> : null}
    </section>
  );
}

export function Fixed({ label, value, source, icon }: { readonly label: string; readonly value: string; readonly source: string; readonly icon: "database" | "calendar-blank" }) {
  return (
    <div className="grid gap-1 border-b border-cord pb-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <span className="label">{label}</span>
        <span className="locked min-h-9 text-sm"><Icon name="lock-simple" size={14} />{value}</span>
      </div>
      <span className="inline-flex items-center gap-1.5 text-2xs text-ink-2"><Icon name={icon} size={13} />{source}</span>
    </div>
  );
}

export function AssumptionField({ name, label, hint, value, source, typed, onApply }: {
  readonly name: string;
  readonly label: string;
  readonly hint: string;
  readonly value: number;
  readonly source: string;
  readonly typed: boolean;
  readonly onApply: (basisPoints: number) => void;
}) {
  const shown = (value / 100).toString();
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const id = `assume-${name.toLowerCase()}`;
  useEffect(() => setText(shown), [shown]);
  const apply = () => {
    const parsed = percentInput(text);
    if (parsed === null) {
      setError("A share from 0 to 100, like 12 or 12.5.");
      return;
    }
    setError(null);
    if (parsed !== value) onApply(parsed);
  };
  return (
    <div className="grid gap-1 border-b border-cord pb-3">
      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-3">
        <label htmlFor={id} className="label leading-snug">{label}<span className="block text-2xs font-medium text-ink-2">{hint}</span></label>
        <span className="relative block">
          <input
            id={id}
            className="input pr-8"
            inputMode="decimal"
            value={text}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-source${error ? ` ${id}-error` : ""}`}
            onChange={(event) => setText(event.target.value)}
            onBlur={apply}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                apply();
              }
            }}
          />
          <b className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-semibold text-ink-2">%</b>
        </span>
      </div>
      <span id={`${id}-source`} className={`inline-flex items-center gap-1.5 text-2xs ${typed ? "font-bold text-ink" : "text-ink-2"}`}>
        <Icon name={typed ? "pen-nib" : "scroll"} size={13} className={typed ? "text-indigo" : ""} />
        {source}
      </span>
      {error ? <p id={`${id}-error`} className="field-error"><Icon name="warning-circle" size={16} />{error}</p> : null}
    </div>
  );
}

function WhoSigns({ simulation }: { readonly simulation: Simulation }) {
  const met = simulation.financeConditions.filter((condition) => condition.met).map((condition) => condition.number);
  return (
    <section className="grid gap-3 border border-cord bg-stone-0 p-4" aria-labelledby="signs">
      <h2 id="signs" className="text-xl font-bold">Who has to sign</h2>
      <ol className="m-0 grid list-none p-0">
        {simulation.financeConditions.map((condition) => (
          <li key={condition.number} className={`grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-2 border-b border-cord py-2 text-sm ${condition.met ? "" : "text-ink-2"}`}>
            <span className="font-bold text-ink-2">{condition.number}</span>
            <span className={condition.met ? "font-semibold" : ""}>{condition.rule}<small className="block text-xs font-normal text-ink-2">{condition.detail}</small></span>
            <span className="inline-flex items-center gap-1 text-xs font-bold whitespace-nowrap">{condition.met ? <><Icon name="check" size={13} />Met</> : "Not met"}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm">
        {met.length ? <><b>{conditionSigner({ start: true })} signs</b>: condition{met.length > 1 ? "s" : ""} {met.join(met.length > 2 ? ", " : " and ")} in this market.</> : <>No condition is met here: <b>{otherwiseSigner()}</b> signs.</>}
      </p>
      {met.includes(4) ? <p className="text-xs text-ink-2">Why is it worth running? Required: the contribution over {simulation.horizonMonths} months is negative.</p> : null}
    </section>
  );
}
