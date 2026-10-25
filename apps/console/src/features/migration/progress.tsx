"use client";
// Where a price migration stands with the existing subscribers of its plan in
// its market, once its requests went out (business book §8): how many were
// asked or told, and of them who has not answered yet, who accepted, who said
// no, who let the window run out (silence is no in a consent market, §8.2),
// who pays the new price, and who leaves the paid plan by the market's
// choice. The counts are the engine's, read again while answers can still
// come.
import { formatCount } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Callout, ErrorPanel, Loading, StateChip } from "../../components/ui.tsx";
import { ChangeDocument, type ChangeQuery, MarketsDocument } from "../../graphql/generated.ts";
import { approvalHref, editHref } from "../../lib/kinds.ts";
import { marketName, marketZone, planName } from "../../lib/markets.ts";
import { useMinute } from "../../lib/react/clock.tsx";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";
import { formatClockIn, formatLocalWithUtc } from "../../lib/time.ts";
import { ItsLaunches } from "../approval/approval.tsx";
import { ChangeTabs } from "../campaigns/tabs.tsx";
import { MarketPolicy } from "./policy.tsx";

type Change = NonNullable<ChangeQuery["change"]>;
export type Progress = NonNullable<Change["migration"]>;

/** How often the page reads the counts again while answers can still come. */
export const PROGRESS_EVERY_MS = 5_000;

type Part = { readonly key: string; readonly label: string; readonly count: number; readonly meaning: string; readonly look: string };

/** The states a request is in, in order: they add up to the subscribers asked or told. */
export function parts(progress: Progress, choice: string): readonly Part[] {
  if (progress.requirement === "CONSENT") {
    return [
      { key: "accepted", label: "Accepted", count: progress.accepted, meaning: "Said yes: they pay the new price from their first charge after it.", look: "bg-silk-indigo shadow-[inset_0_0_0_1px_var(--color-indigo)]" },
      { key: "waiting", label: "Waiting", count: progress.waiting, meaning: "Asked, no answer yet: until the window ends they keep their price.", look: "weave-open bg-stone-0 shadow-[inset_0_0_0_1px_var(--color-ink-2)]" },
      { key: "declined", label: "Declined", count: progress.declined, meaning: `Said no: they keep their price until the window ends; then ${choice}`, look: "bg-silk-madder shadow-[inset_0_0_0_1px_var(--color-madder)]" },
      { key: "lapsed", label: "Lapsed", count: progress.lapsed, meaning: `No answer by the end of the window: silence is no (§8.2); then ${choice}`, look: "weave-cross bg-stone-0 shadow-[inset_0_0_0_1px_var(--color-ink)]" },
    ];
  }
  return [
    { key: "newPrice", label: "Paying the new price", count: progress.newPrice, meaning: "Their notice ran out: they pay the new price from their own date.", look: "bg-silk-indigo shadow-[inset_0_0_0_1px_var(--color-indigo)]" },
    { key: "waiting", label: "Within the notice", count: progress.waiting, meaning: "Told: until the notice ends they keep their price, and may leave.", look: "weave-open bg-stone-0 shadow-[inset_0_0_0_1px_var(--color-ink-2)]" },
    { key: "declined", label: "Leaving", count: progress.declined, meaning: "Said no: they leave before the new price applies.", look: "bg-silk-madder shadow-[inset_0_0_0_1px_var(--color-madder)]" },
  ];
}

export function MigrationProgressScreen() {
  const id = useSearchParams().get("id") ?? "";
  const valid = /^\d+$/.test(id);
  const change = useGatewayQuery(ChangeDocument, { id }, {
    enabled: valid,
    // Answers keep coming while requests wait; a migration that is not live yet waits for its start.
    refetchInterval: (data) => (data?.change && (data.change.state === "SCHEDULED" || (data.change.state === "ACTIVE" && (data.change.migration?.waiting ?? 1) > 0)) ? PROGRESS_EVERY_MS : false),
  });
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const data = change.data?.change ?? null;
  const migration = data?.current.content.__typename === "PriceMigrationContent" ? data.current.content : null;
  const head = (
    <PageHead
      crumbs={[{ label: "Price migrations", href: "/price-migrations/" }, { label: data ? `${data.title} v${data.currentVersion}` : `Change #${id}`, href: editHref("PRICE_MIGRATION", id) }, { label: "Progress" }]}
      title={data ? `Progress: ${data.title}` : "Progress"}
      sub={data ? <><StateChip state={data.state} />{data.sentence ? <span>{data.sentence}</span> : null}</> : null}
      simulated
    />
  );
  if (!valid) return <>{head}<PageBody><Callout tone="error" icon="warning">This address names no price migration. <Link href="/price-migrations/">Back to the price migrations</Link>.</Callout></PageBody></>;
  if (change.isPending || markets.isPending) return <>{head}<PageBody><Loading what="the progress" lines={8} /></PageBody></>;
  if (change.isError) return <>{head}<PageBody><ErrorPanel error={change.error} retry={() => void change.refetch()} /></PageBody></>;
  if (data === null || migration === null) return <>{head}<PageBody><Callout tone="error" icon="warning">There is no price migration #{id}. <Link href="/price-migrations/">Back to the price migrations</Link>.</Callout></PageBody></>;
  const names = markets.data?.markets ?? [];
  const zone = marketZone(names, migration.market);
  return (
    <>
      {head}
      <PageBody className="gap-6">
        <ChangeTabs kind="PRICE_MIGRATION" changeId={data.id} current="progress" />
        <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-12">
          <div className="grid min-w-0 content-start gap-8">
            {data.migration ? (
              <Standing progress={data.migration} market={marketName(names, migration.market)} plan={planName(migration.plan)} zone={zone} live={data.state === "ACTIVE" && data.migration.waiting > 0} readAt={change.dataUpdatedAt} />
            ) : (
              <NotYet change={data} noticesLocal={migration.noticesLocal} zone={zone} />
            )}
            {["SCHEDULED", "ACTIVE", "CANCELLED", "ENDED"].includes(data.state) ? <ItsLaunches changeId={data.id} title="Its launch" /> : null}
          </div>
          <aside className="grid min-w-0 content-start gap-4" aria-label="The market's rules">
            <MarketPolicy market={migration.market} />
          </aside>
        </div>
      </PageBody>
    </>
  );
}

