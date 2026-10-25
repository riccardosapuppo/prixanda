"use client";
// The prepaid pass on the home (§9, §14.4): months of a plan paid once, sold
// as a code to keep or to give. The section exists only while a pass is on
// sale somewhere; in a market where none is, it says where one is sold. Its
// title, words and terms are the pass's own, as the console published them;
// its price and months are the engine's.
//
// Buying is a demonstration, in steps like a subscription's: the entrance
// when nobody has entered, then the confirmation with the disclaimer, then
// the code. The payment is asynchronous: the code comes back pending, and the
// account is read again every second, for thirty seconds at most, until the
// simulated provider settles it. The code is like money: it reaches only the
// browser of the listener who bought it, and the page never writes it
// anywhere but on the screen.
import { formatSitePrice } from "design";
import { Icon } from "design/icon";
import type { Route } from "next";
import Link from "next/link";
import { type CSSProperties, useRef, useState } from "react";
import { copy } from "../../content/copy.ts";
import {
  type Me, type PrepaidPass, useBuyPrepaidPass, useMarketName, useMarkets, useMe, useMeWhileWaiting, usePlans, usePrepaidPassesEverywhere,
} from "../../data/hooks.ts";
import { newIdempotencyKey } from "../../data/ids.ts";
import { isSiteMarket, type SiteMarket } from "../../data/markets.ts";
import { siteDay } from "../../lib/dates.ts";
import { passScene } from "../art/geometry.ts";
import { PassDrawing } from "../art/Sails.tsx";
import { Refusal, StepHeading, Who } from "../campaign/Checkout.tsx";
import { Entrance } from "../listener/Entrance.tsx";
import { Failure, Loading, Named } from "../ui/States.tsx";

export function GiftPass({ market, onMarket }: { readonly market: SiteMarket; readonly onMarket: (market: SiteMarket) => void }) {
  const everywhere = usePrepaidPassesEverywhere();
  const marketName = useMarketName();
  const nameOf = (code: string) => marketName(code) ?? code;
  const here = everywhere.passes.find((pass) => pass.market === market);
  const elsewhere = everywhere.passes.find((pass) => pass.market !== market && isSiteMarket(pass.market));
  const shown = here ?? elsewhere;
  if (shown === undefined) return null;
  const scene = passScene(shown.months);

  return (
    <section className="section wrap gift" id="gift" aria-labelledby="gift-title">
      <div className="gift-text">
        <h2 className="title-2 m-0" id="gift-title">{shown.title}</h2>
        <p className="gift-deck">{shown.text}</p>
        {here !== undefined ? (
          <Buy key={here.id} pass={here} marketName={nameOf(here.market)} />
        ) : (
          <Named block ready={marketName(shown.market) !== null}>
            <div className="gift-where">
              <p>{copy.gift.soldIn(shown.title, nameOf(shown.market), formatSitePrice(shown.price, shown.market as SiteMarket))}</p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onMarket(shown.market as SiteMarket);
                  requestAnimationFrame(() => document.getElementById("gift")?.scrollIntoView({ block: "start" }));
                }}
              >
                {copy.gift.showMarket(nameOf(shown.market))}
              </button>
            </div>
          </Named>
        )}
      </div>
      <figure className="months-fig" aria-label={copy.gift.figure(shown.months)}>
        <PassDrawing scene={scene} />
        <figcaption
          className="months-scale"
          style={{ gridTemplateColumns: `repeat(${shown.months}, minmax(0, 1fr)) minmax(0, ${scene.endShare}fr)` } as CSSProperties}
        >
          {Array.from({ length: shown.months }, (_, i) => <span key={i} aria-hidden="true">{i + 1}</span>)}
          <span>{copy.gift.neverRenews}</span>
        </figcaption>
      </figure>
    </section>
  );
}

/** The price and the way to buy; buying opens its steps in place, and Back closes them. */
function Buy({ pass, marketName }: { readonly pass: PrepaidPass; readonly marketName: string }) {
  const [buying, setBuying] = useState(false);
  const cta = useRef<HTMLButtonElement>(null);
  const market = pass.market as SiteMarket;
  if (buying) {
    return (
      <GiftSteps
        pass={pass}
        marketName={marketName}
        onClose={() => {
          setBuying(false);
          requestAnimationFrame(() => cta.current?.focus());
        }}
      />
    );
  }
  return (
    <div className="gift-buy">
      <p className="gift-price">
        <span className="num">{formatSitePrice(pass.price, market)}</span>
        <small>{copy.gift.once}</small>
      </p>
      <button ref={cta} type="button" className="btn btn-primary btn-big" onClick={() => setBuying(true)}>
        <Icon name="gift" size={20} />
        {copy.gift.buy}
      </button>
    </div>
  );
}

function GiftSteps({ pass, marketName, onClose }: { readonly pass: PrepaidPass; readonly marketName: string; readonly onClose: () => void }) {
  // The account is read again after the purchase, and every second while its code waits: a
  // reading that fails takes nothing away. The listener read last stays, and the purchase with its
  // answer and its key, so it is never offered again; the failure is said above, with a try again.
  const me = useMe();
  return (
    <div className="is-entering grid gap-4 border border-ink bg-stone px-5 pt-4 pb-5 max-md:px-4">
      {me.isPending ? <Loading /> : null}
      {me.isError ? <Failure error={me.error} onRetry={() => void me.refetch()} /> : null}
      {me.data === null ? (
        <Entrance market={pass.market} elsewhere={(name) => copy.gift.elsewhere(name, marketName)} heading="h3" focusOnMount />
      ) : null}
      {me.data ? <Signed key={me.data.id} me={me.data} pass={pass} marketName={marketName} /> : null}
      <p className="m-0">
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          <Icon name="arrow-left" size={16} />
          {copy.checkout.back}
        </button>
      </p>
    </div>
  );
}

