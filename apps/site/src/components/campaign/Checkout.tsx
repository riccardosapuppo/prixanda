"use client";
// Taking a plan, with a campaign's offer or at its list price, step by step,
// each step decided by what the API says:
//
//   1. nobody has entered: the entrance, to become one of the demo's listeners;
//   2. a student plan or offer and no valid student check: the simulated provider;
//   3. the engine's quote for this listener: price, months, what comes after;
//      or its refusal, said plainly, with what is still possible;
//   4. "Confirm demo subscription": the quote confirmed by its id, never a
//      price from the page (§4.5); then the account, where the first month's
//      payment settles.
//
// Each action carries its own idempotency key, made when the visitor acts and
// sent again if the same action is retried. The steps and their keys belong
// to the listener they were made for: the engine binds a key to its request,
// the listener included, so when another listener enters (in another tab,
// say) the steps start over for them, with keys of their own. Each step takes
// the focus when it appears, so a keyboard or a screen reader follows the
// flow; the panel enters with a 4 px fade, which the keyboard and reduced
// motion switch off.
import { formatSitePrice, type IconName, type MoneyLike } from "design";
import { Icon } from "design/icon";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { copy } from "../../content/copy.ts";
import { type Me, useConfirmSubscription, useMarkets, useMe, useRequestQuote, useSignOut, useVerifyStudent } from "../../data/hooks.ts";
import { ActionKeys, newIdempotencyKey } from "../../data/ids.ts";
import { isSiteMarket, type SiteMarket } from "../../data/markets.ts";
import type { SiteRequestQuoteMutation } from "../../graphql/generated.ts";
import { lastDayBefore, siteTime } from "../../lib/dates.ts";
import { Entrance } from "../listener/Entrance.tsx";
import { Failure, Loading } from "../ui/States.tsx";

type Quoted = Extract<SiteRequestQuoteMutation["requestQuote"], { __typename: "Quote" }>;
type Refused = Extract<SiteRequestQuoteMutation["requestQuote"], { __typename: "Refusal" }>;

/** What the visitor is taking: a plan, with a campaign's offer or without one. */
export type Target = {
  readonly plan: string;
  readonly planName: string;
  readonly market: SiteMarket;
  readonly marketName: string;
  /** The campaign's offer, or null for the plan at its list price. */
  readonly offer: { readonly id: string; readonly title: string; readonly audience: string } | null;
  readonly needsStudentCheck: boolean;
  /** The plan's list price, said again when an offer turns out not to be for this listener. */
  readonly listPrice: MoneyLike | null;
};

export type Level = 2 | 3;

export function Checkout({ target, onClose, level = 2 }: { readonly target: Target; readonly onClose: () => void; readonly level?: Level }) {
  // The listener is read again when the tab is seen again and after a check or a confirmation: a
  // reading that fails takes nothing away. The listener read last stays, and the steps with their
  // keys; the failure is said above them, with a try again.
  const me = useMe();
  return (
    <div className="is-entering mt-2 grid gap-4 border border-ink bg-stone px-5 pt-4 pb-5 max-md:px-4">
      {me.isPending ? <Loading /> : null}
      {me.isError ? <Failure error={me.error} onRetry={() => void me.refetch()} /> : null}
      {me.data === null ? (
        <Entrance
          market={target.market}
          elsewhere={target.offer ? copy.entrance.inOtherMarket : (name) => copy.entrance.otherPrices(name, target.marketName)}
          heading={level === 2 ? "h2" : "h3"}
          focusOnMount
        />
      ) : null}
      {me.data ? <Signed key={me.data.id} me={me.data} target={target} level={level} /> : null}
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
 * The steps for the listener of the session, mounted anew for each listener
 * (keyed by their id): a key made for one listener never goes for another.
 */
function Signed({ me, target, level }: { readonly me: Me; readonly target: Target; readonly level: Level }) {
  const verification = me.account.studentVerification;
  const needsCheck = target.needsStudentCheck && !(verification?.valid ?? false);
  // A plan's prices are its market's: a listener of another market subscribes
  // at their own market's prices, so the steps say so before asking for a quote.
  // A campaign's offer says who it is for when the engine refuses it.
  const elsewhere = target.offer === null && me.market !== target.market;
  return (
    <>
      <Who me={me} />
      {elsewhere ? <OtherMarket me={me} target={target} level={level} /> : null}
      {!elsewhere && needsCheck ? <StudentCheck level={level} /> : null}
      {!elsewhere && !needsCheck ? <QuoteStep target={target} me={me} level={level} /> : null}
    </>
  );
}

function OtherMarket({ me, target, level }: { readonly me: Me; readonly target: Target; readonly level: Level }) {
  const markets = useMarkets();
  const theirs = markets.data?.find((each) => each.code === me.market)?.name ?? me.market;
  return (
    <section className="grid gap-3">
      <StepHeading icon="info" level={level}>{copy.refusal.otherMarket.title}</StepHeading>
      <Refusal reason={copy.refusal.otherMarket.body(theirs, target.marketName)}>
        {isSiteMarket(me.market) ? (
          <p className="m-0">
            <Link href={`/?market=${me.market}&plan=${target.plan}#plans` as Route} className="btn btn-primary">
              {copy.refusal.otherMarket.action(theirs)}
              <Icon name="arrow-right" size={16} />
            </Link>
          </p>
        ) : null}
      </Refusal>
    </section>
  );
}

/** Who the steps act for, and the way to be someone else at the end of the row, as in the account, under the name too. */
export function Who({ me }: { readonly me: Me }) {
  const signOut = useSignOut();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-cord pb-3">
      <p className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2">
        <Icon name="user-circle" size={20} className="mt-[0.15rem]" />
        <span className="grid">
          <span className="text-sm text-ink-2">{copy.account.demo}</span>
          <b>{me.title}</b>
        </span>
      </p>
      <button type="button" className="btn btn-quiet ml-auto" aria-disabled={signOut.isPending} onClick={() => signOut.isPending || signOut.mutate()}>
        <Icon name="user-switch" size={16} />
        {copy.entrance.switch}
      </button>
    </div>
  );
}

/** A step's heading takes the focus when the step appears. */
export function StepHeading({ children, icon, level }: { readonly children: ReactNode; readonly icon?: IconName; readonly level: Level }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus(), []);
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <Tag ref={head} tabIndex={-1} className="m-0 flex items-center gap-2 text-3xl font-[650] [font-stretch:112%]">
      {icon ? <Icon name={icon} size={20} /> : null}
      {children}
    </Tag>
  );
}

