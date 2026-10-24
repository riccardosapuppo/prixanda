"use client";
// The plans of a market and the campaigns on sale there now, from the API.
// This is the working structure of the site's home: the approved design's
// third round redraws it (a record and a listening session first, the promise
// to the artists in a band of its own, "where your money goes" inside the
// choice of a plan), on the same data.
import { formatSitePrice } from "design";
import { Icon } from "design/icon";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { copy } from "../../content/copy.ts";
import { type Offer, useMarkets, useOffers, usePlans } from "../../data/hooks.ts";
import { DEFAULT_MARKET, marketFromQuery, type SiteMarket } from "../../data/markets.ts";
import { Failure, Loading } from "../ui/States.tsx";

export function PlansView() {
  const search = useSearchParams();
  const market = marketFromQuery(search) ?? DEFAULT_MARKET;
  return (
    <section className="wrap grid gap-8 pt-[clamp(1.5rem,2.6vw,2.5rem)] pb-16" aria-labelledby="plans-title">
      <h1 id="plans-title" className="display m-0">{copy.plans.title}</h1>
      <MarketChooser market={market} />
      <div className="grid gap-12 lg:grid-cols-2">
        <Plans market={market} />
        <OnNow market={market} />
      </div>
    </section>
  );
}

function MarketChooser({ market }: { readonly market: SiteMarket }) {
  const markets = useMarkets();
  const router = useRouter();
  const pathname = usePathname();
  if (markets.isPending) return <Loading />;
  if (markets.isError) return <Failure error={markets.error} onRetry={() => void markets.refetch()} />;
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 border-0 p-0">
      <legend className="float-left mr-2 p-0 text-base leading-11 font-[650] max-md:float-none max-md:w-full max-md:leading-normal">
        {copy.plans.marketLabel}
      </legend>
      <div className="flex flex-wrap rounded-control border border-edge bg-stone-0 max-md:grid max-md:w-full max-md:grid-cols-2">
        {markets.data.map((each) => (
          <label key={each.code} className="relative block border-edge not-first:border-l max-md:[&:nth-child(n+3)]:border-t max-md:[&:nth-child(odd)]:border-l-0">
            <input
              type="radio"
              name="market"
              value={each.code}
              checked={each.code === market}
              onChange={() => router.replace(`${pathname}?market=${each.code}` as Route, { scroll: false })}
              className="peer absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0"
            />
            <span className="flex min-h-11 items-center justify-center px-4 text-[0.96875rem] font-semibold whitespace-nowrap peer-checked:bg-ink peer-checked:text-stone-0 peer-focus-visible:relative peer-focus-visible:z-10 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-indigo">
              {each.name}
            </span>
          </label>
        ))}
      </div>
      <p className="m-0 text-md text-ink-2">{copy.plans.vatNote}</p>
    </fieldset>
  );
}

function Plans({ market }: { readonly market: SiteMarket }) {
  const plans = usePlans(market);
  if (plans.isPending) return <Loading />;
  if (plans.isError) return <Failure error={plans.error} onRetry={() => void plans.refetch()} />;
  return (
    <ul role="list" aria-label="Plans" className="m-0 list-none border-t border-ink p-0">
      {plans.data.map((plan) => (
        <li key={plan.code} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-b border-cord py-3">
          <span className="text-[clamp(1.375rem,1.1rem+0.75vw,1.75rem)] leading-[1.1] font-medium tracking-[-0.015em] [font-stretch:112%]">{plan.name}</span>
          <span className="num text-[clamp(1.375rem,1.1rem+0.7vw,1.75rem)] leading-[1.1] font-[650] whitespace-nowrap [font-stretch:112%]">
            {plan.listPrice ? formatSitePrice(plan.listPrice, market) : copy.plans.free}
          </span>
          <span className="col-span-2 text-md leading-[1.35] text-ink-2">{copy.plans.lines[plan.code] ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

function OnNow({ market }: { readonly market: SiteMarket }) {
  const offers = useOffers(market);
  return (
    <section aria-labelledby="on-now-title" className="grid content-start gap-4">
      <h2 id="on-now-title" className="m-0 text-5xl font-light tracking-[-0.02em] [font-stretch:125%]">{copy.plans.onNow}</h2>
      {offers.isPending ? <Loading /> : null}
      {offers.isError ? <Failure error={offers.error} onRetry={() => void offers.refetch()} /> : null}
      {offers.isSuccess && offers.data.length === 0 ? <p className="m-0 text-ink-2">{copy.plans.noOffers}</p> : null}
      {offers.isSuccess && offers.data.length > 0 ? (
        <ul role="list" className="m-0 grid list-none gap-3 p-0">
          {offers.data.map((offer) => <OfferRow key={offer.id} offer={offer} market={market} />)}
        </ul>
      ) : null}
    </section>
  );
}

function OfferRow({ offer, market }: { readonly offer: Offer; readonly market: SiteMarket }) {
  return (
    <li className="border-t border-cord pt-3">
      <Link
        href={{ pathname: "/campaign/", query: { market, offer: offer.id } }}
        className="group grid gap-1 text-ink no-underline"
      >
        <span className="inline-flex items-center gap-2 text-4xl leading-[1.2] font-semibold group-hover:underline">
          {offer.title}
          <Icon name="arrow-right" size={20} />
        </span>
        <span className="text-md text-ink-2">
          <s className="num">{formatSitePrice(offer.listPrice, market)}</s>{" "}
          <b className="num text-ink">{formatSitePrice(offer.price, market)}</b> a month for {offer.monthsAtOfferPrice}{" "}
          {offer.monthsAtOfferPrice === 1 ? "month" : "months"}. {offer.audience}.
        </span>
      </Link>
    </li>
  );
}
