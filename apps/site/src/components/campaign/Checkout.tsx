"use client";
// Taking a campaign, step by step, each step decided by what the API says:
//
//   1. nobody has entered: the entrance, to become one of the demo's listeners;
//   2. a student offer and no valid student check: the simulated provider;
//   3. the engine's quote for this listener: price, months, what comes after;
//      or its refusal, said plainly, with what is still possible;
//   4. "Confirm demo subscription": the quote confirmed by its id, never a
//      price from the page (§4.5); then the account, where the first month's
//      payment settles.
//
// Each action carries its own idempotency key, made when the visitor acts and
// sent again if the same action is retried. Each step takes the focus when it
// appears, so a keyboard or a screen reader follows the flow; it enters with a
// 4 px fade, which the keyboard and reduced motion switch off.
import { formatSitePrice } from "design";
import { Icon } from "design/icon";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { copy } from "../../content/copy.ts";
import {
  type Me, type Offer, useConfirmSubscription, useMarkets, useMe, useRequestQuote, useSignOut, useVerifyStudent,
} from "../../data/hooks.ts";
import { newIdempotencyKey } from "../../data/ids.ts";
import type { SiteMarket } from "../../data/markets.ts";
import type { SiteRequestQuoteMutation } from "../../graphql/generated.ts";
import { lastDayBefore, siteTime } from "../../lib/dates.ts";
import { Entrance } from "../listener/Entrance.tsx";
import { Failure, Loading } from "../ui/States.tsx";

type Quoted = Extract<SiteRequestQuoteMutation["requestQuote"], { __typename: "Quote" }>;
type Refused = Extract<SiteRequestQuoteMutation["requestQuote"], { __typename: "Refusal" }>;

export function Checkout({ offer, market, planName, onClose }: {
  readonly offer: Offer;
  readonly market: SiteMarket;
  readonly planName: string;
  readonly onClose: () => void;
}) {
  const me = useMe();
  return (
    <div className="is-entering mt-2 grid gap-4 border border-ink bg-stone px-5 pt-4 pb-5 max-md:px-4">
      {me.isPending ? <Loading /> : null}
      {me.isError ? <Failure error={me.error} onRetry={() => void me.refetch()} /> : null}
      {me.isSuccess && me.data === null ? <Entrance market={market} heading="h2" focusOnMount /> : null}
      {me.isSuccess && me.data !== null ? <Signed me={me.data} offer={offer} market={market} planName={planName} /> : null}
      <p className="m-0">
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          <Icon name="arrow-left" size={16} />
          {copy.checkout.back}
        </button>
      </p>
    </div>
  );
}

function Signed({ me, offer, market, planName }: { readonly me: Me; readonly offer: Offer; readonly market: SiteMarket; readonly planName: string }) {
  const verification = me.account.studentVerification;
  const needsCheck = offer.needsStudentCheck && !(verification?.valid ?? false);
  return (
    <>
      <Who me={me} />
      {needsCheck ? <StudentCheck /> : <QuoteStep offer={offer} market={market} planName={planName} me={me} />}
    </>
  );
}

/** Who the steps act for, and the way to be someone else. */
function Who({ me }: { readonly me: Me }) {
  const signOut = useSignOut();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-cord pb-3">
      <p className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2">
        <Icon name="user-circle" size={20} className="mt-[0.15rem]" />
        <span className="grid">
          <b>{me.title}</b>
          <span className="text-sm text-ink-2">{copy.account.demo}</span>
        </span>
      </p>
      <button type="button" className="btn btn-quiet" aria-disabled={signOut.isPending} onClick={() => signOut.isPending || signOut.mutate()}>
        <Icon name="user-switch" size={16} />
        {copy.entrance.switch}
      </button>
    </div>
  );
}

/** A step's heading takes the focus when the step appears. */
function StepHeading({ children, icon }: { readonly children: ReactNode; readonly icon?: "identification-card" | "receipt" | "info" }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus(), []);
  return (
    <h2 ref={head} tabIndex={-1} className="m-0 flex items-center gap-2 text-3xl font-[650] [font-stretch:112%]">
      {icon ? <Icon name={icon} size={20} /> : null}
      {children}
    </h2>
  );
}

