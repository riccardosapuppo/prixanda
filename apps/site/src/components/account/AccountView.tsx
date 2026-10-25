"use client";
// The demo listener's account: the plan and what it costs month by month, the
// months left at an offer's price and the day the full price starts, the day
// a paid plan ends, the student check, and the first month's payment (§4.3,
// §4.5, §6.1, §10). Then a price change of the plan, asking for consent or
// telling in advance (§8), and the prepaid passes: the codes bought, and the
// way to activate one (§9). Every date and amount is the engine's.
//
// Payments are asynchronous: a confirmation or a purchase leaves its payment
// pending, and the simulated provider settles it moments later. While one is
// pending the page reads the account again every second, for thirty seconds
// at most; then it says the provider has not answered yet, and lets the
// visitor ask again, for thirty seconds more each time (useMeWhileWaiting).
import { formatSitePrice, type MoneyLike } from "design";
import { Icon } from "design/icon";
import type { Route } from "next";
import Link from "next/link";
import { type ReactNode, useEffect } from "react";
import { copy } from "../../content/copy.ts";
import { type Me, useMarkets, useMeWhileWaiting, usePlans, useSignOut } from "../../data/hooks.ts";
import { isSiteMarket, type SiteMarket } from "../../data/markets.ts";
import type { SitePaymentFragment } from "../../graphql/generated.ts";
import { lastDayBefore, siteDay, siteDayAt } from "../../lib/dates.ts";
import { Entrance } from "../listener/Entrance.tsx";
import { Failure, Loading } from "../ui/States.tsx";
import { ActivateCode, codeMoney, PrepaidCodes } from "./Prepaid.tsx";
import { PriceChanges } from "./PriceChanges.tsx";

/** Whether something of the account waits for the payment provider. */
const waiting = (me: Me | null | undefined) =>
  me?.account.payment?.state === "PENDING" || (me?.account.prepaidCodes ?? []).some((code) => code.state === "PENDING");

export function AccountView() {
  const { me, timedOut, checkAgain } = useMeWhileWaiting(waiting);

  useEffect(() => {
    document.title = `${copy.account.title} · ${copy.service}`;
  }, []);

  return (
    <section className="wrap grid gap-8 pt-[clamp(1.75rem,3vw,3rem)] pb-16" aria-labelledby="account-title">
      <h1 id="account-title" className="display m-0">{copy.account.title}</h1>
      {me.isPending ? <Loading /> : null}
      {me.isError ? <Failure error={me.error} onRetry={() => void me.refetch()} /> : null}
      {me.isSuccess && me.data === null ? (
        <div className="max-w-[44rem]">
          <p className="m-0 mb-4 text-ink-2">{copy.account.nobody}</p>
          <Entrance heading="h2" />
        </div>
      ) : null}
      {me.isSuccess && me.data !== null ? (
        <Account key={me.data.id} me={me.data} timedOut={timedOut} onCheckAgain={checkAgain} />
      ) : null}
    </section>
  );
}

/**
 * The account of the listener of the session, mounted anew for each listener
 * (keyed by their id): a code typed, an answer given and the keys they went
 * with are never sent for another listener.
 */
