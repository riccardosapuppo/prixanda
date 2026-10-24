"use client";
// The home: the five things the commercial team looks at first, each leading
// to an action (the owner's brief): what waits for approval, what launches in
// the next seven days, today's incidents, who pays by plan and market, and
// this month's revenue without VAT, which only finance and the commercial
// lead read (§12.2). Below, the week as lanes.
import { BRAND, formatCount, formatMoney } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import type { ReactNode } from "react";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { ButtonLink, Chip, Empty, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import { HomeDocument, type HomeQuery } from "../../graphql/generated.ts";
import { byMarketOrder, marketName, marketZone, PLAN_ORDER, planName } from "../../lib/markets.ts";
import {
  can, conditionWords, decide, decisionSentence, primaryRole, type Role, ROLE_NAME, whoCan,
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
            <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-12">
              <ApprovalsZone waiting={home.data.overview.waitingForApproval} markets={home.data.markets} viewer={viewer} />
              <div className="grid content-start gap-8">
                <LaunchesZone launches={home.data.overview.launchesNext7Days} markets={home.data.markets} />
                <IncidentsZone incidents={home.data.overview.incidentsToday} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-12">
              <SubscribersZone overview={home.data.overview} markets={home.data.markets} now={now} />
              {readsRevenue ? <RevenueZone overview={home.data.overview} markets={home.data.markets} roles={viewer.roles} /> : <RevenueLocked viewer={viewer} />}
            </div>
            <WeekZone markets={home.data.markets} />
          </>
        )}
      </PageBody>
    </>
  );
}

function ZoneHead({ count, title, action, id }: { readonly count?: ReactNode; readonly title: ReactNode; readonly action?: ReactNode; readonly id: string }) {
  return (
    <div className="zone-head">
      <h2 id={id}>
        {count !== undefined ? <span className="count">{count}</span> : null}
        <span>{title}</span>
      </h2>
      {action}
    </div>
  );
}

function waitingFor(signatures: readonly { readonly role: Role; readonly conditions: readonly number[]; readonly signed: boolean; readonly why: string }[]): string {
  const missing = signatures.filter((signature) => !signature.signed);
  if (missing.length === 0) return "Signed: moving to approved";
  return `Waiting for ${missing.map((signature) => (signature.role === "COMMERCIAL_LEAD" ? "the commercial lead or Finance" : ROLE_NAME[signature.role])).join(" and ")}`;
}

function ApprovalsZone({ waiting, markets, viewer }: { readonly waiting: Overview["waitingForApproval"]; readonly markets: Markets; readonly viewer: Viewer }) {
  const role = primaryRole(viewer.roles);
  return (
    <section className="grid content-start gap-3" aria-labelledby="home-approvals">
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
              authorId: change.details.current.author.id,
              signatures: change.requiredSignatures,
              approvals: change.details.approvals.map((approval) => ({ version: approval.version, approverId: approval.approver.id })),
            }, viewer);
            return (
              <li key={change.id} className="grid gap-1.5 border-b border-cord py-3 first:pt-1">
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
                <div className="flex flex-wrap items-center gap-2">
                  <Chip look="waiting" icon="hourglass-medium">{waitingFor(change.requiredSignatures)}</Chip>
                  {change.requiredSignatures.filter((signature) => signature.conditions.length).map((signature) => (
                    <span key={signature.role} className="text-sm">{signature.role === "FINANCE" ? "Finance" : ROLE_NAME[signature.role]} signs: {conditionWords(signature.conditions)}</span>
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
    <section className="grid content-start gap-3" aria-labelledby="home-launches">
      <ZoneHead id="home-launches" count={formatCount(launches.length)} title="Launching in the next 7 days" action={<ButtonLink href="/launches/" size="small">All launches</ButtonLink>} />
      {launches.length === 0 ? (
        <Empty icon="calendar-blank">Nothing starts in the next seven days. An approved offer shows up here once it has a start date this week.</Empty>
      ) : (
        <ul role="list" className="grid">
          {launches.slice(0, SHOWN).map((launch) => (
            <li key={`${launch.change.id}-${launch.starts.market}`} className="grid gap-1.5 border-b border-cord py-3 first:pt-1">
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
    <section className="grid content-start gap-3" aria-labelledby="home-incidents">
      <ZoneHead id="home-incidents" count={formatCount(incidents.length)} title="Incidents today" />
      {incidents.length === 0 ? (
        <Empty icon="shield-check">No incidents today. When an activation fails, it shows up here with what happened, step by step.</Empty>
      ) : (
        <ul role="list" className="grid">
          {incidents.map((incident) => (
            <li key={incident.run} className="grid gap-1.5 border-b border-cord py-3 first:pt-1">
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
    <section className="grid content-start gap-3" aria-labelledby="home-subscribers">
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

function RevenueZone({ overview, markets, roles }: { readonly overview: Overview; readonly markets: Markets; readonly roles: readonly Role[] }) {
  const rows = byMarketOrder(markets).map((market) => ({ market, revenue: overview.monthlyRevenue?.find((row) => row.market === market.code) }));
  return (
    <section className="grid content-start gap-3" aria-labelledby="home-revenue">
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
            What {BRAND.service} adds to reach the artists' minimum where a list price is below the floor, as finance approved (§5.5).
          </p>
        </div>
      ) : null}
      {can(roles, "readUnearnedValue") ? (
        <p className="flex items-baseline gap-2 border border-dashed border-edge bg-stone px-3 py-2.5 text-sm">
          <Icon name="gift" size={16} className="translate-y-0.5 text-ink-2" />
          <span>
            <b className="font-semibold">Prepaid passes sold and not yet earned</b> (§9.2): this figure arrives with the prepaid pass, which is not on sale yet.
          </span>
        </p>
      ) : null}
      <p className="flex items-baseline gap-1.5 text-xs text-ink-2">
        <Icon name="flask" size={14} className="translate-y-0.5" />
        Simulated data: the monthly price, net of VAT, of the generated subscriptions current today.
      </p>
    </section>
  );
}

function RevenueLocked({ viewer }: { readonly viewer: Viewer }) {
  const role = primaryRole(viewer.roles);
  return (
    <section className="grid content-start gap-3" aria-labelledby="home-revenue">
      <ZoneHead id="home-revenue" title="Revenue this month, without VAT" />
      <div className="grid min-h-[16rem] content-start gap-3 border border-dashed border-edge bg-stone px-4 py-4">
        <Locked className="locked--plain">
          {whoCan("readRevenue").replace(/^./, (first) => first.toUpperCase())} read revenue.
        </Locked>
        <p className="max-w-[60ch] text-sm text-ink-2">
          {role ? `As ${ROLE_NAME[role]} you see who pays and what waits for a decision, not what comes in. ` : ""}
          The engine leaves revenue and the artists' top-ups out of its answers to other roles, and the gateway refuses them (§12.2).
        </p>
        <p className="text-sm">
          <Link href="/price-list/">The price list</Link> is open to every role.
        </p>
      </div>
    </section>
  );
}
