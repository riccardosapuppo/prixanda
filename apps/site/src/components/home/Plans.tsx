"use client";
// The plans of the market the visitor is looking at, in the site's order,
// each with what a month of it gives the artists and the campaigns on sale
// for it. The plan chosen opens where it stands: where a month of its money
// goes (the engine's breakdown, drawn as the canopy and written out), what
// it includes, and the way to take it, which opens the steps of a demo
// subscription in its place. The title and the market stay in view while
// the plans scroll. An offer for an artist's listeners is listed only to
// them (§6.8), and says under its flag who it is for.
import { formatPercent, formatSitePrice, type IconName, type MoneyLike } from "design";
import { Icon } from "design/icon";
import type { Route } from "next";
import Link from "next/link";
import { type CSSProperties, useRef, useState } from "react";
import { copy } from "../../content/copy.ts";
import { type Offer, useMarkets, useMe, useOffers, usePlans } from "../../data/hooks.ts";
import type { SiteMarket } from "../../data/markets.ts";
import type { SiteBreakdownFragment, SiteMarketsQuery } from "../../graphql/generated.ts";
import { canopy, priceParts } from "../art/geometry.ts";
import { CanopyDrawing } from "../art/Sails.tsx";
import { Checkout } from "../campaign/Checkout.tsx";
import { Failure, Loading } from "../ui/States.tsx";
import { inSiteOrder, type Plan } from "./plan-order.ts";

type Market = SiteMarketsQuery["markets"][number];

export function Plans({ market, plan, moved, onMarket, onPlan }: {
  readonly market: SiteMarket;
  /** The plan the visitor chose; when the market has no such plan, its first one opens. */
  readonly plan: string;
  /** The visitor has changed something on this page: what changes may enter. */
  readonly moved: boolean;
  readonly onMarket: (market: SiteMarket) => void;
  readonly onPlan: (plan: string) => void;
}) {
  const markets = useMarkets();
  const plans = usePlans(market);
  const offers = useOffers(market);
  const info = markets.data?.find((each) => each.code === market);
  const listed = plans.isSuccess ? inSiteOrder(plans.data) : [];
  const open = listed.some((each) => each.code === plan) ? plan : listed[0]?.code;

  return (
    <section className="plans-sec wrap" id="plans" aria-labelledby="plans-title">
      <div className="chooser">
        <div className="chooser-side">
          <h2 className="title-2 m-0" id="plans-title">{copy.plans.title}</h2>
          <fieldset className="markets">
            <legend>{copy.plans.marketLabel}</legend>
            {markets.isPending ? <Loading /> : null}
            {markets.isError ? <Failure error={markets.error} onRetry={() => void markets.refetch()} /> : null}
            {markets.isSuccess ? (
              <div className="market-options">
                {markets.data.map((each) => (
                  <label key={each.code} className="market">
                    <input
                      type="radio"
                      name="market"
                      value={each.code}
                      checked={each.code === market}
                      onChange={() => onMarket(each.code as SiteMarket)}
                    />
                    <span>{each.name}</span>
                  </label>
                ))}
              </div>
            ) : null}
            <p className="vat-note">{copy.plans.vatNote}</p>
          </fieldset>
          {offers.isSuccess && offers.data.length === 0 ? <p className="vat-note">{copy.plans.noOffers}</p> : null}
        </div>
        <fieldset className="chooser-plans">
          <legend className="sr-only">{copy.plans.legend}</legend>
          {plans.isPending || markets.isPending ? <Loading /> : null}
          {plans.isError ? <Failure error={plans.error} onRetry={() => void plans.refetch()} /> : null}
          {plans.isSuccess && info !== undefined
            ? listed.map((each) => (
              <PlanRow
                key={each.code}
                plan={each}
                market={info}
                open={each.code === open}
                moved={moved}
                offers={(offers.data ?? []).filter((offer) => offer.plan === each.code)}
                onPick={onPlan}
              />
            ))
            : null}
        </fieldset>
      </div>
    </section>
  );
}

function PlanRow({ plan, market, open, moved, offers, onPick }: {
  readonly plan: Plan;
  readonly market: Market;
  readonly open: boolean;
  readonly moved: boolean;
  readonly offers: readonly Offer[];
  readonly onPick: (plan: string) => void;
}) {
  const code = market.code as SiteMarket;
  const write = (money: MoneyLike) => formatSitePrice(money, code);
  const id = `plan-${plan.code}`;
  const price = plan.listPrice ?? (plan.paid ? null : { amountMinor: "0", currency: market.currency });
  return (
    <div className={open ? "plan is-open" : "plan"}>
      <label className="plan-choice">
        <input
          type="radio"
          name="plan"
          value={plan.code}
          checked={open}
          onChange={() => onPick(plan.code)}
          aria-labelledby={`${id}-name`}
          aria-describedby={`${id}-price ${id}-line`}
        />
        <span className="plan-mark" aria-hidden="true" />
        <span className="plan-name" id={`${id}-name`}>{plan.name}</span>
        <span className="plan-line" id={`${id}-line`}>{copy.plans.line(plan.code, plan.entitlements)}</span>
        <span className="plan-price" id={`${id}-price`}>
          {price !== null ? <span className="num">{write(price)}</span> : null}
          {plan.paid && plan.breakdown ? <span className="plan-artists">{copy.plans.toArtists(write(plan.breakdown.artists))}</span> : null}
        </span>
      </label>
      {offers.map((offer) => (
        <p key={offer.id} className="offer-flag">
          <Link href={{ pathname: "/campaign/", query: { market: code, offer: offer.id } }}>
            <Icon name="tag" size={16} />
            {copy.plans.onNow(offer.title, write(offer.price), offer.monthsAtOfferPrice)}
            <Icon name="arrow-right" size={16} />
          </Link>
          {offer.listening ? <span className="offer-why">{copy.listening.forListeners(offer.listening)}</span> : null}
        </p>
      ))}
      {open ? <Decision key={`${market.code}-${plan.code}`} plan={plan} market={market} moved={moved} price={price} /> : null}
    </div>
  );
}

