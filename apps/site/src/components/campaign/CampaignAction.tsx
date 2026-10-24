"use client";
// The campaign's action. The engine quotes the offer for this market: the
// price, the months at that price and what comes after are its answer, never
// a figure of the page (§4.5). The quote is asked once per click, with the
// click's own idempotency key, so a retry after a dropped connection gets the
// same quote back instead of a second one.
import { formatSitePrice } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { copy } from "../../content/copy.ts";
import type { SiteRequestQuoteMutation } from "../../graphql/generated.ts";
import { type Offer, useRequestQuote } from "../../data/hooks.ts";
import { newIdempotencyKey } from "../../data/ids.ts";
import type { SiteMarket } from "../../data/markets.ts";
import { Failure, Loading } from "../ui/States.tsx";

type QuoteAnswer = SiteRequestQuoteMutation["requestQuote"];

export function CampaignAction({ offer, market, planName }: { readonly offer: Offer; readonly market: SiteMarket; readonly planName: string }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const quote = useRequestQuote();
  const cta = useRef<HTMLButtonElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const label = offer.needsStudentCheck ? copy.campaign.checkStudent : copy.campaign.take(planName);

  const ask = (idempotencyKey: string) => quote.mutate({ plan: offer.plan, market, offerId: offer.id, idempotencyKey });

  useEffect(() => {
    if (open) head.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <div className="mt-2 grid justify-items-start gap-3">
        <button
          ref={cta}
          type="button"
          className="btn btn-primary btn-big cta"
          onClick={() => {
            const fresh = newIdempotencyKey();
            setKey(fresh);
            setOpen(true);
            ask(fresh);
          }}
        >
          {label}
          <Icon name="arrow-right" size={20} />
        </button>
      </div>
    );
  }

  const back = () => {
    setOpen(false);
    quote.reset();
    requestAnimationFrame(() => cta.current?.focus());
  };

  return (
    <div className="is-entering mt-2 grid gap-4 border border-ink bg-stone px-5 pt-4 pb-5 max-md:px-4">
      <h2 ref={head} tabIndex={-1} className="m-0 text-3xl font-[650] [font-stretch:112%]">
        {copy.quote.title}
      </h2>
      {quote.isPending || quote.isIdle ? <Loading /> : null}
      {quote.isError ? <Failure error={quote.error} {...(key ? { onRetry: () => ask(key) } : {})} /> : null}
      {quote.isSuccess ? <QuoteResult answer={quote.data.requestQuote} market={market} planName={planName} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-quiet" onClick={back}>
          <Icon name="arrow-left" size={16} />
          Back
        </button>
      </div>
    </div>
  );
}

function QuoteResult({ answer, market, planName }: { readonly answer: QuoteAnswer; readonly market: SiteMarket; readonly planName: string }) {
  if (answer.__typename === "QuoteRefusal") {
    return (
      <div role="status" className="grid gap-3">
        <p className="m-0 flex items-baseline gap-2 border border-dashed border-ink bg-stone-0 px-3 py-2">
          <Icon name="info" size={18} className="translate-y-[0.18em]" />
          <span>{answer.reason}</span>
        </p>
        <p className="m-0">
          <Link href={{ pathname: "/", query: { market } }} className="btn">
            {copy.campaign.gone.action}
            <Icon name="arrow-right" size={16} />
          </Link>
        </p>
      </div>
    );
  }
  const price = formatSitePrice(answer.price, market);
  const then = formatSitePrice(answer.thenPrice, market);
  return (
    <div role="status" className="grid gap-1">
      <p className="m-0">
        <b className="num">{price}</b> a month for {answer.monthsAtPrice} {answer.monthsAtPrice === 1 ? "month" : "months"}, then{" "}
        <b className="num">{then}</b> ({planName}, {copy.campaign.vatIncluded}).
      </p>
    </div>
  );
}
