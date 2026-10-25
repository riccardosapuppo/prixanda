"use client";
// A campaign page: an offer on sale, as the site publishes it. Its title, text
// and terms are the ones the author wrote in the console and the engine
// published; its prices, months and last day are the engine's, read from the
// offers on sale in its market. The page exists if and only if the offer is
// on sale (§7.5): asked for an offer that is not, it says so.
//
// The address names the market and the offer: /campaign/?market=IT&offer=42.
// The site is a static build, so one page serves every campaign and reads
// which one from the address. An offer for an artist's listeners is on sale
// only for them (§6.8): to anyone else, its address reads as one not on sale.
import { formatSitePrice, type MoneyLike } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { copy } from "../../content/copy.ts";
import { type Offer, useMarketName, useMarkets, useOffers, usePlans } from "../../data/hooks.ts";
import { marketFromQuery, type SiteMarket } from "../../data/markets.ts";
import { lastDayBefore } from "../../lib/dates.ts";
import { monthsScene } from "../art/geometry.ts";
import { MonthsDrawing } from "../art/Sails.tsx";
import { Failure, Loading, Named } from "../ui/States.tsx";
import { CampaignAction } from "./CampaignAction.tsx";
import { PromiseBand } from "./PromiseBand.tsx";

export function CampaignView() {
  const search = useSearchParams();
  const market = marketFromQuery(search);
  const offerId = search.get("offer");
  if (market === null || offerId === null || !/^\d+$/.test(offerId)) return <Missing />;
  return <Campaign market={market} offerId={offerId} />;
}

function Campaign({ market, offerId }: { readonly market: SiteMarket; readonly offerId: string }) {
  const offers = useOffers(market);
  const markets = useMarkets();
  const marketNameOf = useMarketName();
  const plans = usePlans(market);
  const offer = offers.data?.find((candidate) => candidate.id === offerId);

  useEffect(() => {
    if (offer) document.title = `${offer.title} · ${copy.service}`;
  }, [offer]);

  if (offers.isPending) {
    return (
      <div className="wrap py-12">
        <Loading />
      </div>
    );
  }
  // The offers are read again every ten seconds while the page is open: a reading that fails takes
  // nothing away. The page stays as read last, with the steps open on it and their keys, and says
  // the reading failed.
  const failure = offers.isError ? <Failure error={offers.error} onRetry={() => void offers.refetch()} /> : null;
  if (offers.data === undefined) return <div className="wrap py-12">{failure}</div>;
  if (!offer) return <Gone market={market} />;
  const marketData = markets.data?.find((candidate) => candidate.code === market);
  // Null while the plans are read: never the plan's code in a sentence.
  const planName = plans.data?.find((candidate) => candidate.code === offer.plan)?.name ?? null;
  return (
    <>
      {failure ? <div className="wrap pt-6">{failure}</div> : null}
      <CampaignPage offer={offer} market={market} marketName={marketNameOf(market)} minimum={marketData?.artistsMinimum ?? null} planName={planName} />
    </>
  );
}

