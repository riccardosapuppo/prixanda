"use client";
// The week as lanes (lib/week.ts draws the geometry): the console's one
// gesture from the identity, periods as sheets. On a phone the same facts
// become a list: a lane drawing is unreadable at that width.
import { formatCount, formatMoney } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useId, useState } from "react";
import { CONSOLE_ZONE } from "../../components/frame.tsx";
import { ErrorPanel, Loading } from "../../components/ui.tsx";
import { type HomeQuery, WeekDocument } from "../../graphql/generated.ts";
import { PLAN_ORDER } from "../../lib/markets.ts";
import { useMinute } from "../../lib/react/clock.tsx";
import { useGatewayEveryPage } from "../../lib/react/gateway.tsx";
import { useWatch } from "../../lib/react/watch.tsx";
import { type Align, buildWeek, type Lane, laneName, laneWords } from "../../lib/week.ts";

const SHOWN_STATES = ["VALIDATED", "IN_APPROVAL", "APPROVED", "SCHEDULED", "ACTIVE"] as const;
/** A lane draws its first few offers, each on its own row; the rest are counted. */
const LANE_OFFERS = 3;
/**
 * The offers are read fifty at a time, newest change first (home.graphql),
 * every page up to this many: past them the week says there are more, and
 * that an older offer may be missing from it.
 */
const WEEK_PAGES = 10;
const WEEK_PAGE_SIZE = 50;

