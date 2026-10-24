"use client";
// A price change of the running subscription (§8), as the engine sent it.
// In a consent market (Germany) it is a request: two answers of the same
// weight, side by side, each with what follows from it, and silence counted
// as no, in so many words. In a notice market (Italy, France, the United
// Kingdom) it is a notice: the new price and the day it applies, and the way
// to leave before it. The law and the service's commercial choice are two
// blocks, never one sentence. Every date is the engine's: the page computes
// none. Once answered, the panel says what will happen, and from when.
import { formatSitePrice, type MoneyLike } from "design";
import { Icon } from "design/icon";
import { type ReactNode, useEffect, useRef } from "react";
import { copy } from "../../content/copy.ts";
import { useAnswerPriceChange } from "../../data/hooks.ts";
import { newIdempotencyKey } from "../../data/ids.ts";
import type { SiteMarket } from "../../data/markets.ts";
import type { SitePriceChangeFragment } from "../../graphql/generated.ts";
import { lastDayBefore, siteDay } from "../../lib/dates.ts";
import { sheetDepth } from "../art/geometry.ts";
import { PeriodSheet } from "../art/Sails.tsx";
import { Refusal } from "../campaign/Checkout.tsx";
import { Failure } from "../ui/States.tsx";

type PriceChange = SitePriceChangeFragment;

export function PriceChanges({ changes, market, marketName, planName }: {
  readonly changes: readonly PriceChange[];
  readonly market: SiteMarket;
  readonly marketName: string;
  readonly planName: string;
}) {
  return (
    <>
      {changes.map((change) => <PriceChangePanel key={change.id} change={change} market={market} marketName={marketName} planName={planName} />)}
    </>
  );
}

function PriceChangePanel({ change, market, marketName, planName }: {
  readonly change: PriceChange;
  readonly market: SiteMarket;
  readonly marketName: string;
  readonly planName: string;
}) {
  const answer = useAnswerPriceChange();
  // One key per answer, made when the visitor first gives it and sent again if that answer is retried.
  const keys = useRef<{ yes?: string; no?: string }>({});
  const send = (accept: boolean) => {
    if (answer.isPending) return;
    const which = accept ? "yes" : "no";
    const key = keys.current[which] ?? newIdempotencyKey();
    keys.current[which] = key;
    answer.mutate({ priceChangeId: change.id, accept, idempotencyKey: key });
  };
  const write = (money: MoneyLike) => formatSitePrice(money, market);
  const title = copy.priceChange.title(planName);
  const id = `price-change-${change.id}`;
  const refused = answer.data?.answerPriceChange.__typename === "Refusal" ? answer.data.answerPriceChange : null;
  const problems = (
    <>
      {refused ? <Refusal title={copy.priceChange.refused} reason={refused.reason} /> : null}
      {answer.isError ? <Failure error={answer.error} /> : null}
    </>
  );

  if (change.state === "WAITING" && change.kind === "CONSENT") {
    return (
      <section className="consent" aria-labelledby={`${id}-title`} data-price-change={change.state}>
        <h2 className="consent-title" id={`${id}-title`}>{title}</h2>
        <Consent change={change} id={id} write={write} marketName={marketName} planName={planName} busy={answer.isPending} onAnswer={send} />
        {problems}
        <Basis change={change} id={id} />
      </section>
    );
  }
  if (change.state === "WAITING") {
    return (
      <section className="consent" aria-labelledby={`${id}-title`} data-price-change={change.state}>
        <h2 className="consent-title" id={`${id}-title`}>{title}</h2>
        <Notice change={change} id={id} write={write} marketName={marketName} planName={planName} busy={answer.isPending} onLeave={() => send(false)} />
        {problems}
        <Basis change={change} id={id} />
      </section>
    );
  }
  return (
    <section className="consent" aria-labelledby={`${id}-title`} data-price-change={change.state}>
      <h2 className="consent-title" id={`${id}-title`}>{title}</h2>
      <Outcome change={change} write={write} planName={planName} focus={answer.isSuccess} />
      <Basis change={change} id={id} />
    </section>
  );
}