/** The open plan: where its money goes, what it includes, and the way to take it. */
function Decision({ plan, market, moved, price }: {
  readonly plan: Plan;
  readonly market: Market;
  readonly moved: boolean;
  readonly price: MoneyLike | null;
}) {
  const [taking, setTaking] = useState(false);
  const cta = useRef<HTMLButtonElement>(null);
  const code = market.code as SiteMarket;
  const label = `${plan.name}, ${market.name}`;
  const className = moved ? "decision is-entering" : "decision";

  if (taking) {
    return (
      <section className="decision" aria-label={label}>
        <Checkout
          level={3}
          target={{
            plan: plan.code,
            planName: plan.name,
            market: code,
            marketName: market.name,
            offer: null,
            needsStudentCheck: plan.entitlements.needsStudentCheck,
            listPrice: plan.listPrice,
          }}
          onClose={() => {
            setTaking(false);
            requestAnimationFrame(() => cta.current?.focus());
          }}
        />
      </section>
    );
  }

  const act = plan.paid ? (
    <div className="decision-act">
      <button ref={cta} type="button" className="btn btn-primary btn-big cta" onClick={() => setTaking(true)}>
        {plan.entitlements.needsStudentCheck ? copy.campaign.checkStudent : copy.plans.choose(plan.name)}
        <Icon name="arrow-right" size={20} />
      </button>
      {price !== null ? (
        <p>
          <b>{formatSitePrice(price, code)}</b> {copy.plans.monthVat}
        </p>
      ) : null}
    </div>
  ) : <FreeAct />;

  return (
    <section className={className} aria-label={label}>
      {plan.paid && plan.breakdown ? (
        <div className="decision-body">
          <Where breakdown={plan.breakdown} market={market} />
          <div className="decision-side">
            {act}
            <Gets plan={plan} />
          </div>
        </div>
      ) : (
        <>
          {act}
          <Gets plan={plan} />
        </>
      )}
    </section>
  );
}

/** Free needs no step: every demo listener starts on it. */
function FreeAct() {
  const me = useMe();
  const someone = me.isSuccess && me.data !== null;
  return (
    <div className="decision-act">
      <p>{copy.plans.freeLine}</p>
      <Link className="btn" href={"/account/" as Route}>
        <Icon name={someone ? "user-circle" : "user-switch"} size={18} />
        {someone ? copy.plans.seeAccount : copy.plans.freeAction}
      </Link>
    </div>
  );
}

function Where({ breakdown, market }: { readonly breakdown: SiteBreakdownFragment; readonly market: Market }) {
  const code = market.code as SiteMarket;
  const write = (money: MoneyLike) => formatSitePrice(money, code);
  const price = BigInt(breakdown.price.amountMinor);
  const artists = BigInt(breakdown.artists.amountMinor);
  const drawn = canopy(priceParts(breakdown), artists > price ? artists : price, { minimum: BigInt(market.artistsMinimum.amountMinor) });
  const at = drawn.cord === null ? null : (drawn.cord / drawn.width) * 100;
  const rows: readonly (readonly [string, string, MoneyLike])[] = [
    ["artists", copy.plans.rows.artists, breakdown.artists],
    ["service", copy.plans.rows.keeps, breakdown.companyKeeps],
    ["payment", copy.plans.rows.payment, breakdown.paymentCosts],
    ["vat", copy.plans.rows.vat(formatPercent(market.vatBasisPoints)), breakdown.vat],
  ];
  return (
    <div className="where">
      <h3>
        {copy.plans.whereGoes.before}
        <b className="num">{write(breakdown.price)}</b>
        {copy.plans.whereGoes.after}
      </h3>
      <div className="canopy-fig" style={at === null ? undefined : ({ "--at": `${at.toFixed(2)}%` } as CSSProperties)}>
        <CanopyDrawing canopy={drawn} />
        {at !== null ? <span className={at > 62 ? "cord-tag is-end" : "cord-tag"}>{copy.plans.cordTag(write(market.artistsMinimum))}</span> : null}
      </div>
      <dl className="goes">
        {rows.map(([kind, label, money]) => (
          <div key={kind} className={`is-${kind}`}>
            <dt>
              <i className={`swatch swatch-${kind}`} aria-hidden="true" />
              {label}
            </dt>
            <dd>{write(money)}</dd>
          </div>
        ))}
      </dl>
      {BigInt(breakdown.topUp.amountMinor) > 0n ? (
        <p className="goes-note">
          <i className="swatch swatch-topup" aria-hidden="true" />
          <span>{copy.plans.topUpNote(write(breakdown.topUp), write(market.artistsMinimum))}</span>
        </p>
      ) : null}
    </div>
  );
}

function Gets({ plan }: { readonly plan: Plan }) {
  const has = plan.entitlements;
  const words = copy.plans.gets;
  const rows: readonly (readonly [IconName, string, string])[] = [
    ["users", words.seats, String(has.seats)],
    ["skip-forward", words.skips, has.skipsPerHour === null ? words.unlimited : words.perHour(has.skipsPerHour)],
    ["wave-sine", words.sound, has.audio === "LOSSLESS" ? words.lossless : words.standard],
    ["download-simple", words.offline, has.offline ? words.yes : words.no],
  ];
  return (
    <div className="gets">
      <h3>{words.title}</h3>
      <dl>
        {rows.map(([icon, label, value]) => (
          <div key={label}>
            <dt>
              <Icon name={icon} size={18} />
              {label}
            </dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
