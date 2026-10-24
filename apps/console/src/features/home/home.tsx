"use client";
// The home: the five things the commercial team looks at first, each leading
// to an action (the owner's brief): what waits for approval, what launches in
// the next seven days, today's incidents, who pays by plan and market, and
// this month's revenue without VAT. Two figures are reserved (§12.2):
// revenue for finance and the commercial lead, the value of prepaid passes
// sold and not yet earned for finance (§9.2, with the prepaid pass: its place
// is kept, without numbers). Every other role finds, in the same place, who
// reads them. Below, the week as lanes.
//
// The first row has two columns that end together: the approvals, each with
// what it changes, and beside them the launches above the incidents.
import { BRAND, formatCount, formatMoney } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import type { ReactNode } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { ButtonLink, Chip, Empty, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import { HomeDocument, type HomeQuery } from "../../graphql/generated.ts";
import { byMarketOrder, marketName, marketZone, PLAN_ORDER, planName } from "../../lib/markets.ts";
import {
  can, conditionSigner, conditionWords, decide, decisionSentence, everyoneReadsWords, primaryRole, signerWords, waitingFor, whoDoes,
} from "../../lib/permissions.ts";
import { useMinute } from "../../lib/react/clock.tsx";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";
import { useViewer, type Viewer } from "../../lib/react/session.tsx";
import { dayHeading, formatInstantIn, formatLocalWithUtc, nowLabel } from "../../lib/time.ts";
import { WeekZone } from "./week.tsx";

type Overview = HomeQuery["overview"];
type Markets = HomeQuery["markets"];

export function HomeScreen() {
  const viewer = useViewer();
  const now = useMinute();
  const readsRevenue = can(viewer.roles, "readRevenue");
  const readsUnearned = can(viewer.roles, "readUnearnedValue");
  const home = useGatewayQuery(HomeDocument, { readsRevenue });

  return (
    <>
      <PageHead title={dayHeading(now, CONSOLE_ZONE)} sub="Four markets · figures in EUR without VAT unless marked" simulated />
      <PageBody>
        {home.isPending ? (
          <Loading what="the home" lines={10} />
        ) : home.isError ? (
          <ErrorPanel error={home.error} retry={() => void home.refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-8 xl:grid-cols-2 xl:gap-12">
              <div className="home-column">
                <ApprovalsZone waiting={home.data.overview.waitingForApproval} markets={home.data.markets} viewer={viewer} />
              </div>
              <div className="home-column">
                <LaunchesZone launches={home.data.overview.launchesNext7Days} markets={home.data.markets} />
                <IncidentsZone incidents={home.data.overview.incidentsToday} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-12">
              <div className="home-column">
                <SubscribersZone overview={home.data.overview} markets={home.data.markets} now={now} />
                {readsUnearned ? <UnearnedToCome /> : <UnearnedLocked viewer={viewer} />}
              </div>
              <div className="home-column">
                {readsRevenue ? <RevenueZone overview={home.data.overview} markets={home.data.markets} /> : <RevenueLocked viewer={viewer} />}
              </div>
            </div>
            <WeekZone markets={home.data.markets} />
          </>
        )}
      </PageBody>
    </>
  );
}

function ZoneHead({ count, title, action, id, locked = false }: { readonly count?: ReactNode; readonly title: ReactNode; readonly action?: ReactNode; readonly id: string; readonly locked?: boolean }) {
  return (
    <div className="zone-head">
      <h2 id={id}>
        {count !== undefined ? <span className="count">{count}</span> : null}
        {locked ? <Icon name="lock-simple" size={18} className="self-center text-ink-2" /> : null}
        <span>{title}</span>
      </h2>
      {action}
    </div>
  );
}

function ApprovalsZone({ waiting, markets, viewer }: { readonly waiting: Overview["waitingForApproval"]; readonly markets: Markets; readonly viewer: Viewer }) {
  const role = primaryRole(viewer.roles);
  return (
    <section className="zone zone--listed" aria-labelledby="home-approvals">
      <ZoneHead id="home-approvals" count={formatCount(waiting.length)} title="Waiting for approval" action={<ButtonLink href="/approvals/" size="small">All approvals</ButtonLink>} />
      {waiting.length === 0 ? (
        <Empty icon="seal-check">Nothing waiting. Changes submitted for approval show up here with who has to sign.</Empty>
      ) : (
        <ul role="list" className="grid">
          {waiting.slice(0, SHOWN).map((change) => {
            const content = change.details.current.content;
            const plan = content.__typename === "OfferContent" || content.__typename === "ListPriceContent" ? content.plan : "";
            const decision = decide({
              state: change.state,
              version: change.details.current.version,
              versions: change.details.versions.map((version) => ({ version: version.version, authorId: version.author.id })),
              signatures: change.requiredSignatures,
              approvals: change.details.approvals.map((approval) => ({ version: approval.version, approverId: approval.approver.id })),
            }, viewer);
            return (
              <li key={change.id} className="grid gap-1.5 border-t border-cord py-3 first:border-t-0 first:pt-1 last:pb-0">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-base font-bold leading-snug">
                    {change.title} <span className="font-semibold text-ink-2">v{change.currentVersion}</span>
                  </h3>
                  <ButtonLink href={`/campaigns/approval/?id=${change.id}`} size="small" iconAfter="arrow-right">
                    Review<span className="sr-only"> {change.title} v{change.currentVersion}</span>
                  </ButtonLink>
                </div>
                <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-2">
                  <span className="inline-flex items-center gap-1"><Icon name="globe-hemisphere-west" size={14} />{change.markets.map((code) => marketName(markets, code)).join(", ")}{plan ? `, ${planName(plan)}` : ""}</span>
                  <span className="inline-flex items-center gap-1"><Icon name="pen-nib" size={14} />{change.createdBy.label}</span>
                  <span className="inline-flex items-center gap-1"><Icon name="clock" size={14} />{formatInstantIn(change.updatedAt, CONSOLE_ZONE)}</span>
                </p>
                {change.details.sentence ? <p className="text-sm leading-relaxed">{change.details.sentence}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Chip look="waiting" icon="hourglass-medium">{waitingFor(change.requiredSignatures)}</Chip>
                  {change.requiredSignatures.filter((signature) => signature.conditions.length).map((signature) => (
                    <span key={signature.role} className="text-sm">{signerWords(signature, { start: true })} signs: {conditionWords(signature.conditions)}</span>
                  ))}
                </div>
                <p className="flex items-baseline gap-2 text-sm">
                  <Icon name={decision.kind === "sign" ? "signature" : decision.kind === "author" ? "pen-nib" : "lock-simple"} size={15} className="translate-y-0.5 text-indigo" />
                  <span>{decisionSentence(decision, role)}</span>
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {waiting.length > SHOWN ? <MoreLink href="/approvals/" count={waiting.length - SHOWN} what="waiting for approval" /> : null}
    </section>
  );
}

/** The home shows the first few of a queue; the rest are one link away. */
const SHOWN = 3;

function MoreLink({ href, count, what }: { readonly href: string; readonly count: number; readonly what: string }) {
  return (
    <p className="text-sm">
      <Link href={href} className="inline-flex items-center gap-1.5 font-semibold">
        {count} more {what}
        <Icon name="arrow-right" size={15} />
      </Link>
    </p>
  );
}

function LaunchesZone({ launches, markets }: { readonly launches: Overview["launchesNext7Days"]; readonly markets: Markets }) {
  return (
    <section className="zone zone--listed" aria-labelledby="home-launches">
      <ZoneHead id="home-launches" count={formatCount(launches.length)} title="Launching in the next 7 days" action={<ButtonLink href="/launches/" size="small">All launches</ButtonLink>} />
      {launches.length === 0 ? (
        <Empty icon="calendar-blank">Nothing starts in the next seven days. An approved offer shows up here once it has a start date this week.</Empty>
      ) : (
        <ul role="list" className="grid">
          {launches.slice(0, SHOWN).map((launch) => (
            <li key={`${launch.change.id}-${launch.starts.market}`} className="grid gap-1.5 border-t border-cord py-3 first:border-t-0 first:pt-1 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-base font-bold leading-snug">
                  {launch.title} <span className="font-semibold text-ink-2">v{launch.change.currentVersion}</span>
                </h3>
                <ButtonLink href={`/campaigns/approval/?id=${launch.change.id}`} size="small" iconAfter="arrow-right">
                  Open<span className="sr-only"> {launch.title}</span>
                </ButtonLink>
              </div>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
                <span className="inline-flex items-center gap-1"><Icon name="rocket-launch" size={14} />{marketName(markets, launch.starts.market)}: {formatLocalWithUtc(launch.starts.local, marketZone(markets, launch.starts.market))}</span>
                <StateChip state={launch.state} />
              </p>
              {launch.atRisk && launch.risk ? (
                <p className="flex items-baseline gap-2 border border-ink bg-stone-0 px-3 py-2 text-sm">
                  <Icon name="warning" size={16} className="translate-y-0.5" />
                  <span>{launch.risk}</span>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {launches.length > SHOWN ? <MoreLink href="/launches/" count={launches.length - SHOWN} what="launching this week" /> : null}
    </section>
  );
}

function IncidentsZone({ incidents }: { readonly incidents: Overview["incidentsToday"] }) {
  return (
    <section className="zone zone--listed" aria-labelledby="home-incidents">
      <ZoneHead id="home-incidents" count={formatCount(incidents.length)} title="Incidents today" />
      {incidents.length === 0 ? (
        <Empty icon="shield-check">No incidents today. When an activation fails, it shows up here with what happened, step by step.</Empty>
      ) : (
        <ul role="list" className="grid">
          {incidents.map((incident) => (
            <li key={incident.run} className="grid gap-1.5 border-t border-cord py-3 first:border-t-0 first:pt-1 last:pb-0">
              <p className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                <Chip look={incident.state === "OPEN" ? "rejected" : "done"} icon={incident.state === "OPEN" ? "warning" : incident.state === "RECOVERED" ? "arrows-clockwise" : "check-circle"}>
                  {incident.state === "OPEN" ? "Open" : incident.state === "RECOVERED" ? "Recovered on its own" : "Resolved by a person"}
                </Chip>
                Run {incident.run}
              </p>
              <p className="text-sm">{incident.title}: {incident.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SubscribersZone({ overview, markets, now }: { readonly overview: Overview; readonly markets: Markets; readonly now: Date }) {
  const ordered = byMarketOrder(markets);
  const paid = (market: string, plan: string) => overview.payingSubscribers.find((row) => row.market === market && row.plan === plan)?.count ?? 0;
  const free = (market: string) => overview.freeListeners.filter((row) => row.market === market).reduce((sum, row) => sum + row.count, 0);
  const paying = (market: string) => PLAN_ORDER.reduce((sum, plan) => sum + paid(market, plan), 0);
  const total = ordered.reduce((sum, market) => sum + paying(market.code), 0);
  const planTotal = (plan: string) => ordered.reduce((sum, market) => sum + paid(market.code, plan), 0);
  const freeTotal = ordered.reduce((sum, market) => sum + free(market.code), 0);
  return (
    <section className="zone" aria-labelledby="home-subscribers">
      <ZoneHead id="home-subscribers" count={formatCount(total)} title="Paying subscribers by plan and market" action={<ButtonLink href="/price-list/" size="small">Plans and prices</ButtonLink>} />
      <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="home-subscribers">
        <table className="data min-w-[34rem]">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Paying</th>
              {PLAN_ORDER.map((plan) => <th key={plan} scope="col">{planName(plan)}</th>)}
              <th scope="col" className="sep">Free listeners</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((market) => (
              <tr key={market.code}>
                <th scope="row">{market.name}</th>
                <td className="font-bold">{formatCount(paying(market.code))}</td>
                {PLAN_ORDER.map((plan) => <td key={plan}>{formatCount(paid(market.code, plan))}</td>)}
                <td className="sep text-ink-2">{formatCount(free(market.code))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">All markets</th>
              <td>{formatCount(total)}</td>
              {PLAN_ORDER.map((plan) => <td key={plan}>{formatCount(planTotal(plan))}</td>)}
              <td className="sep">{formatCount(freeTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="flex items-baseline gap-1.5 text-xs text-ink-2">
        <Icon name="flask" size={14} className="translate-y-0.5" />
        Simulated data: counts from the data generator, as of {nowLabel(now, CONSOLE_ZONE)}.
      </p>
    </section>
  );
}

function RevenueZone({ overview, markets }: { readonly overview: Overview; readonly markets: Markets }) {
  const rows = byMarketOrder(markets).map((market) => ({ market, revenue: overview.monthlyRevenue?.find((row) => row.market === market.code) }));
  return (
    <section className="zone" aria-labelledby="home-revenue">
      <ZoneHead
        id="home-revenue"
        count={overview.monthlyRevenueEur ? formatMoney(overview.monthlyRevenueEur) : undefined}
        title="Revenue this month, without VAT"
        action={<ButtonLink href="/price-list/#below-floor" size="small">Prices below the floor</ButtonLink>}
      />
      <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="home-revenue">
        <table className="data min-w-[20rem]">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Local currency</th>
              <th scope="col">EUR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ market, revenue }) => (
              <tr key={market.code}>
                <th scope="row">{market.name}</th>
                <td className="text-ink-2">{revenue && revenue.revenue.currency !== "EUR" ? formatMoney(revenue.revenue) : ""}</td>
                <td className="font-bold">{revenue ? formatMoney(revenue.revenueEur) : "none"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">All markets</th>
              <td />
              <td>{overview.monthlyRevenueEur ? formatMoney(overview.monthlyRevenueEur) : "none"}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="flex items-baseline gap-1.5 text-xs text-ink-2">
        <Icon name="info" size={14} className="translate-y-0.5" />
        UK converted at {overview.exchangeRateNote}
      </p>
      {overview.monthlyTopUps ? (
        <div className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-2.5 gap-y-1 border border-cord bg-stone-0 px-3 py-2.5">
          <span className="block h-3 w-5 translate-y-0.5 bg-chord-ms shadow-[inset_0_2px_0_var(--color-madder)]" aria-hidden="true" />
          <span>Standing top-ups this month</span>
          <b>{formatMoney(overview.monthlyTopUps)}</b>
          <p className="col-start-2 col-end-4 text-xs text-ink-2">
            What {BRAND.service} adds to reach the artists' minimum where a list price is below the floor, as {conditionSigner()} approved (§5.5).
          </p>
        </div>
      ) : null}
      <p className="flex items-baseline gap-1.5 text-xs text-ink-2">
        <Icon name="flask" size={14} className="translate-y-0.5" />
        Simulated data: the monthly price, net of VAT, of the generated subscriptions current today.
      </p>
    </section>
  );
}

/** Revenue, for a role that does not read it: the same place, who reads it, and what this role reads. */
function RevenueLocked({ viewer }: { readonly viewer: Viewer }) {
  return (
    <section className="zone zone--reserved" aria-labelledby="home-revenue">
      <ZoneHead id="home-revenue" title="Revenue this month, without VAT" locked />
      <div className="reserved">
        <Locked className="locked--plain">{whoDoes("readRevenue", { one: "reads revenue and the standing top-ups", many: "read revenue and the standing top-ups" })}.</Locked>
        <p className="max-w-[56ch] text-sm text-ink-2">
          {everyoneReadsWords(primaryRole(viewer.roles))} The engine leaves these figures out of its answers to other roles, and the gateway refuses them.
        </p>
        <p className="text-sm">
          <Link href="/price-list/">The price list</Link> is open to every role.
        </p>
      </div>
    </section>
  );
}

const UNEARNED_TITLE = "Prepaid passes sold, not yet earned";

/** The value of prepaid passes sold and not yet earned, for Finance: its place, without numbers until the prepaid pass is on sale (§9.2). */
function UnearnedToCome() {
  return (
    <section className="zone zone--reserved" aria-labelledby="home-unearned">
      <ZoneHead id="home-unearned" title={UNEARNED_TITLE} />
      <div className="reserved">
        <p className="flex items-baseline gap-2 font-semibold">
          <Icon name="gift" size={18} className="translate-y-0.5 text-ink-2" />
          It arrives with the prepaid pass, which is not on sale yet.
        </p>
        <p className="max-w-[56ch] text-sm text-ink-2">
          Then, by market: the net value of the passes sold and not yet earned. A pass is earned in equal monthly parts from its activation, the last part
          taking the remainder; an unused code stays unearned until it expires (§9.2).
        </p>
      </div>
    </section>
  );
}

/** The same place, for a role that does not read it: who does. */
function UnearnedLocked({ viewer }: { readonly viewer: Viewer }) {
  return (
    <section className="zone zone--reserved" aria-labelledby="home-unearned">
      <ZoneHead id="home-unearned" title={UNEARNED_TITLE} locked />
      <div className="reserved">
        <Locked className="locked--plain">
          {whoDoes("readUnearnedValue", { one: "reads the value of prepaid passes sold and not yet earned", many: "read the value of prepaid passes sold and not yet earned" })} (§9.2).
        </Locked>
        <p className="max-w-[56ch] text-sm text-ink-2">{everyoneReadsWords(primaryRole(viewer.roles))}</p>
      </div>
    </section>
  );
}
