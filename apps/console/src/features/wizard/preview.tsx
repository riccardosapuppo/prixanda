"use client";
// The campaign as it would read on the service's site, next to the form: the
// page's own words, the offer price and the struck list price as the site
// writes them in that country, the months at the offer price, then the list
// price. Before shows the plan as it is sold today. Nothing here can be
// pressed: it is a picture of a page that goes live only after approval and
// activation.
import { BRAND, DISCLAIMER, formatSitePrice, type MarketCode, type MoneyLike, parseAmount } from "design";
import { Icon } from "design/icon";
import { useId, useState } from "react";
import { type OfferForm, parsePercent } from "../../lib/offer-form.ts";
import { useArtistNames } from "./artists.tsx";
import { formatLocal, parseLocal } from "../../lib/time.ts";

export type PreviewMarket = { readonly code: string; readonly name: string; readonly currency: string; readonly timeZone: string };
export type PreviewPlan = { readonly code: string; readonly name: string; readonly listPrice: MoneyLike | null; readonly needsStudentCheck: boolean };

const SITE_MARKETS = new Set(["IT", "FR", "DE", "GB"]);

function sitePrice(money: MoneyLike, market: string): string {
  return SITE_MARKETS.has(market) ? formatSitePrice(money, market as MarketCode) : `${money.amountMinor} ${money.currency}`;
}

/**
 * The offer price in a market, from what is typed: a fixed amount as it
 * reads, a percentage as "40% off" (the engine computes that price and
 * rounds it the currency's way; the console does not do it twice).
 */
export function offerPriceOf(form: OfferForm, market: string, currency: string): { readonly money: MoneyLike } | { readonly percent: string } | null {
  const entry = form.markets.find((candidate) => candidate.market === market);
  if (entry === undefined) return null;
  if (entry.priceKind === "fixed") {
    const amount = parseAmount(entry.fixed, currency);
    return amount === null || amount <= 0n ? null : { money: { amountMinor: amount.toString(), currency } };
  }
  return parsePercent(entry.percent) === null ? null : { percent: `${entry.percent.trim().replace(/%$/, "")}% off` };
}

function audienceWords(form: OfferForm, marketName: string, artist: string | null): string {
  const student = form.needsStudentCheck;
  // A fans' campaign (§14.2): the site shows it to them alone.
  if (form.fans && artist !== null && (form.segment === "FREE_LISTENERS" || form.segment === "NEVER_PAID")) {
    return form.segment === "FREE_LISTENERS" ? `Fans of ${artist} on Free in ${marketName}` : `Fans of ${artist} in ${marketName} who have never paid`;
  }
  switch (form.segment) {
    case "NEVER_PAID":
      return `${student ? "Verified students" : "People"} in ${marketName} who have never paid`;
    case "FREE_LISTENERS":
      return `${student ? "Verified students" : "Listeners"} on Free in ${marketName}`;
    case "SUBSCRIBERS_OF_PLAN":
      return `${student ? "Verified students" : "Subscribers"} in ${marketName} on ${form.currentPlan || "a plan"}`;
    case "ANYONE":
      return `Anyone in ${marketName}`;
    default:
      return "Audience not chosen yet";
  }
}