function Consent({ change, id, write, marketName, planName, busy, onAnswer }: {
  readonly change: PriceChange;
  readonly id: string;
  readonly write: (money: MoneyLike) => string;
  readonly marketName: string;
  readonly planName: string;
  readonly busy: boolean;
  readonly onAnswer: (accept: boolean) => void;
}) {
  const words = copy.priceChange.consent;
  const deadline = lastDayBefore(change.windowEnds.local);
  const oldPrice = write(change.oldPrice);
  const newPrice = write(change.newPrice);
  const yesFrom = change.appliesFrom;
  const noOn = change.ifNoLeavesOn;
  return (
    <>
      <div className="consent-body">
        <p>{words.now(oldPrice, siteDay(change.newSubscribersFrom.local), planName, marketName, newPrice)}</p>
        <p className="consent-ask">{words.ask(newPrice)}</p>
      </div>
      <Paths change={change} id={id} write={write} planName={planName} deadline={deadline} />
      <div className="answers">
        <div className="answer">
          <button type="button" className="btn answer-btn" aria-describedby={`${id}-yes`} aria-disabled={busy} onClick={() => onAnswer(true)}>
            {words.yes(newPrice)}
          </button>
          <p id={`${id}-yes`}>{yesFrom ? words.ifYes(newPrice, siteDay(yesFrom)) : null}</p>
        </div>
        <div className="answer">
          <button type="button" className="btn answer-btn" aria-describedby={`${id}-no`} aria-disabled={busy} onClick={() => onAnswer(false)}>
            {noOn ? words.no(planName, siteDay(noOn, { withYear: false })) : words.noPlain}
          </button>
          <p id={`${id}-no`}>{noOn ? words.ifNo(deadline, planName, siteDay(noOn)) : words.ifNoOther(deadline)}</p>
        </div>
      </div>
      <p className="silence">
        <Icon name="hourglass-medium" size={18} />
        <span>{words.silence(deadline)}</span>
      </p>
    </>
  );
}

/**
 * The two futures side by side, with the same weight: the plan as it is
 * until the change, then each answer's. Over each paid period a sheet hangs
 * from the rope, as deep as its price; the free plan leaves the rope bare.
 */
function Paths({ change, id, write, planName, deadline }: {
  readonly change: PriceChange;
  readonly id: string;
  readonly write: (money: MoneyLike) => string;
  readonly planName: string;
  readonly deadline: string;
}) {
  const lanes = copy.priceChange.consent.lanes;
  const now = BigInt(change.oldPrice.amountMinor);
  const yesDay = change.appliesFrom;
  const noDay = change.ifNoLeavesOn;
  const oneDay = yesDay !== null && yesDay === noDay;
  const dated = (day: string | null, body: ReactNode) => (oneDay || day === null ? body : <>{siteDay(day, { withYear: false })}: {body}</>);
  const lane = (title: string, then: ReactNode, depth: number, free: boolean) => (
    <div className="path">
      <p className="path-title">{title}</p>
      <div className="path-track">
        <span className="path-seg">
          <PeriodSheet depth={sheetDepth(now, now)} free={false} />
          <b>{planName}</b> {write(change.oldPrice)}
        </span>
        <span className="path-seg is-then">
          <PeriodSheet depth={depth} free={free} />
          {then}
        </span>
      </div>
    </div>
  );
  return (
    <figure className="paths" aria-labelledby={`${id}-paths`}>
      <figcaption className="paths-axis" id={`${id}-paths`}>
        <span>{lanes.today}</span>
        {oneDay ? <span className="paths-day">{siteDay(yesDay)}</span> : null}
      </figcaption>
      {lane(lanes.yes, dated(yesDay, <><b>{planName}</b> {write(change.newPrice)}</>), sheetDepth(BigInt(change.newPrice.amountMinor), now), false)}
      {lane(lanes.no(deadline), dated(noDay, <b>{lanes.free}</b>), 0, true)}
    </figure>
  );
}