function Account({ me, timedOut, onCheckAgain }: { readonly me: Me; readonly timedOut: boolean; readonly onCheckAgain: () => void }) {
  const market: SiteMarket | null = isSiteMarket(me.market) ? me.market : null;
  const markets = useMarkets();
  const plans = usePlans(market ?? "IT");
  const signOut = useSignOut();
  const { subscription, payment, studentVerification, priceChanges, prepaidCodes } = me.account;
  const askingYes = priceChanges.some((change) => change.state === "WAITING" && change.kind === "CONSENT");
  const write = (money: MoneyLike) => (market ? formatSitePrice(money, market) : `${money.amountMinor} ${money.currency}`);
  const marketData = markets.data?.find((each) => each.code === me.market);
  const marketName = marketData?.name ?? me.market;
  const planName = plans.data?.find((plan) => plan.code === subscription.plan)?.name ?? subscription.plan;

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2">
          <Icon name="user-circle" size={22} className="mt-[0.2rem]" />
          <span className="grid">
            <span className="text-md text-ink-2">{copy.account.demo}</span>
            <b className="text-xl">{me.title}</b>
          </span>
        </p>
        <button type="button" className="btn btn-quiet" aria-disabled={signOut.isPending} onClick={() => signOut.isPending || signOut.mutate()}>
          <Icon name="user-switch" size={16} />
          {copy.entrance.switch}
        </button>
      </div>

      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-x-12 gap-y-4 border-y border-cord py-4">
        <Fact term={copy.account.plan}>{copy.account.planIn(planName, marketName)}</Fact>
        {subscription.prepaidCode && subscription.prepaidPrice ? (
          <Fact term={copy.account.price}>
            {copy.account.prepaid(write(subscription.prepaidPrice))}
            <span className="block font-normal text-ink-2">{copy.account.prepaidNever}</span>
          </Fact>
        ) : (
          <Fact term={copy.account.price}>{subscription.paid ? copy.account.perMonth(write(subscription.price)) : write(subscription.price)}</Fact>
        )}
        {subscription.offerTitle ? (
          <Fact term={copy.account.offer}>{copy.account.offerLeft(subscription.offerTitle, subscription.offerMonthsLeft, subscription.offerMonths)}</Fact>
        ) : null}
        {subscription.fullPrice && subscription.fullPriceFrom ? (
          <Fact term={copy.account.after}>{copy.account.fullFrom(write(subscription.fullPrice), siteDay(subscription.fullPriceFrom))}</Fact>
        ) : null}
        {subscription.nextBillingOn && subscription.nextCharge ? (
          <Fact term={copy.account.nextBilling}>{copy.account.nextCharge(siteDay(subscription.nextBillingOn), write(subscription.nextCharge))}</Fact>
        ) : null}
        {subscription.endsOn ? (
          <Fact term={copy.account.ends}>
            {askingYes ? copy.account.endsWithoutYes(siteDay(subscription.endsOn)) : copy.account.endsOn(siteDay(subscription.endsOn))}
          </Fact>
        ) : null}
        <Fact term={copy.account.studentCheck}>
          {studentVerification === null
            ? copy.account.noCheck
            : studentVerification.valid
              ? copy.account.checkValid(lastDayBefore(studentVerification.validUntil))
              : copy.account.checkExpired(lastDayBefore(studentVerification.validUntil))}
        </Fact>
      </dl>

      {market && priceChanges.length > 0 ? (
        <PriceChanges changes={priceChanges} market={market} marketName={marketName} planName={planName} />
      ) : null}

      {!subscription.paid ? (
        <div className="grid justify-items-start gap-3">
          <p className="m-0 max-w-[62ch]">{copy.account.free}</p>
          <Link href={(market ? `/?market=${market}` : "/") as Route} className="btn">
            {copy.account.seePlans}
            <Icon name="arrow-right" size={16} />
          </Link>
        </div>
      ) : null}

      {payment ? (
        <PaymentPanel payment={payment} write={write} timeZone={marketData?.timeZone ?? "UTC"} timedOut={timedOut} onCheckAgain={onCheckAgain} />
      ) : null}

      {prepaidCodes.length > 0 ? <PrepaidCodes codes={prepaidCodes} write={codeMoney} timeZone={marketData?.timeZone ?? "UTC"} /> : null}
      {prepaidCodes.some((code) => code.state === "PENDING") && timedOut ? (
        <p className="m-0 flex flex-wrap items-center gap-3">
          <span>{copy.gift.slow}</span>
          <button type="button" className="btn" onClick={onCheckAgain}>
            <Icon name="arrows-clockwise" size={16} />
            {copy.gift.checkAgain}
          </button>
        </p>
      ) : null}
      <ActivateCode me={me} />
    </div>
  );
}

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="grid content-start gap-[0.15rem]">
      <dt className="text-xs text-ink-2">{term}</dt>
      <dd className="num m-0 font-[650]">{children}</dd>
    </div>
  );
}

function PaymentPanel({ payment, write, timeZone, timedOut, onCheckAgain }: {
  readonly payment: SitePaymentFragment;
  readonly write: (money: MoneyLike) => string;
  readonly timeZone: string;
  readonly timedOut: boolean;
  readonly onCheckAgain: () => void;
}) {
  const state = payment.state;
  return (
    <section aria-labelledby="payment-title" className="grid max-w-[44rem] gap-3 border border-ink bg-stone-0 p-[clamp(1rem,3vw,1.75rem)]">
      <h2 id="payment-title" className="m-0 flex items-center gap-2 text-3xl font-[650] [font-stretch:112%]">
        <Icon name="receipt" size={22} />
        {copy.account.payment.title}
        <span className="num ml-auto text-xl font-semibold">{write(payment.amount)}</span>
      </h2>
      <p role="status" aria-live="polite" className="m-0 flex items-baseline gap-2" data-payment-state={state}>
        {state === "PENDING" && !timedOut ? <Icon name="hourglass-medium" size={18} className="translate-y-[0.18em]" /> : null}
        {state === "SUCCEEDED" ? <Icon name="check-circle" size={18} className="translate-y-[0.18em]" /> : null}
        {state === "FAILED" || (state === "PENDING" && timedOut) ? <Icon name="warning-circle" size={18} className="translate-y-[0.18em]" /> : null}
        <span>
          {state === "SUCCEEDED" ? copy.account.payment.succeeded : null}
          {state === "FAILED" ? copy.account.payment.failed : null}
          {state === "PENDING" ? (timedOut ? copy.account.payment.slow : copy.account.payment.pending) : null}
        </span>
      </p>
      {state === "PENDING" && timedOut ? (
        <p className="m-0">
          <button type="button" className="btn" onClick={onCheckAgain}>
            <Icon name="arrows-clockwise" size={16} />
            {copy.account.payment.checkAgain}
          </button>
        </p>
      ) : null}
      {payment.receipt ? (
        <div className="grid gap-2 border-t border-cord pt-3">
          <p className="m-0 font-semibold">
            {copy.account.receipt.title}: {copy.account.receipt.noMoney}
          </p>
          <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-md">
            <dt className="text-ink-2">{copy.account.receipt.number}</dt>
            <dd className="num m-0 break-all">{payment.receipt.id}</dd>
            <dt className="text-ink-2">{copy.account.receipt.amount}</dt>
            <dd className="num m-0">{write(payment.receipt.amount)}</dd>
            <dt className="text-ink-2">{copy.account.receipt.issued}</dt>
            <dd className="num m-0">{siteDayAt(payment.receipt.issuedAt, timeZone)}</dd>
            <dt className="text-ink-2">{copy.account.receipt.reference}</dt>
            <dd className="num m-0 break-all">{payment.receipt.providerReference}</dd>
          </dl>
          <p className="m-0 text-md text-ink-2">{payment.receipt.note}</p>
        </div>
      ) : null}
    </section>
  );
}
