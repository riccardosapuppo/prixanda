"use client";
// The simulation of a price migration against not running it (business book
// §8.7): the verdict first, at the acceptance assumed; who pays what and from
// when; what one subscription brings before and after; the people who accept,
// who do not, and who would move to the Free plan; the revenue at risk; the
// prepaid passes it never touches. Beside it the assumptions, each with its
// source: the existing subscribers, counted in the data, and the acceptance,
// an illustrative default (90%, §16) that a person may change and put back.
// Every number is the engine's.
import { formatCount, formatMoney, formatPercent, type MoneyLike } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useId, useMemo, useState } from "react";
import { PageBody, PageHead } from "../../components/frame.tsx";
import { Button, Callout, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import { type AssumptionName, ChangeDocument, type ChangeQuery, MarketsDocument, SimulateMigrationDocument } from "../../graphql/generated.ts";
import { editHref } from "../../lib/kinds.ts";
import { marketName, planName } from "../../lib/markets.ts";
import { can, conditionSigner, otherwiseSigner, whoDoes } from "../../lib/permissions.ts";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";
import { useViewer } from "../../lib/react/session.tsx";
import { formatLocalWithUtc } from "../../lib/time.ts";
import { MarketsUnavailable } from "../../components/change-parts.tsx";
import { ChangeTabs } from "../campaigns/tabs.tsx";
import { AssumptionField, Fixed, ShareScale, sourceWords } from "../simulation/simulation.tsx";
import { acceptanceOf, ConditionsList, type MigrationSimulation, signed } from "./in-short.tsx";

type Change = NonNullable<ChangeQuery["change"]>;
type Markets = readonly { readonly code: string; readonly name: string; readonly timeZone: string; readonly currency: string }[];

const negative = (money: MoneyLike) => BigInt(money.amountMinor) < 0n;
const absolute = (money: MoneyLike): MoneyLike => ({ amountMinor: (negative(money) ? -BigInt(money.amountMinor) : BigInt(money.amountMinor)).toString(), currency: money.currency });
const difference = (after: MoneyLike, before: MoneyLike): MoneyLike => ({ amountMinor: (BigInt(after.amountMinor) - BigInt(before.amountMinor)).toString(), currency: after.currency });

export function MigrationSimulationScreen() {
  const id = useSearchParams().get("id") ?? "";
  const viewer = useViewer();
  const change = useGatewayQuery(ChangeDocument, { id }, { enabled: /^\d+$/.test(id) });
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const data = change.data?.change ?? null;
  const migration = data?.current.content.__typename === "PriceMigrationContent" ? data.current.content : null;

  const head = (
    <PageHead
      crumbs={[{ label: "Price migrations", href: "/price-migrations/" }, { label: data ? `${data.title} v${data.currentVersion}` : `Change #${id}`, href: editHref("PRICE_MIGRATION", id) }, { label: "Simulation" }]}
      title={data ? `Simulation: ${data.title}` : "Simulation"}
      sub={data?.sentence ? <span>v{data.currentVersion}: {data.sentence}</span> : data ? <span><StateChip state={data.state} /> v{data.currentVersion} has not been checked yet.</span> : null}
      simulated
    />
  );
  if (change.isPending || markets.isPending) return <>{head}<PageBody><Loading what="the price migration" lines={8} /></PageBody></>;
  if (change.isError) return <>{head}<PageBody><ErrorPanel error={change.error} retry={() => void change.refetch()} /></PageBody></>;
  if (data === null || migration === null) return <>{head}<PageBody><Callout tone="error" icon="warning">There is no price migration #{id} to simulate. <Link href="/price-migrations/">Back to the price migrations</Link>.</Callout></PageBody></>;
  // Without the markets, the day the existing subscribers are asked could not be read in the market's zone.
  const known = markets.data?.markets;
  if (known === undefined) return <>{head}<PageBody><MarketsUnavailable error={markets.error} retry={() => void markets.refetch()} /></PageBody></>;
  return (
    <>
      {head}
      <PageBody className="gap-6">
        <ChangeTabs kind="PRICE_MIGRATION" changeId={data.id} current="simulation" />
        {!can(viewer.roles, "simulate") ? (
          <Locked>{whoDoes("simulate", { one: "runs simulations", many: "run simulations" })}. The approval page shows this migration's figures in short.</Locked>
        ) : (
          <Simulator key={`${data.id}-${data.currentVersion}`} change={data} market={marketName(known, migration.market)} plan={planName(migration.plan)} markets={known} />
        )}
      </PageBody>
    </>
  );
}

function Simulator({ change, market, plan, markets }: { readonly change: Change; readonly market: string; readonly plan: string; readonly markets: Markets }) {
  const [typed, setTyped] = useState<Partial<Record<AssumptionName, number>>>({});
  const overrides = useMemo(() => Object.entries(typed).map(([name, value]) => ({ name: name as AssumptionName, value: value ?? 0 })), [typed]);
  const result = useGatewayQuery(SimulateMigrationDocument, { changeId: change.id, version: change.currentVersion, overrides: overrides.length ? overrides : null }, { keepPrevious: true, staleTime: 60_000 });
  const simulation = result.data?.simulateMigration.__typename === "MigrationSimulation" ? result.data.simulateMigration : null;
  const refusal = result.data?.simulateMigration.__typename === "Refusal" ? result.data.simulateMigration : null;
  return (
    <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(19rem,23rem)] xl:gap-12">
      <div className="grid min-w-0 content-start gap-8">
        {result.isError ? <ErrorPanel error={result.error} retry={() => void result.refetch()} /> : null}
        {refusal ? <Callout tone="error" icon="warning" role="alert"><p className="font-bold">Nothing to simulate yet.</p><p>{refusal.reason}</p></Callout> : null}
        {result.isPending ? <Loading what="the simulation" lines={8} /> : simulation ? <Results simulation={simulation} market={market} plan={plan} markets={markets} busy={result.isFetching} /> : null}
      </div>
      <aside className="grid min-w-0 content-start gap-6 xl:sticky xl:top-4" aria-label="Assumptions and signatures">
        {simulation ? <Assumptions simulation={simulation} typed={typed} onType={setTyped} busy={result.isFetching} /> : null}
        {simulation ? <WhoSigns simulation={simulation} /> : null}
      </aside>
    </div>
  );
}

