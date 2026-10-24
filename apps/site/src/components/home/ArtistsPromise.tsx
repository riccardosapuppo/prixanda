"use client";
// The promise to the artists, told once, in a band of its own (business book
// §1.2, §5.3): every paid plan of the market as a sail hung from the same
// rope, as long as what a month of that plan gives the artists, and the
// guaranteed minimum as a dashed cord that every sail reaches. Where the
// artists' pool alone falls short of the minimum, the part the service adds
// hangs at the bottom of the sail in the chord of the two dyes. Every figure
// is the engine's breakdown of the plan's price (Plan.breakdown) and the
// market's minimum (Market.artistsMinimum); the band only draws them.
import { formatSitePrice, type MoneyLike } from "design";
import type { CSSProperties } from "react";
import { copy } from "../../content/copy.ts";
import { useMarkets, usePlans } from "../../data/hooks.ts";
import type { SiteMarket } from "../../data/markets.ts";
import { promiseSails } from "../art/geometry.ts";
import { PromiseDrawing } from "../art/Sails.tsx";
import { Failure, Loading } from "../ui/States.tsx";
import { inSiteOrder } from "./plan-order.ts";

export function ArtistsPromise({ market }: { readonly market: SiteMarket }) {
  const markets = useMarkets();
  const plans = usePlans(market);
  const info = markets.data?.find((each) => each.code === market);
  const write = (money: MoneyLike) => formatSitePrice(money, market);

  if (markets.isError || plans.isError) {
    const error = markets.error ?? plans.error;
    return (
      <section className="promise-plans wrap" aria-label={copy.promise.label}>
        <div className="promise-lead">
          <Failure error={error} onRetry={() => void (markets.isError ? markets.refetch() : plans.refetch())} />
        </div>
      </section>
    );
  }
  if (info === undefined || !plans.isSuccess) {
    return (
      <section className="promise-plans wrap" aria-label={copy.promise.label} aria-busy="true">
        <div className="promise-lead">
          <Loading />
        </div>
      </section>
    );
  }

  const minimum = write(info.artistsMinimum);
  const paid = inSiteOrder(plans.data).flatMap((plan) => (plan.paid && plan.breakdown ? [{ plan, breakdown: plan.breakdown }] : []));
  const topped = paid.filter(({ breakdown }) => BigInt(breakdown.topUp.amountMinor) > 0n);
  const figure = paid.length > 0
    ? promiseSails(
      paid.map(({ breakdown }) => {
        const artists = BigInt(breakdown.artists.amountMinor);
        return { artists, pool: artists - BigInt(breakdown.topUp.amountMinor) };
      }),
      { minimum: BigInt(info.artistsMinimum.amountMinor) },
    )
    : null;

  return (
    <section className="promise-plans wrap" aria-labelledby="promise-title">
      <div className="promise-lead">
        <h2 className="promise-title" id="promise-title">
          {copy.promise.title.before}
          <b className="min num">{minimum}</b>
          {copy.promise.title.after}
        </h2>
        <p>{copy.promise.lede(minimum)}</p>
        <p className="promise-small">{copy.promise.small(minimum)}</p>
      </div>
      {figure !== null ? (
        <figure className="promise-figure" aria-labelledby="promise-caption">
          <PromiseDrawing figure={figure} />
          <ul role="list" className="promise-names" style={{ gridTemplateColumns: `repeat(${paid.length}, minmax(0, 1fr))` } as CSSProperties}>
            {paid.map(({ plan, breakdown }) => (
              <li key={plan.code}>
                <span>{plan.name}</span>
                <b className="num">{write(breakdown.artists)}</b>
              </li>
            ))}
          </ul>
          <figcaption className="promise-key" id="promise-caption">
            <span>{copy.promise.caption(info.name)}</span>
            <span className="is-cord">
              <i className="swatch swatch-cord" aria-hidden="true" />
              {copy.promise.neverLess(minimum)}
            </span>
            {topped.map(({ plan, breakdown }) => (
              <span key={plan.code}>
                <i className="swatch swatch-topup" aria-hidden="true" />
                {copy.promise.topUp(plan.name, write(breakdown.topUp), minimum)}
              </span>
            ))}
          </figcaption>
        </figure>
      ) : null}
    </section>
  );
}