function StudentCheck() {
  const verify = useVerifyStudent();
  const [key, setKey] = useState<string | null>(null);
  const answer = verify.data?.verifyStudent;
  const check = () => {
    const fresh = key ?? newIdempotencyKey();
    setKey(fresh);
    verify.mutate(fresh);
  };
  return (
    <section className="grid gap-3" aria-live="polite">
      <StepHeading icon="identification-card">{copy.check.title}</StepHeading>
      <p className="m-0 max-w-[62ch] text-md text-ink-2">{copy.check.note}</p>
      {answer?.__typename === "Refusal" ? <Refusal title={copy.check.refused} reason={answer.reason} /> : null}
      {verify.isError ? <Failure error={verify.error} onRetry={check} /> : null}
      {answer?.__typename === "Refusal" ? null : (
        <p className="m-0">
          <button type="button" className="btn btn-primary" aria-disabled={verify.isPending} onClick={() => verify.isPending || check()}>
            <Icon name="seal-check" size={18} />
            {copy.check.action}
          </button>
        </p>
      )}
    </section>
  );
}

function QuoteStep({ offer, market, planName, me }: { readonly offer: Offer; readonly market: SiteMarket; readonly planName: string; readonly me: Me }) {
  const quote = useRequestQuote();
  const [key, setKey] = useState(newIdempotencyKey);
  const ask = (idempotencyKey: string) => quote.mutate({ plan: offer.plan, market, offerId: offer.id, idempotencyKey });
  // One quote per listener and step: asked when the step appears, with the step's key.
  useEffect(() => {
    ask(key);
  }, [key, me.id]);

  if (quote.isError) return <Failure error={quote.error} onRetry={() => ask(key)} />;
  if (!quote.isSuccess) return <Loading label={copy.checkout.asking} />;
  const answer = quote.data.requestQuote;
  if (answer.__typename === "Refusal") {
    return <QuoteRefused refusal={answer} offer={offer} market={market} planName={planName} onAskAgain={() => setKey(newIdempotencyKey())} />;
  }
  return <Confirm quote={answer} offer={offer} market={market} planName={planName} me={me} onAskAgain={() => setKey(newIdempotencyKey())} />;
}

function Confirm({ quote, offer, market, planName, me, onAskAgain }: {
  readonly quote: Quoted;
  readonly offer: Offer;
  readonly market: SiteMarket;
  readonly planName: string;
  readonly me: Me;
  readonly onAskAgain: () => void;
}) {
  const confirm = useConfirmSubscription();
  const markets = useMarkets();
  const router = useRouter();
  const [key] = useState(newIdempotencyKey);
  const timeZone = markets.data?.find((each) => each.code === market)?.timeZone;
  const verification = me.account.studentVerification;
  const answer = confirm.data?.confirmSubscription;

  useEffect(() => {
    if (answer?.__typename === "Confirmation") router.push("/account/" as Route);
  }, [answer, router]);

  const price = formatSitePrice(quote.price, market);
  const then = formatSitePrice(quote.thenPrice, market);
  return (
    <section className="grid gap-4" aria-live="polite">
      <StepHeading>{copy.checkout.title}</StepHeading>
      {offer.needsStudentCheck && verification?.valid ? (
        <p className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 border border-ink bg-stone-0 px-3 py-2">
          <Icon name="seal-check" size={18} className="mt-[0.2rem]" />
          <span>{copy.check.verified(lastDayBefore(verification.validUntil))}</span>
        </p>
      ) : null}
      <div className="grid gap-1">
        <p className="m-0">
          <b>{offer.title}</b>, {planName}
        </p>
        <p className="m-0">
          {quote.monthsAtPrice > 0 ? (
            <>
              <b className="num">{copy.checkout.perMonthFor(price, quote.monthsAtPrice)}</b>, {copy.checkout.then(then, planName)} ({copy.checkout.vat}).
            </>
          ) : (
            <>
              <b className="num">{copy.checkout.atList(price)}</b> ({copy.checkout.vat}).
            </>
          )}
        </p>
        {timeZone ? <p className="m-0 text-md text-ink-2">{copy.checkout.holds(siteTime(quote.expiresAt, timeZone))}</p> : null}
      </div>
      <p className="m-0 max-w-[62ch] text-md text-ink-2">{copy.checkout.note}</p>
      {answer?.__typename === "Refusal" ? (
        <ConfirmRefused refusal={answer} onAskAgain={onAskAgain} />
      ) : null}
      {confirm.isError ? <Failure error={confirm.error} onRetry={() => confirm.mutate({ quoteId: quote.id, idempotencyKey: key })} /> : null}
      <div className="grid justify-items-start gap-3">
        <button
          type="button"
          className="btn btn-primary btn-big"
          aria-disabled={confirm.isPending || answer !== undefined}
          onClick={() => {
            if (!confirm.isPending && answer === undefined) confirm.mutate({ quoteId: quote.id, idempotencyKey: key });
          }}
        >
          {confirm.isPending ? copy.checkout.subscribing : copy.checkout.confirm}
        </button>
        <p className="disclaimer m-0">
          <Icon name="info" size={15} />
          <span>{copy.disclaimer}</span>
        </p>
      </div>
    </section>
  );
}