function Results({ simulation, market, plan, markets, busy }: { readonly simulation: MigrationSimulation; readonly market: string; readonly plan: string; readonly markets: Markets; readonly busy: boolean }) {
  const acceptance = acceptanceOf(simulation);
  const revenue = simulation.monthlyRevenueChange;
  const falls = negative(revenue);
  const evenRevenue = simulation.breakEvenAcceptanceRevenueBasisPoints;
  const evenContribution = simulation.breakEvenAcceptanceContributionBasisPoints;
  const zone = markets.find((entry) => entry.code === simulation.noticesFrom.market)?.timeZone ?? "UTC";
  const consent = /consent/.test(simulation.existingFrom);
  return (
    <div className="grid gap-8" aria-busy={busy || undefined}>
      <section className="grid gap-3" aria-labelledby="verdict">
        <h2 id="verdict" className="max-w-[32ch] text-[clamp(1.5rem,1.1rem+0.9vw,2rem)] leading-tight font-bold tracking-[-0.01em] text-balance">
          If {formatPercent(acceptance)} accept, revenue {falls ? "falls" : "rises"} by{" "}
          <span className={`whitespace-nowrap ${falls ? "underline decoration-madder decoration-[3px] underline-offset-[0.14em]" : ""}`}>{formatMoney(absolute(revenue))}</span> a month in {market}.
        </h2>
        <p className="flex items-baseline gap-2 text-lg font-semibold">
          <Icon name="scales" size={18} className="translate-y-0.5 text-indigo" />
          {evenRevenue === null
            ? "Nobody leaves over it here: those who do not accept keep their price, so no acceptance is needed to hold revenue."
            : `Revenue holds if at least ${formatPercent(evenRevenue)} accept${evenContribution !== null ? `; the contribution holds from ${formatPercent(evenContribution)}` : ""}.`}
        </p>
        <ShareScale assumed={acceptance} breakEven={evenRevenue} what="Acceptance" caption="Existing subscribers who accept the new price" />
        <p className="max-w-[70ch] text-sm text-ink-2">Per month, net of VAT, against not running the migration. The simulation applies the business book's formulas (§8.7) to these assumptions: it does not forecast and learns nothing from data.</p>
      </section>

      <section className="grid gap-3 border-t-2 border-ink pt-3" aria-labelledby="from-when">
        <h2 id="from-when" className="text-xl font-bold">Who pays what, from when</h2>
        <dl className="m-0 grid gap-3">
          <Row icon="users" term={`New subscribers of ${plan} in ${market}`}>
            {formatMoney(simulation.after.price)} from {formatLocalWithUtc(simulation.newSubscribersFrom.local, zone)}.
          </Row>
          <Row icon="clock-countdown" term={`The ${formatCount(simulation.existing)} existing subscribers`}>
            {consent ? "Asked for their consent" : "Told"} from {formatLocalWithUtc(simulation.noticesFrom.local, zone)}; the window ends {formatLocalWithUtc(simulation.windowEnds.local, zone)}.
            They pay {formatMoney(simulation.after.price)} {simulation.existingFrom}.
          </Row>
          <Row icon="gift" term="Prepaid passes">
            {formatCount(simulation.prepaidPassesUntouched)} of {plan} in {market}: never touched by a later price (§9.1).
          </Row>
        </dl>
      </section>

      <section className="grid gap-4 border-t-2 border-ink pt-3" aria-labelledby="per-subscription">
        <h2 id="per-subscription" className="text-xl font-bold">One subscription, per month</h2>
        <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="per-subscription">
          <table className="data min-w-[30rem]">
            <thead>
              <tr><th scope="col">Per subscription</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Difference</th></tr>
            </thead>
            <tbody>
              {([
                ["Price, VAT included", "price"],
                ["Net of VAT", "net"],
                ["Owed to artists", "artists"],
                ["Payment costs", "paymentCosts"],
              ] as const).map(([label, key]) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td>{formatMoney(simulation.before[key])}</td>
                  <td>{formatMoney(simulation.after[key])}</td>
                  <td>{signed(difference(simulation.after[key], simulation.before[key]))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th scope="row">Contribution</th><td>{formatMoney(simulation.before.contribution)}</td><td>{formatMoney(simulation.after.contribution)}</td><td>{signed(difference(simulation.after.contribution, simulation.before.contribution))}</td></tr>
            </tfoot>
          </table>
        </div>
        <p className="flex items-baseline gap-2 text-xs text-ink-2">
          <Icon name="info" size={14} className="translate-y-0.5" />
          The artists' share is never less than the minimum (§5.3); the contribution is what stays after the artists and the payment costs (§5.7).
        </p>
      </section>

      <section className="grid gap-4 border-t-2 border-ink pt-3" aria-labelledby="people">
        <h2 id="people" className="text-xl font-bold">People</h2>
        <ol className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-3">
          <Flow figure={formatCount(simulation.existing)} words={/^typed by/.test(simulation.assumptions.find((assumption) => assumption.name === "EXISTING")?.source ?? "") ? "existing subscribers, as typed in the assumptions" : "existing subscribers, counted in the simulated data"} />
          <Flow arrow figure={formatCount(simulation.accepting)} words={`accept, at ${formatPercent(acceptance)} acceptance`} />
          <Flow arrow figure={formatCount(simulation.notAccepting)} words={simulation.movingToFree > 0 ? `do not; ${formatCount(simulation.movingToFree)} would move to the Free plan, by the music service's choice` : "do not, and keep their price, by the music service's choice"} />
        </ol>
      </section>

      <section className="grid gap-3 border-t-2 border-ink pt-3" aria-labelledby="at-risk">
        <h2 id="at-risk" className="text-xl font-bold">Revenue at risk</h2>
        <p className="max-w-[70ch]">
          The {formatCount(simulation.notAccepting)} who do not accept pay <b>{formatMoney(simulation.revenueAtRiskMonthly)}</b> a month today, net of VAT: what the migration puts at risk.
          With what the {formatCount(simulation.accepting)} who accept add, revenue changes by {signed(simulation.monthlyRevenueChange)} a month all together, and the contribution by {signed(simulation.monthlyContributionChange)}.
        </p>
        {falls ? (
          <p className="flex items-baseline gap-2"><Icon name="warning" size={16} className="translate-y-0.5 text-madder" /><span>At this acceptance the migration loses revenue: {conditionSigner()} reads it next to the reason for the rise.</span></p>
        ) : null}
      </section>
    </div>
  );
}

function Row({ icon, term, children }: { readonly icon: "users" | "clock-countdown" | "gift"; readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 border-b border-cord pb-3">
      <Icon name={icon} size={18} className="row-span-2 mt-0.5 text-indigo" />
      <dt className="font-bold">{term}</dt>
      <dd className="m-0 col-start-2 max-w-[70ch]">{children}</dd>
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

function Assumptions({ simulation, typed, onType, busy }: {
  readonly simulation: MigrationSimulation;
  readonly typed: Partial<Record<AssumptionName, number>>;
  readonly onType: (next: Partial<Record<AssumptionName, number>>) => void;
  readonly busy: boolean;
}) {
  const headingId = useId();
  const existing = simulation.assumptions.find((assumption) => assumption.name === "EXISTING");
  const acceptance = simulation.assumptions.find((assumption) => assumption.name === "ACCEPTANCE");
  return (
    <section className="grid gap-3 border border-ink-3 bg-stone-0 p-4" aria-labelledby={headingId} aria-busy={busy || undefined}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="text-xl font-bold">Assumptions</h2>
        <Button size="small" weight="quiet" icon="arrow-counter-clockwise" disabled={Object.keys(typed).length === 0} onClick={() => onType({})}>Reset</Button>
      </div>
      {existing ? <Fixed label="Existing subscribers" value={formatCount(existing.value)} source={sourceWords(existing.source)} icon="database" /> : null}
      {acceptance ? (
        <AssumptionField
          name="ACCEPTANCE"
          label="Acceptance"
          hint="Share of existing subscribers who accept the new price: an assumption, not a forecast"
          value={acceptance.value}
          source={sourceWords(acceptance.source)}
          typed={"ACCEPTANCE" in typed}
          onApply={(bp) => onType({ ...typed, ACCEPTANCE: bp })}
        />
      ) : null}
      <p className="text-xs text-ink-2">Change the acceptance to see the revenue at risk and the people move. Nothing here is saved with the migration.</p>
    </section>
  );
}

function WhoSigns({ simulation }: { readonly simulation: MigrationSimulation }) {
  const met = simulation.financeConditions.filter((condition) => condition.met).map((condition) => condition.number);
  return (
    <section className="grid gap-3 border border-cord bg-stone-0 p-4" aria-labelledby="signs">
      <h2 id="signs" className="text-xl font-bold">Who has to sign</h2>
      <ConditionsList conditions={simulation.financeConditions} />
      <p className="text-sm">
        {met.length ? <><b>{conditionSigner({ start: true })} signs</b>: condition{met.length > 1 ? "s" : ""} {met.join(met.length > 2 ? ", " : " and ")}.</> : <>No condition is met: <b>{otherwiseSigner()}</b> signs.</>}
      </p>
    </section>
  );
}