export function SitePreview({ form, markets, plans }: {
  readonly form: OfferForm;
  readonly markets: readonly PreviewMarket[];
  readonly plans: Readonly<Record<string, readonly PreviewPlan[]>>;
}) {
  const [view, setView] = useState<"before" | "after">("after");
  const [chosen, setChosen] = useState<string | null>(null);
  const headingId = useId();
  const marketCodes = form.markets.map((entry) => entry.market);
  const marketCode = chosen !== null && marketCodes.includes(chosen) ? chosen : (marketCodes[0] ?? null);
  const market = markets.find((candidate) => candidate.code === marketCode) ?? null;
  const plan = market ? (plans[market.code] ?? []).find((candidate) => candidate.code === form.plan) ?? null : null;
  const entry = form.markets.find((candidate) => candidate.market === marketCode) ?? null;
  const listPrice = plan?.listPrice ?? null;
  const offerPrice = market ? offerPriceOf(form, market.code, market.currency) : null;
  const months = Number(form.months) || 0;
  const starts = entry && parseLocal(entry.startsLocal) && market ? formatLocal(entry.startsLocal, market.timeZone, { withYear: false }).split(",")[0] : null;
  const studentCta = form.needsStudentCheck || plan?.needsStudentCheck;
  const fansOf = form.fans && form.artist !== "" ? Number(form.artist) : null;
  const artistNames = useArtistNames(fansOf === null ? [] : [fansOf]);
  const artist = fansOf === null ? null : artistNames.get(fansOf) ?? `artist #${fansOf}`;

  return (
    <section className="grid min-w-0 content-start gap-3 xl:sticky xl:top-4" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="flex items-center gap-2 text-xl font-bold">
          <Icon name="eye" size={18} />
          On {BRAND.service}
        </h2>
        <div className="flex flex-wrap gap-2">
          {marketCodes.length > 1 ? (
            <div className="inline-flex rounded-control border border-edge bg-stone-0" role="group" aria-label="Market">
              {marketCodes.map((code) => (
                <button key={code} type="button" aria-pressed={code === marketCode} onClick={() => setChosen(code)} className={`min-h-9 px-3 text-sm font-semibold [&+&]:border-l [&+&]:border-edge ${code === marketCode ? "bg-ink text-stone-0" : "hover:bg-stone-2"}`}>
                  {code}
                </button>
              ))}
            </div>
          ) : null}
          <div className="inline-flex rounded-control border border-edge bg-stone-0" role="group" aria-label="Show the page">
            {(["before", "after"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} className={`min-h-9 px-3 text-sm font-semibold [&+&]:border-l [&+&]:border-edge ${view === value ? "bg-ink text-stone-0" : "hover:bg-stone-2"}`}>
                {value === "before" ? "Before" : "After"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <figure className="m-0 grid border border-ink-3 bg-stone font-archivo" aria-label={`Preview of the page on ${BRAND.service}, ${view === "after" ? "with the offer" : "before the offer"}`}>
        <div className="flex items-center justify-between border-b border-cord bg-stone-0 px-4 py-3">
          <span className="text-2xl font-bold tracking-[-0.015em] [font-stretch:125%]">{BRAND.service}</span>
          <span className="text-xs text-ink-2">{market ? market.name : "No market yet"}</span>
        </div>
        {market === null || form.plan === "" ? (
          <p className="px-4 py-10 text-base text-ink-2">Choose a market and a plan: the page appears here as listeners would see it.</p>
        ) : view === "before" ? (
          <div className="grid gap-3 px-4 py-6">
            <p className="text-xs font-semibold text-ink-2">Plans and prices · {market.name}</p>
            <p className="text-4xl font-light leading-tight tracking-[-0.02em] [font-stretch:125%]">{plan?.name ?? form.plan}</p>
            <p className="text-2xl font-semibold">{listPrice ? `${sitePrice(listPrice, market.code)}` : "No list price"} <span className="text-base font-normal text-ink-2">a month, VAT included</span></p>
            <p className="text-sm text-ink-2">No offer for this plan today: the list price above is what a new subscriber pays.</p>
          </div>
        ) : (
          <div className="grid gap-4 px-4 py-6">
            <p className="text-5xl font-light leading-[1.04] tracking-[-0.03em] [font-stretch:125%] [overflow-wrap:anywhere]">{entry?.pageTitle.trim() || form.title || "The page's title"}</p>
            <p className="text-lg italic leading-snug text-ink">{entry?.pageText.trim() || "The page's text goes here."}</p>
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {listPrice && offerPrice ? <s className="text-xl text-ink-2">{sitePrice(listPrice, market.code)}</s> : null}
              <span className="text-9xl font-bold leading-none tracking-[-0.02em] [font-stretch:112%]">
                {offerPrice === null ? "price" : "money" in offerPrice ? sitePrice(offerPrice.money, market.code) : offerPrice.percent}
              </span>
            </p>
            <p className="text-sm text-ink-2">
              a month for {months || "?"} {months === 1 ? "month" : "months"}, then {listPrice ? sitePrice(listPrice, market.code) : "the list price"} a month · VAT included
            </p>
            <MonthsStrip months={months} />
            <span className="inline-flex min-h-12 w-fit items-center gap-2 rounded-control bg-indigo px-5 text-lg font-semibold text-stone-0" aria-hidden="true">
              {studentCta ? "Check I'm a student" : `Choose ${plan?.name ?? "the plan"}`}
              <Icon name="arrow-right" size={18} />
            </span>
            <p className="flex items-baseline gap-2 text-xs text-ink-2">
              <Icon name="info" size={14} className="translate-y-0.5" />
              {DISCLAIMER}
            </p>
            <p className="w-fit border border-saffron bg-stone-0 px-2.5 py-1 text-sm font-semibold text-saffron">
              {audienceWords(form, market.name, artist)}{starts ? ` · from ${starts}` : ""}
            </p>
            {entry?.pageTerms.trim() ? <p className="text-xs leading-relaxed text-ink-2">{entry.pageTerms.trim()}</p> : null}
          </div>
        )}
      </figure>
      <p className="text-xs text-ink-2">
        The page as listeners in {market?.name ?? "the market"} who can take the offer would read it. It goes live only after approval and activation;
        prices on the site are always the engine's.
      </p>
    </section>
  );
}

/** The months at the offer price, then the list price: saffron sheets, then indigo. */
function MonthsStrip({ months }: { readonly months: number }) {
  const shown = Math.min(Math.max(months, 0), 12);
  if (shown === 0) return null;
  const after = 3;
  return (
    <div className="flex h-5 items-stretch gap-0.5" aria-hidden="true">
      {Array.from({ length: shown }, (_, index) => <i key={`o${index}`} className="block w-6 bg-silk-saffron shadow-[inset_0_-2px_0_var(--color-saffron)]" />)}
      {Array.from({ length: after }, (_, index) => <i key={`l${index}`} className="block w-6 bg-silk-indigo shadow-[inset_0_2px_0_var(--color-indigo)]" />)}
    </div>
  );
}