function Refusal({ title, reason, children }: { readonly title?: string; readonly reason: string; readonly children?: ReactNode }) {
  return (
    <div role="status" className="grid gap-3">
      {title ? <p className="m-0 font-semibold">{title}</p> : null}
      <p className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 border border-dashed border-ink bg-stone-0 px-3 py-2">
        <Icon name="info" size={18} className="mt-[0.2rem]" />
        <span>{reason}</span>
      </p>
      {children}
    </div>
  );
}

function QuoteRefused({ refusal, offer, market, planName, onAskAgain }: {
  readonly refusal: Refused;
  readonly offer: Offer;
  readonly market: SiteMarket;
  readonly planName: string;
  readonly onAskAgain: () => void;
}) {
  const plans: Route = `/?market=${market}` as Route;
  if (refusal.code === "NOT_ELIGIBLE") {
    // The offer's own audience, as published, says who it is for: the engine's
    // sentence is about the listener's record, which the page need not repeat.
    return (
      <section className="grid gap-3">
        <StepHeading icon="info">{copy.refusal.notForYou}</StepHeading>
        <Refusal reason={copy.refusal.whoFor(offer.audience)}>
          <p className="m-0">{copy.refusal.stillPlan(planName, formatSitePrice(offer.listPrice, market))}</p>
          <p className="m-0">
            <Link href={plans} className="btn btn-primary">
              {copy.refusal.seePlans}
              <Icon name="arrow-right" size={16} />
            </Link>
          </p>
        </Refusal>
      </section>
    );
  }
  if (refusal.code === "ALREADY_SUBSCRIBED") {
    return (
      <section className="grid gap-3">
        <StepHeading icon="info">{copy.refusal.other}</StepHeading>
        <Refusal reason={refusal.reason}>
          <p className="m-0">
            <Link href={"/account/" as Route} className="btn">
              {copy.refusal.seeAccount}
              <Icon name="arrow-right" size={16} />
            </Link>
          </p>
        </Refusal>
      </section>
    );
  }
  const expired = refusal.code === "QUOTE_EXPIRED" || refusal.code === "OFFER_ENDED";
  return (
    <section className="grid gap-3">
      <StepHeading icon="info">{expired ? copy.refusal.expired : copy.refusal.other}</StepHeading>
      <Refusal reason={refusal.reason}>
        <p className="m-0">
          {expired ? (
            <button type="button" className="btn" onClick={onAskAgain}>
              <Icon name="arrows-clockwise" size={16} />
              {copy.checkout.askAgain}
            </button>
          ) : (
            <Link href={plans} className="btn">
              {copy.refusal.seePlans}
              <Icon name="arrow-right" size={16} />
            </Link>
          )}
        </p>
      </Refusal>
    </section>
  );
}

function ConfirmRefused({ refusal, onAskAgain }: { readonly refusal: Refused; readonly onAskAgain: () => void }) {
  const expired = refusal.code === "QUOTE_EXPIRED" || refusal.code === "OFFER_ENDED";
  return (
    <Refusal title={expired ? copy.refusal.expired : refusal.code === "NOT_ELIGIBLE" ? copy.refusal.notForYou : copy.refusal.other} reason={refusal.reason}>
      <p className="m-0">
        {expired ? (
          <button type="button" className="btn" onClick={onAskAgain}>
            <Icon name="arrows-clockwise" size={16} />
            {copy.checkout.askAgain}
          </button>
        ) : (
          <Link href={"/account/" as Route} className="btn">
            {copy.refusal.seeAccount}
            <Icon name="arrow-right" size={16} />
          </Link>
        )}
      </p>
    </Refusal>
  );
}
