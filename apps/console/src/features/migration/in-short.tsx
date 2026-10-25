"use client";
// A price migration's simulation in a few sentences (business book §8.7),
// where a decision is made: the last step of its form and its approval page.
// The numbers are the engine's at the book's assumptions; the simulation page
// has them all, with the acceptance to change.
import { formatCount, formatMoney, formatPercent, type MoneyLike } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { ErrorPanel, Loading } from "../../components/ui.tsx";
import { SimulateMigrationDocument, type SimulateMigrationQuery } from "../../graphql/generated.ts";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";

export type MigrationSimulation = Extract<SimulateMigrationQuery["simulateMigration"], { readonly __typename: "MigrationSimulation" }>;

const negative = (money: MoneyLike) => BigInt(money.amountMinor) < 0n;

/** "+€3,742.20" or "−€1,000.00": a change of money, its sign always written. */
export function signed(money: MoneyLike): string {
  return negative(money) ? formatMoney(money) : `+${formatMoney(money)}`;
}

/** The assumed acceptance, in basis points. */
export function acceptanceOf(simulation: MigrationSimulation): number {
  return simulation.assumptions.find((assumption) => assumption.name === "ACCEPTANCE")?.value ?? 0;
}

/** The figures that decide, in sentences: per subscription, then all together at the assumed acceptance. */
export function MigrationSummary({ simulation }: { readonly simulation: MigrationSimulation }) {
  const acceptance = acceptanceOf(simulation);
  const source = simulation.assumptions.find((assumption) => assumption.name === "ACCEPTANCE")?.source ?? "";
  const illustrative = /illustrative/.test(source);
  return (
    <div className="grid gap-3">
      <p className="max-w-[75ch]">
        Per subscription that accepts, each month: {formatMoney(simulation.before.price)} becomes {formatMoney(simulation.after.price)}; net of VAT{" "}
        {formatMoney(simulation.before.net)} becomes {formatMoney(simulation.after.net)}, and the artists' share {formatMoney(simulation.before.artists)} becomes{" "}
        {formatMoney(simulation.after.artists)}.
      </p>
      <p className="max-w-[75ch]">
        If {formatPercent(acceptance)} of the {formatCount(simulation.existing)} existing subscribers accept ({illustrative ? "an illustrative assumption" : "an assumption typed in the simulation"}),
        revenue changes by <b>{signed(simulation.monthlyRevenueChange)}</b> a month and the contribution by <b>{signed(simulation.monthlyContributionChange)}</b>.{" "}
        The {formatCount(simulation.notAccepting)} who do not accept pay {formatMoney(simulation.revenueAtRiskMonthly)} a month today: that is the revenue at risk
        {simulation.movingToFree > 0 ? `, and ${formatCount(simulation.movingToFree)} of them would move to the Free plan` : ""}.
      </p>
      <p className="flex items-baseline gap-2 text-sm">
        <Icon name="gift" size={15} className="translate-y-0.5 text-indigo" />
        <span>{formatCount(simulation.prepaidPassesUntouched)} prepaid {simulation.prepaidPassesUntouched === 1 ? "pass" : "passes"} of this plan and market: never touched by a later price (§9.1).</span>
      </p>
    </div>
  );
}

/** The conditions of §7.3 the simulation finds, met or not, with the engine's numbers. */
export function ConditionsList({ conditions }: { readonly conditions: MigrationSimulation["financeConditions"] }) {
  return (
    <ol className="m-0 grid list-none p-0">
      {conditions.map((condition) => (
        <li key={condition.number} className={`grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-2 border-b border-cord py-2 ${condition.met ? "" : "text-ink-2"}`}>
          <span className="font-bold text-ink-2">{condition.number}</span>
          <span className={condition.met ? "font-semibold" : ""}>{condition.rule}<small className="block text-xs font-normal text-ink-2">{condition.detail}</small></span>
          <span className="inline-flex items-center gap-1 text-xs font-bold whitespace-nowrap">{condition.met ? <><Icon name="check" size={13} />Met</> : "Not met"}</span>
        </li>
      ))}
    </ol>
  );
}

/** The simulation of a version, in short, with the way to the whole of it. */
export function MigrationInShort({ changeId, version }: { readonly changeId: string; readonly version: number }) {
  const result = useGatewayQuery(SimulateMigrationDocument, { changeId, version, overrides: null }, { staleTime: 60_000 });
  if (result.isPending) return <Loading what="the simulation" lines={3} />;
  if (result.isError) return <ErrorPanel error={result.error} retry={() => void result.refetch()} />;
  const outcome = result.data.simulateMigration;
  if (outcome.__typename === "Refusal") return <p className="text-ink-2">{outcome.reason}</p>;
  return (
    <>
      <MigrationSummary simulation={outcome} />
      <ConditionsList conditions={outcome.financeConditions} />
      <p><Link href={`/price-migrations/simulation/?id=${changeId}`} className="inline-flex items-center gap-1.5 font-semibold pointer-coarse:-my-3 pointer-coarse:py-3"><Icon name="calculator" size={16} />Open the simulation</Link></p>
    </>
  );
}