function CampaignPage({ offer, market, marketName, minimum, planName }: {
  readonly offer: Offer;
  readonly market: SiteMarket;
  readonly marketName: string | null;
  readonly minimum: MoneyLike | null;
  readonly planName: string | null;
}) {
  const price = formatSitePrice(offer.price, market);
  const list = formatSitePrice(offer.listPrice, market);
  const months = offer.monthsAtOfferPrice;
  const scene = monthsScene(months);
  const audienceTag = offer.listening
    ? copy.listening.tag(offer.listening.artist)
    : offer.needsStudentCheck ? copy.campaign.studentsIn(marketName ?? market) : copy.campaign.planIn(planName ?? offer.plan, marketName ?? market);
  const tagNamed = offer.listening !== null || (marketName !== null && (offer.needsStudentCheck || planName !== null));
  const until = offer.takeableUntil ? lastDayBefore(offer.takeableUntil.local) : null;
  const tag = offer.takeableUntil ? `${audienceTag} · until ${lastDayBefore(offer.takeableUntil.local, { withYear: false })}` : audienceTag;

  return (
    <article aria-labelledby="campaign-title">
      <section className="wrap grid grid-cols-12 items-center gap-x-[clamp(1.25rem,2.4vw,2.5rem)] gap-y-8 pt-[clamp(1.75rem,3.2vw,3.25rem)] pb-12">
        <div className="col-span-12 grid content-start gap-4 lg:col-span-5">
          <h1 id="campaign-title" className="display m-0 text-[clamp(2.5rem,1.35rem+3.2vw,4.5rem)] leading-none">
            {offer.title}
          </h1>
          <p className="m-0 max-w-[32ch] text-[clamp(1.1875rem,1rem+0.5vw,1.4375rem)] leading-[1.42] italic [text-wrap:pretty]">
            {offer.text}
          </p>
          <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <s className="num text-[1.25rem] font-medium text-ink-2 decoration-2">
              <span className="sr-only">{copy.campaign.usualPrice} </span>
              {list}
            </s>
            <b className="num text-[2.125rem] leading-none font-[720] [font-stretch:112%] md:text-[2.5rem]">{price}</b>
            <span className="basis-full text-md text-ink-2">{copy.campaign.monthsAt(months)}</span>
          </p>
          <CampaignAction offer={offer} market={market} marketName={marketName} planName={planName} />
        </div>
        <figure aria-labelledby="campaign-months" className="col-span-12 m-0 grid gap-2 lg:col-span-7">
          <Named block ready={tagNamed}>
            <p className="m-0 justify-self-start rounded-control border border-saffron bg-stone-0 px-[0.7rem] py-[0.3rem] text-md font-[650] text-saffron">
              {tag}
            </p>
          </Named>
          <MonthsDrawing scene={scene} />
          <figcaption
            id="campaign-months"
            className="grid text-xs leading-[1.35] text-ink-2"
            style={{ gridTemplateColumns: `repeat(${scene.columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: months }, (_, index) => (
              <span key={index} className="grid content-start border-l border-cord pr-[0.3rem] pl-[0.45rem]">
                <b className="num text-lg font-bold text-ink">{price}</b>
                {copy.campaign.month(index + 1)}
              </span>
            ))}
            <span className="grid content-start border-l border-cord pr-[0.3rem] pl-[0.45rem]" style={{ gridColumn: `span ${scene.columns - months}` }}>
              <b className="num text-lg font-bold text-indigo">{list}</b>
              <Named ready={planName !== null}>{copy.campaign.then(planName ?? offer.plan)}</Named>
            </span>
          </figcaption>
        </figure>
      </section>
      {offer.breakdown ? <PromiseBand breakdown={offer.breakdown} minimum={minimum} market={market} /> : null}
      <section aria-label="Details of the offer" className="wrap grid gap-x-12 gap-y-4 border-t border-cord pt-8 pb-16 md:grid-cols-2">
        <p className="m-0 max-w-[62ch]">
          {offer.listening ? copy.listening.forListeners(offer.listening) : `${offer.audience}.`}
          {offer.needsStudentCheck ? ` ${copy.campaign.studentCheckNote}` : null}
        </p>
        <p className="m-0 max-w-[62ch] text-md text-ink-2">
          {offer.terms}
          {until ? ` ${copy.campaign.takeBy(until)}` : null}
        </p>
      </section>
    </article>
  );
}

function Missing() {
  return (
    <section className="wrap grid gap-4 py-16" aria-labelledby="missing-title">
      <h1 id="missing-title" className="title-2 m-0">{copy.campaign.missing.title}</h1>
      <p className="m-0 max-w-[60ch]">{copy.campaign.missing.body}</p>
      <p className="m-0">
        <Link href="/" className="btn">
          {copy.campaign.missing.action}
          <Icon name="arrow-right" size={16} />
        </Link>
      </p>
    </section>
  );
}

function Gone({ market }: { readonly market: SiteMarket }) {
  return (
    <section className="wrap grid gap-4 py-16" aria-labelledby="gone-title">
      <h1 id="gone-title" className="title-2 m-0">{copy.campaign.gone.title}</h1>
      <p className="m-0 max-w-[60ch]">{copy.campaign.gone.body}</p>
      <p className="m-0">
        <Link href={{ pathname: "/", query: { market } }} className="btn">
          {copy.campaign.gone.action}
          <Icon name="arrow-right" size={16} />
        </Link>
      </p>
    </section>
  );
}