function StudentCheck({ level }: { readonly level: Level }) {
  const verify = useVerifyStudent();
  // Sent again only to retry a check that ended in an error; the provider's answer spends it.
  const keys = useRef(new ActionKeys<"check">());
  const answer = verify.data?.verifyStudent;
  const check = () => {
    verify.mutate(keys.current.key("check"), { onSuccess: () => keys.current.answered("check") });
  };
  return (
    <section className="grid gap-3" aria-live="polite">
      <StepHeading icon="identification-card" level={level}>{copy.check.title}</StepHeading>
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

function QuoteStep({ target, me, level }: { readonly target: Target; readonly me: Me; readonly level: Level }) {
  const quote = useRequestQuote();
  const [key, setKey] = useState(newIdempotencyKey);
  const ask = (idempotencyKey: string) => quote.mutate({ plan: target.plan, market: target.market, offerId: target.offer?.id ?? null, idempotencyKey });
  // One quote per step: asked when the step appears, with the step's key, and with a new key when
  // the visitor asks again. The step is its listener's: another listener gets a step of their own.
  useEffect(() => {
    ask(key);
  }, [key]);

  if (quote.isError) return <Failure error={quote.error} onRetry={() => ask(key)} />;
  if (!quote.isSuccess) return <Loading label={copy.checkout.asking} />;
  const answer = quote.data.requestQuote;
  if (answer.__typename === "Refusal") {
    return <QuoteRefused refusal={answer} target={target} level={level} onAskAgain={() => setKey(newIdempotencyKey())} />;
  }
  return <Confirm quote={answer} target={target} me={me} level={level} onAskAgain={() => setKey(newIdempotencyKey())} />;
}

function Confirm({ quote, target, me, level, onAskAgain }: {
  readonly quote: Quoted;
  readonly target: Target;
  readonly me: Me;
  readonly level: Level;
  readonly onAskAgain: () => void;
}) {
  const confirm = useConfirmSubscription();
  const markets = useMarkets();
  const router = useRouter();
  const [key] = useState(newIdempotencyKey);
  const timeZone = markets.data?.find((each) => each.code === target.market)?.timeZone;
  const verification = me.account.studentVerification;
  const answer = confirm.data?.confirmSubscription;

  useEffect(() => {
    if (answer?.__typename === "Confirmation") router.push("/account/" as Route);
  }, [answer, router]);

  const price = formatSitePrice(quote.price, target.market);
  const then = formatSitePrice(quote.thenPrice, target.market);
  return (
    <section className="grid gap-4" aria-live="polite">
      <StepHeading level={level}>{copy.checkout.title}</StepHeading>
      {target.needsStudentCheck && verification?.valid ? (
        <p className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 border border-ink bg-stone-0 px-3 py-2">
          <Icon name="seal-check" size={18} className="mt-[0.2rem]" />
          <span>{copy.check.verified(lastDayBefore(verification.validUntil))}</span>
        </p>
      ) : null}
      <div className="grid gap-1">
        <p className="m-0">
          {target.offer ? (
            <>
              <b>{target.offer.title}</b>, {target.planName}
            </>
          ) : (
            <>
              <b>{target.planName}</b>, {target.marketName}
            </>
          )}
        </p>
        <p className="m-0">
          {quote.monthsAtPrice > 0 ? (
            <>
              <b className="num">{copy.checkout.perMonthFor(price, quote.monthsAtPrice)}</b>, {copy.checkout.then(then, target.planName)} ({copy.checkout.vat}).
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
      {answer?.__typename === "Refusal" ? <ConfirmRefused refusal={answer} onAskAgain={onAskAgain} /> : null}
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

export function Refusal({ title, reason, children }: { readonly title?: string; readonly reason: string; readonly children?: ReactNode }) {
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

function QuoteRefused({ refusal, target, level, onAskAgain }: {
  readonly refusal: Refused;
  readonly target: Target;
  readonly level: Level;
  readonly onAskAgain: () => void;
}) {
  const plans: Route = `/?market=${target.market}#plans` as Route;
  if (refusal.code === "NOT_ELIGIBLE") {
    // An offer's own audience, as published, says who it is for: the engine's
    // sentence is about the listener's record, which the page need not repeat.
    return (
      <section className="grid gap-3">
        <StepHeading icon="info" level={level}>{target.offer ? copy.refusal.notForYou : copy.refusal.planNotForYou}</StepHeading>
        <Refusal reason={target.offer ? copy.refusal.whoFor(target.offer.audience) : refusal.reason}>
          {target.offer && target.listPrice ? <p className="m-0">{copy.refusal.stillPlan(target.planName, formatSitePrice(target.listPrice, target.market))}</p> : null}
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
        <StepHeading icon="info" level={level}>{copy.refusal.other}</StepHeading>
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
      <StepHeading icon="info" level={level}>{expired ? copy.refusal.expired : copy.refusal.other}</StepHeading>
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
