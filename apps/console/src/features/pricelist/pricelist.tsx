"use client";
// The price list (business book §4), read only in the console: one price per
// plan, market and period, the floor of each market, and the prices below
// it, the standing exceptions Finance approved, with what the artists'
// minimum costs each month (§5.5). New list prices are the commercial
// lead's, through approval like every change.
import { formatMoney } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { PageBody, PageHead } from "../../components/frame.tsx";
import { Callout, ErrorPanel, Loading } from "../../components/ui.tsx";
import { PriceListDocument, type PriceListQuery } from "../../graphql/generated.ts";
import { byMarketOrder, PLAN_ORDER, planName } from "../../lib/markets.ts";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";
import { formatLocal } from "../../lib/time.ts";

type Entry = PriceListQuery["priceList"][number];

export function PriceListScreen() {
  const list = useGatewayQuery(PriceListDocument, {}, { staleTime: 60_000 });
  return (
    <>
      <PageHead title="Price list" sub="One price per plan, market and period, VAT included. A price in force is never edited: a new one starts later (§4.2)." />
      <PageBody>
        <Callout icon="lock-simple" tone="quiet">
          The commercial lead owns the price list; a new list price is a change that Finance approves (§7.3, condition 1). The console shows it read only.
        </Callout>
        {list.isPending ? <Loading what="the price list" lines={10} /> : list.isError ? <ErrorPanel error={list.error} retry={() => void list.refetch()} /> : (
          <>
            {byMarketOrder(list.data.markets).map((market) => {
              const entries = list.data.priceList.filter((entry) => entry.market === market.code);
              return (
                <section key={market.code} className="grid gap-3" aria-labelledby={`market-${market.code}`}>
                  <div className="zone-head">
                    <h2 id={`market-${market.code}`}>{market.name}</h2>
                    <p className="text-sm text-ink-2">
                      {market.currency} · VAT {market.vatBasisPoints / 100}% · floor <b className="text-ink">{formatMoney(market.floor)}</b> · artists' minimum <b className="text-madder">{formatMoney(market.artistsMinimum)}</b> a month
                    </p>
                  </div>
                  <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={`market-${market.code}`}>
                    <table className="data min-w-[40rem]">
                      <thead>
                        <tr>
                          <th scope="col">Plan</th>
                          <th scope="col">Price</th>
                          <th scope="col" className="wrap">From</th>
                          <th scope="col" className="wrap">Until</th>
                          <th scope="col">Against the floor</th>
                          <th scope="col" className="wrap">Approved by change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortEntries(entries).map((entry) => <PriceRow key={entry.id} entry={entry} zone={market.timeZone} />)}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
            <section id="below-floor" className="grid gap-3" aria-labelledby="below-floor-heading">
              <div className="zone-head"><h2 id="below-floor-heading">Below the floor: standing exceptions</h2></div>
              {list.data.priceList.filter((entry) => entry.belowFloor).length === 0 ? <p className="text-ink-2">No list price is below its market's floor.</p> : (
                <ul role="list" className="grid gap-2">
                  {list.data.priceList.filter((entry) => entry.belowFloor).map((entry) => (
                    <li key={entry.id} className="flex items-baseline gap-2">
                      <Icon name="warning" size={16} className="translate-y-0.5 text-madder" />
                      <span>
                        {list.data.markets.find((market) => market.code === entry.market)?.name}, {planName(entry.plan)} at {formatMoney(entry.amount)}: below the floor, so the service adds{" "}
                        <b>{formatMoney(entry.topUp)}</b> a month to every subscription to keep the artists at their minimum, a choice Finance approved (§5.5).
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </PageBody>
    </>
  );
}

function sortEntries(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) => PLAN_ORDER.indexOf(a.plan as never) - PLAN_ORDER.indexOf(b.plan as never) || a.validFrom.localeCompare(b.validFrom));
}

function PriceRow({ entry, zone }: { readonly entry: Entry; readonly zone: string }) {
  return (
    <tr>
      <th scope="row">{planName(entry.plan)}</th>
      <td className="font-bold">{formatMoney(entry.amount)}</td>
      <td className="wrap">{formatLocal(entry.validFrom, zone)}</td>
      <td className="wrap">{entry.validUntil ? formatLocal(entry.validUntil, zone) : "open"}</td>
      <td>{entry.belowFloor ? <span className="font-semibold text-madder">Below: top-up {formatMoney(entry.topUp)}</span> : "At or above"}</td>
      <td className="wrap">{entry.change ? <Link href={`/campaigns/approval/?id=${entry.change.id}`}>#{entry.change.id} {entry.change.title}</Link> : "Loaded with the data"}</td>
    </tr>
  );
}