/**
 * The purchase for the listener of the session, mounted anew for each
 * listener (keyed by their id): its key never goes for another listener, and
 * the code bought shows only to its buyer.
 */
function Signed({ me, pass, marketName }: { readonly me: Me; readonly pass: PrepaidPass; readonly marketName: string }) {
  const markets = useMarkets();
  const theirs = markets.data?.find((each) => each.code === me.market)?.name ?? me.market;
  return (
    <>
      <Who me={me} />
      {me.market !== pass.market ? (
        <section className="grid gap-3">
          <StepHeading icon="info" level={3}>{copy.gift.otherMarket.title}</StepHeading>
          <Refusal reason={copy.gift.otherMarket.body(theirs, marketName)} />
        </section>
      ) : (
        <Confirm pass={pass} marketName={marketName} />
      )}
    </>
  );
}

function Confirm({ pass, marketName }: { readonly pass: PrepaidPass; readonly marketName: string }) {
  const buy = useBuyPrepaidPass();
  const plans = usePlans(pass.market as SiteMarket);
  const [key] = useState(newIdempotencyKey);
  const planName = plans.data?.find((plan) => plan.code === pass.plan)?.name ?? pass.plan;
  const answer = buy.data?.buyPrepaidPass;
  const send = () => {
    if (!buy.isPending && answer === undefined) buy.mutate({ passId: pass.id, idempotencyKey: key });
  };

  if (answer?.__typename === "PrepaidPurchase") return <Bought code={answer.prepaidCode.code} />;
  return (
    <section className="grid gap-4" aria-live="polite">
      <StepHeading icon="gift" level={3}>{copy.gift.confirm.title}</StepHeading>
      <div className="grid gap-1">
        <p className="m-0"><b>{copy.gift.confirm.summary(pass.title, marketName)}</b></p>
        <p className="m-0"><b className="num">{copy.gift.confirm.price(formatSitePrice(pass.price, pass.market as SiteMarket))}</b></p>
        <p className="m-0">{copy.gift.confirm.gives(pass.months, planName, pass.codeValidMonths)}</p>
        {pass.terms ? <p className="m-0 text-md text-ink-2">{pass.terms}</p> : null}
      </div>
      <p className="m-0 max-w-[62ch] text-md text-ink-2">{copy.gift.confirm.note}</p>
      {answer?.__typename === "Refusal" ? <Refusal title={copy.gift.refused} reason={answer.reason} /> : null}
      {buy.isError ? <Failure error={buy.error} onRetry={send} /> : null}
      {answer?.__typename === "Refusal" ? null : (
        <div className="grid justify-items-start gap-3">
          <button type="button" className="btn btn-primary btn-big" aria-disabled={buy.isPending} onClick={send}>
            <Icon name="check" size={18} />
            {buy.isPending ? copy.gift.confirm.buying : copy.gift.confirm.action}
          </button>
          <p className="disclaimer m-0">
            <Icon name="info" size={15} />
            <span>{copy.disclaimer}</span>
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * The code bought, followed in the account until its payment settles: a
 * pending code is not shown as one that works.
 */
function Bought({ code }: { readonly code: string }) {
  const find = (me: Me | null | undefined) => me?.account.prepaidCodes.find((each) => each.code === code);
  // Asked again every second while the code waits for its payment, thirty seconds per round.
  const { me, timedOut, checkAgain } = useMeWhileWaiting((read) => find(read)?.state === "PENDING");
  const bought = find(me.data);
  const state = bought?.state ?? "PENDING";

  if (state === "PENDING") {
    return (
      <section className="grid gap-3">
        <StepHeading icon="hourglass-medium" level={3}>{copy.gift.pendingTitle}</StepHeading>
        <p role="status" className="m-0" data-code-state="PENDING">{timedOut ? copy.gift.slow : copy.gift.waiting}</p>
        {timedOut ? (
          <p className="m-0">
            <button type="button" className="btn" onClick={checkAgain}>
              <Icon name="arrows-clockwise" size={16} />
              {copy.gift.checkAgain}
            </button>
          </p>
        ) : null}
      </section>
    );
  }
  if (state === "FAILED" || bought === undefined) {
    return (
      <section className="grid gap-3">
        <StepHeading icon="warning-circle" level={3}>{copy.gift.refused}</StepHeading>
        <p role="status" className="m-0" data-code-state={state}>{copy.gift.failed}</p>
      </section>
    );
  }
  return <Receipt code={bought.code} validUntil={bought.validUntil} />;
}

function Receipt({ code, validUntil }: { readonly code: string; readonly validUntil: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="grid gap-3" data-code-state="READY">
      <StepHeading icon="receipt" level={3}>{copy.gift.receipt.title}</StepHeading>
      <p className="gift-code">
        <span>{copy.gift.receipt.code}</span>
        <b className="code">{code}</b>
      </p>
      <p className="m-0">{copy.gift.receipt.validUntil(siteDay(validUntil))} {copy.gift.receipt.give}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={16} />
          {copied ? copy.gift.receipt.copied : copy.gift.receipt.copy}
        </button>
        <Link href={"/account/" as Route} className="btn">
          {copy.gift.receipt.account}
          <Icon name="arrow-right" size={16} />
        </Link>
      </div>
      <p className="disclaimer m-0">
        <Icon name="info" size={15} />
        <span>{copy.disclaimer}</span>
      </p>
    </section>
  );
}