function Notice({ change, id, write, marketName, planName, busy, onLeave }: {
  readonly change: PriceChange;
  readonly id: string;
  readonly write: (money: MoneyLike) => string;
  readonly marketName: string;
  readonly planName: string;
  readonly busy: boolean;
  readonly onLeave: () => void;
}) {
  const words = copy.priceChange.notice;
  const leaves = change.ifNoLeavesOn;
  return (
    <>
      <div className="consent-body">
        <p>{change.appliesFrom ? words.now(write(change.oldPrice), write(change.newPrice), siteDay(change.appliesFrom)) : null}</p>
        <p>{words.newSubscribers(planName, marketName, siteDay(change.newSubscribersFrom.local))}</p>
      </div>
      {leaves ? (
        <div className="answer notice-leave">
          <p id={`${id}-leave`}>{words.leave(siteDay(leaves))}</p>
          <button type="button" className="btn answer-btn" aria-describedby={`${id}-leave`} aria-disabled={busy} onClick={onLeave}>
            {words.leaveAction(siteDay(leaves, { withYear: false }))}
          </button>
          <p className="text-md text-ink-2">{words.closes(lastDayBefore(change.windowEnds.local))}</p>
        </div>
      ) : null}
    </>
  );
}

/** What happens now that the change is answered, or its window has ended: the engine's dates, as they are. */
function Outcome({ change, write, planName, focus }: {
  readonly change: PriceChange;
  readonly write: (money: MoneyLike) => string;
  readonly planName: string;
  readonly focus: boolean;
}) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) head.current?.focus();
  }, [focus]);
  const words = copy.priceChange.outcome;
  const kept = change.state === "ACCEPTED" || change.state === "NEW_PRICE";
  let title: string = words.choiceApplies;
  let what: string = change.ifNoAnswer;
  if (change.state === "ACCEPTED" && change.newPriceFrom) {
    title = words.accepted;
    what = words.acceptedWhat(write(change.newPrice), siteDay(change.newPriceFrom));
  } else if (change.state === "NEW_PRICE" && change.newPriceFrom) {
    title = words.newPrice;
    what = words.newPriceWhat(write(change.newPrice), siteDay(change.newPriceFrom));
  } else if (change.state === "DECLINED" && change.kind === "NOTICE") {
    title = words.left;
    what = change.leavesOn ? words.leftWhat(planName, siteDay(change.leavesOn)) : change.ifNoAnswer;
  } else if (change.state === "DECLINED" || change.state === "LAPSED") {
    title = change.state === "DECLINED" ? words.declined : words.lapsed;
    what = change.leavesOn ? words.declinedWhat(planName, siteDay(change.leavesOn)) : `${words.choiceApplies} ${change.ifNoAnswer}`;
  }
  return (
    <div className={`outcome-card${kept ? "" : " is-declined"}${focus ? " is-entering" : ""}`} role="status">
      <h3 ref={head} tabIndex={-1}>
        <Icon name={kept ? "check-circle" : "calendar-check"} size={22} />
        {title}
      </h3>
      <p>{what}</p>
    </div>
  );
}

/** The law of the market and the service's choice: two blocks, each with its own source. */
function Basis({ change, id }: { readonly change: PriceChange; readonly id: string }) {
  return (
    <div className="basis">
      <section className="basis-block" aria-labelledby={`${id}-law`}>
        <h3 id={`${id}-law`}>{copy.priceChange.law}</h3>
        <p className="basis-detail">{change.legalBasis}</p>
      </section>
      <section className="basis-block is-choice" aria-labelledby={`${id}-choice`}>
        <h3 id={`${id}-choice`}>{copy.priceChange.choice}</h3>
        <p className="basis-detail">{change.ifNoAnswer}</p>
        <p className="basis-tag">{copy.priceChange.choiceTag}</p>
      </section>
    </div>
  );
}