export function WeekZone({ markets }: { readonly markets: HomeQuery["markets"] }) {
  const now = useMinute();
  const [align, setAlign] = useState<Align>("local");
  // Every page, up to the limit: an offer live for weeks can be older than the first fifty, and its lane is not free.
  const { pages: week, complete, beyond } = useGatewayEveryPage(WeekDocument, (after) => ({ states: [...SHOWN_STATES], after }), (page) => page.changes.next, WEEK_PAGES, useWatch());
  const headingId = useId();
  const pages = week.data?.pages ?? [];
  const first = pages[0];

  const drawn = first && complete
    ? buildWeek({
      now,
      align,
      markets,
      plans: [...PLAN_ORDER],
      prices: first.priceList,
      offers: pages.flatMap((page) => page.changes.nodes).flatMap((node) => {
        const content = node.details.current.content;
        return content.__typename === "OfferContent"
          ? [{ id: node.id, title: node.title, state: node.state, version: node.currentVersion, plan: content.plan, periods: content.periods }]
          : [];
      }),
      axisZone: CONSOLE_ZONE,
    })
    : null;

  return (
    <section className="grid min-w-0 grid-cols-1 content-start gap-3" aria-labelledby={headingId}>
      <div className="zone-head">
        <h2 id={headingId}>This week, by market and plan</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-2" id={`${headingId}-align`}>Line up by</span>
          <div className="inline-flex rounded-control border border-edge bg-stone-0" role="group" aria-labelledby={`${headingId}-align`}>
            {(["local", "utc"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={align === value}
                onClick={() => setAlign(value)}
                className={`inline-flex min-h-9 items-center gap-1.5 px-3 text-sm font-semibold first:rounded-l-control last:rounded-r-control [&+&]:border-l [&+&]:border-edge ${align === value ? "bg-ink text-stone-0" : "hover:bg-stone-2"}`}
              >
                {value === "local" ? "Each market's time" : "UTC"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {week.isError ? <ErrorPanel error={week.error} retry={() => void week.refetch()} /> : week.isPending || drawn === null ? <Loading what="the week" lines={5} /> : (
        <>
          {beyond ? (
            <p className="flex items-baseline gap-2 text-sm">
              <Icon name="info" size={15} className="translate-y-0.5 text-ink-2" />
              <span>
                More than {formatCount(WEEK_PAGES * WEEK_PAGE_SIZE)} offers are signed, scheduled, live or waiting: the week draws the {formatCount(WEEK_PAGES * WEEK_PAGE_SIZE)} changed last, and an older one may be missing here. The campaigns list has them all.
              </span>
            </p>
          ) : null}
          {drawn.lanes.length === 0 ? (
            <p className="flex items-baseline gap-2 border border-cord bg-stone-0 px-3 py-3 text-sm">
              <Icon name="calendar-check" size={16} className="translate-y-0.5 text-indigo" />
              Nothing moves this week: every list price holds, and no offer starts, runs or waits for a signature.
            </p>
          ) : (
            <div className="hidden md:block">
              <Lanes week={drawn} align={align} />
            </div>
          )}
          <ul role="list" className="grid border-t border-cord md:hidden">
            {drawn.lanes.map((lane) => <LaneItem key={`${lane.market.code}-${lane.plan}`} lane={lane} />)}
          </ul>
          <p className="text-sm text-ink-2">
            {drawn.lanes.length === 0 ? null : drawn.clear === 0 ? "Every market and plan has something happening this week." : `${drawn.clear} other market and plan lanes are clear this week: their list price holds and no offer runs.`}
          </p>
          <p className="flex items-baseline gap-1.5 text-sm text-ink-2">
            <Icon name="clock" size={15} className="translate-y-0.5" />
            Times are local to each market and stay local across clock changes (§3.7).
            {align === "utc" ? " Lined up by UTC, the same instant falls on the same vertical; the days are those of Rome." : " Lined up by each market's time, 09:00 in Rome and 09:00 in London fall on the same vertical."}
          </p>
        </>
      )}
    </section>
  );
}

function Lanes({ week, align }: { readonly week: NonNullable<ReturnType<typeof buildWeek>>; readonly align: Align }) {
  const pct = (value: number) => `${(value * 100).toFixed(3)}%`;
  return (
    <div className="relative overflow-x-auto border border-cord bg-stone-0" tabIndex={0} role="region" aria-label="This week's lanes">
      <div className="relative min-w-[46rem] [--lane-head:12.5rem] xl:[--lane-head:13.5rem]">
        <div className="grid grid-cols-[var(--lane-head)_minmax(0,1fr)] border-b border-cord">
          <div className="sticky left-0 z-[3] flex items-end border-r border-cord bg-stone-0 px-3 py-1.5 text-2xs leading-tight text-ink-2">
            {align === "local" ? "Axis: each market's local time" : "Axis: UTC, days of Rome"}
          </div>
          <div className="relative h-11" aria-hidden="true">
            {week.days.map((day) => (
              <div key={day.label} className={`absolute top-0 bottom-0 whitespace-nowrap border-l border-cord px-1.5 py-1 text-xs font-semibold ${day.weekend ? "bg-stone" : ""}`} style={{ left: pct(day.at), width: pct(1 / week.days.length) }}>
                {day.label}
              </div>
            ))}
          </div>
        </div>
        {week.lanes.map((lane) => {
          const prices = lane.sheets.filter((sheet) => sheet.kind === "price");
          const offers = lane.sheets.filter((sheet) => sheet.kind === "offer");
          const shown = offers.slice(0, LANE_OFFERS);
          const height = `${2.9 + shown.length * 2.15}rem`;
          return (
            <div key={`${lane.market.code}-${lane.plan}`} className="grid grid-cols-[var(--lane-head)_minmax(0,1fr)] border-b border-cord last:border-b-0">
              <div className="sticky left-0 z-[3] grid content-center gap-1 border-r border-cord bg-stone-0 px-3 py-2">
                <p className="font-archivo text-2xs font-medium uppercase leading-tight tracking-[0.12em] [font-stretch:125%]">{laneName(lane)}</p>
                <p className="text-xs leading-snug text-ink-2"><b className="font-semibold text-ink">{lane.status.word}</b>: {lane.status.detail}</p>
                {offers.length > shown.length ? <p className="text-xs text-ink-2">{offers.length - shown.length} more offers in this lane</p> : null}
                <p className="sr-only">{laneWords(lane, formatMoney)}</p>
              </div>
              <div className="relative" style={{ height }} aria-hidden="true">
                {week.days.map((day) => (
                  <i key={day.label} className={`absolute top-0 bottom-0 border-l border-cord ${day.weekend ? "bg-stone" : ""}`} style={{ left: pct(day.at), width: pct(1 / week.days.length) }} />
                ))}
                {prices.map((sheet, index) => (
                  <div key={`p${index}`} className="absolute top-2 h-[2.3rem] bg-silk-indigo shadow-[inset_0_2px_0_var(--color-indigo)]" style={{ left: pct(sheet.from), width: pct(Math.max(sheet.to - sheet.from, 0.004)) }}>
                    {sheet.amount ? (
                      <span className={`absolute top-1 rounded-control border border-cord bg-stone-0 px-1.5 py-px text-xs font-semibold whitespace-nowrap ${sheet.to >= 0.999 ? "right-1" : "left-1"}`}>List price {formatMoney(sheet.amount)}</span>
                    ) : null}
                  </div>
                ))}
                {shown.map((sheet, index) => {
                  const top = `${2.9 + index * 2.15}rem`;
                  const nearEnd = sheet.from > 0.55;
                  return (
                    <div key={`o${index}`}>
                      <div className={`absolute h-[1.9rem] ${sheet.look === "waiting" ? "weave-open bg-stone-0 shadow-[inset_0_0_0_1.5px_var(--color-saffron)]" : "bg-silk-saffron shadow-[inset_0_-2px_0_var(--color-saffron)]"}`} style={{ top, left: pct(sheet.from), width: pct(Math.max(sheet.to - sheet.from, 0.004)) }} />
                      <span
                        className="absolute z-[4] mt-[0.2rem] inline-flex max-w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-control border border-cord bg-stone-0 px-1.5 py-px text-xs font-semibold whitespace-nowrap"
                        style={nearEnd ? { top, right: "0.25rem" } : { top, left: `calc(${pct(sheet.from)} + 0.25rem)` }}
                      >
                        {sheet.label} v{sheet.version}
                        <span className={`state ${sheet.look === "waiting" ? "state--waiting" : sheet.look === "live" ? "state--live" : "state--approved"} px-1 py-0 text-2xs`}>
                          {sheet.look === "waiting" ? "Waiting" : sheet.look === "live" ? "Live" : "Approved"}
                        </span>
                      </span>
                    </div>
                  );
                })}
                <div className="absolute top-0 bottom-0 w-0 border-l-2 border-ink" style={{ left: pct(lane.now) }} />
                {lane.clockChange ? <div className="absolute top-0 bottom-0 w-0 border-l-2 border-dashed border-ink-2" style={{ left: pct(lane.clockChange.at) }} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-cord px-3 py-2 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3 w-6 bg-silk-indigo shadow-[inset_0_2px_0_var(--color-indigo)]" />List price in force</span>
        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3 w-6 bg-silk-saffron shadow-[inset_0_-2px_0_var(--color-saffron)]" />Offer, approved or live</span>
        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3 w-6 bg-stone-0 weave-open shadow-[inset_0_0_0_1.5px_var(--color-saffron)]" />Offer waiting for a signature</span>
        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3.5 w-0 border-l-2 border-ink" />Now</span>
        {week.lanes.some((lane) => lane.clockChange) ? (
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3.5 w-0 border-l-2 border-dashed border-ink-2" />{week.lanes.find((lane) => lane.clockChange)?.clockChange?.words}</span>
        ) : null}
      </div>
    </div>
  );
}

function LaneItem({ lane }: { readonly lane: Lane }) {
  return (
    <li className="grid gap-1 border-b border-cord py-3">
      <p className="font-archivo text-2xs font-medium uppercase tracking-[0.12em] [font-stretch:125%]">{laneName(lane)}</p>
      <p className="text-sm"><b>{lane.status.word}</b>: {lane.status.detail}</p>
      <ul role="list" className="grid gap-0.5 text-sm text-ink-2">
        {lane.sheets.map((sheet, index) => (
          <li key={index}>
            {sheet.kind === "price" ? `List price ${sheet.amount ? formatMoney(sheet.amount) : ""}` : (
              <Link href={`/campaigns/approval/?id=${sheet.changeId}`}>{sheet.label} v{sheet.version}, {sheet.look === "waiting" ? "waiting for a signature" : sheet.look === "live" ? "live" : "approved"}</Link>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}