function NotYet({ change, noticesLocal, zone }: { readonly change: Change; readonly noticesLocal: string; readonly zone: string }) {
  const when = formatLocalWithUtc(noticesLocal, zone);
  const words = change.state === "SCHEDULED"
    ? `Scheduled: the requests go out ${when}. Its launch begins a minute before, and the counts appear here once it has published.`
    : change.state === "CANCELLED"
      ? "Cancelled before it started: nobody was asked or told."
      : `Nobody has been asked or told yet. The requests go out when the migration starts, ${when}, once it is approved and scheduled.`;
  return (
    <section className="grid gap-3" aria-labelledby="standing">
      <h2 id="standing" className="text-xl font-bold">Where the existing subscribers stand</h2>
      <Callout icon={change.state === "SCHEDULED" ? "calendar-check" : "hourglass-medium"} tone="quiet">
        <p>{words}</p>
        {change.state !== "SCHEDULED" && change.state !== "CANCELLED" ? <p className="mt-1"><Link href={approvalHref("PRICE_MIGRATION", change.id)}>Open its approval page</Link></p> : null}
      </Callout>
    </section>
  );
}

function Standing({ progress, market, plan, zone, live, readAt }: {
  readonly progress: Progress;
  readonly market: string;
  readonly plan: string;
  readonly zone: string;
  readonly live: boolean;
  readonly readAt: number;
}) {
  const consent = progress.requirement === "CONSENT";
  const choice = consent ? "the music service's choice applies, as the market's rules say." : "they leave the paid plan.";
  const shown = parts(progress, choice);
  const total = Math.max(progress.asked, 1);
  const now = useMinute();
  const ended = new Date(progress.windowEnds.utc).getTime() <= now.getTime();
  return (
    <section className="grid gap-5" aria-labelledby="standing">
      <div className="grid gap-2">
        <h2 id="standing" className="max-w-[34ch] text-[clamp(1.5rem,1.1rem+0.9vw,2rem)] leading-tight font-bold tracking-[-0.01em] text-balance">
          {formatCount(progress.asked)} {plan} subscribers in {market} {consent ? "asked for their consent" : "told"}; {formatCount(progress.waiting)} {consent ? "have not answered yet" : "still within their notice"}.
        </h2>
        <p className="flex items-baseline gap-2 text-lg font-semibold">
          <Icon name="clock-countdown" size={18} className="translate-y-0.5 text-indigo" />
          <span>The window {ended ? "ended" : "ends"} {formatLocalWithUtc(progress.windowEnds.local, zone)}.{consent ? " Silence counts as no." : ""}</span>
        </p>
      </div>
      <div className="grid gap-2">
        <div className="flex h-5 w-full max-w-[46rem] gap-px bg-stone-2" role="img" aria-label={`Of ${formatCount(progress.asked)}: ${shown.map((part) => `${formatCount(part.count)} ${part.label.toLowerCase()}`).join(", ")}.`}>
          {shown.filter((part) => part.count > 0).map((part) => (
            <span key={part.key} className={`block h-full ${part.look}`} style={{ width: `${(part.count / total) * 100}%` }} />
          ))}
        </div>
        <p className="text-xs text-ink-2">Each subscriber is in one of these states; together they make the {formatCount(progress.asked)} {consent ? "asked" : "told"}.</p>
      </div>
      <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="standing-table">
        <table className="data min-w-[17rem]">
          <caption id="standing-table" className="sr-only">Where the existing subscribers stand</caption>
          <thead><tr><th scope="col">State, and what it means</th><th scope="col">Subscribers</th></tr></thead>
          <tbody>
            {shown.map((part) => (
              <tr key={part.key} data-part={part.key}>
                <th scope="row" className="wrap">
                  <span className="inline-flex items-center gap-2"><span aria-hidden="true" className={`inline-block h-3 w-5 flex-none ${part.look}`} />{part.label}</span>
                  <span className="block max-w-[60ch] text-sm font-normal text-ink-2">{part.meaning}</span>
                </th>
                <td className="align-top font-bold">{formatCount(part.count)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th scope="row">{consent ? "Asked" : "Told"}</th><td>{formatCount(progress.asked)}</td></tr>
          </tfoot>
        </table>
      </div>
      <p className="flex items-baseline gap-2">
        <Icon name="door-open" size={16} className="translate-y-0.5 text-indigo" />
        <span>
          {progress.left === 0
            ? `Nobody has left the paid plan over it yet: ${consent ? "those who say no or let the window run out" : "those who leave"} leave on their own date, a month already paid never cut short (§8.2, §8.8).`
            : <><b>{formatCount(progress.left)}</b> of them leave the paid plan on their own date, a month already paid never cut short (§8.2, §8.8).</>}
        </span>
      </p>
      <p className="flex items-baseline gap-1.5 text-xs text-ink-2">
        <Icon name="flask" size={14} className="translate-y-0.5" />
        Simulated subscribers (§13.3). Read at {formatClockIn(new Date(readAt), CONSOLE_ZONE)} Rome{live ? `, and again every ${PROGRESS_EVERY_MS / 1000} seconds while answers can come` : ""}.
      </p>
    </section>
  );
}
