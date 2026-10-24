"use client";
// What happens before an existing subscriber pays more, in one market
// (business book §8): two questions that are never mixed (§8.1). What the
// law of the market requires, with its sources, is one block; what the music
// service chose to do, a setting of the market and never law (§8.6), is
// another, drawn apart: a dashed edge, its own heading, and the engine's own
// label saying it is a choice. The words are the engine's.
import { BRAND } from "design";
import { Icon } from "design/icon";
import { useId } from "react";
import { Callout, ErrorPanel, Loading } from "../../components/ui.tsx";
import { PriceChangePoliciesDocument, type PriceChangePoliciesQuery } from "../../graphql/generated.ts";
import { useGatewayQuery } from "../../lib/react/gateway.tsx";

export type Policy = NonNullable<PriceChangePoliciesQuery["markets"][number]["priceChangePolicy"]>;

/** The law's requirement, as one sentence. */
export const REQUIREMENT_WORDS: Readonly<Record<string, string>> = {
  CONSENT: "Consent: each existing subscriber has to say yes, and silence counts as no.",
  NOTICE: "Notice: each existing subscriber is told in advance, and may leave before the new price applies.",
};

/** The window, as the choice sets it. */
export function windowWords(policy: Policy): string {
  return policy.law.requirement === "CONSENT"
    ? `${policy.choice.windowDays} days to answer, counted from the request`
    : `${policy.choice.windowDays} days of notice before the new price applies`;
}

/** The two blocks, for a market whose rules are known. */
export function PolicyBlocks({ policy, marketName, headingLevel = 2 }: { readonly policy: Policy; readonly marketName: string; readonly headingLevel?: 2 | 3 }) {
  const id = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const Sub = headingLevel === 2 ? "h3" : "h4";
  return (
    <section className="grid content-start gap-3" aria-labelledby={`${id}-rules`}>
      <Heading id={`${id}-rules`} className="text-xl font-bold leading-snug">Before subscribers in {marketName} pay more</Heading>
      <p className="max-w-[60ch] text-sm text-ink-2">Two questions, kept apart (§8.1): what the law asks, and what {BRAND.service} chose to do.</p>
      <section className="grid gap-2.5 border border-ink bg-stone-0 px-4 py-3.5" aria-labelledby={`${id}-law`}>
        <Sub id={`${id}-law`} className="flex items-center gap-2 text-lg font-bold"><Icon name="scales" size={18} className="text-indigo" />What the law asks</Sub>
        <p className="font-semibold">{REQUIREMENT_WORDS[policy.law.requirement] ?? policy.law.requirement}</p>
        <p className="max-w-[65ch] text-sm leading-relaxed">{policy.law.basis}</p>
        {policy.law.sources.length ? (
          <div className="grid gap-1 border-t border-cord pt-2">
            <p className="text-xs font-bold">Sources</p>
            <ul className="m-0 grid list-none gap-1 p-0 text-xs text-ink-2">
              {policy.law.sources.map((source) => (
                <li key={source} className="flex items-baseline gap-1.5"><Icon name="scroll" size={13} className="translate-y-0.5 flex-none" />{source}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
      <section className="grid gap-2.5 border border-dashed border-edge bg-stone px-4 py-3.5" aria-labelledby={`${id}-choice`}>
        <Sub id={`${id}-choice`} className="flex items-center gap-2 text-lg font-bold"><Icon name="sliders-horizontal" size={18} className="text-indigo" />What {BRAND.service} chose</Sub>
        <p className="tag justify-self-start border-dashed">{policy.choice.label}</p>
        <dl className="m-0 grid gap-2">
          <div className="grid gap-0.5">
            <dt className="text-xs text-ink-2">The window</dt>
            <dd className="m-0 font-semibold">{windowWords(policy)}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-xs text-ink-2">{policy.law.requirement === "CONSENT" ? "Without a yes" : "For those who do not leave"}</dt>
            <dd className="m-0 max-w-[65ch] text-sm leading-relaxed">{policy.choice.words}</dd>
          </div>
        </dl>
        {policy.choice.alternatives.length ? (
          <p className="text-xs text-ink-2">Other choices this market could make: {policy.choice.alternatives.map((alternative) => `${alternative.charAt(0).toLowerCase()}${alternative.slice(1)}`).join("; ")}.</p>
        ) : null}
      </section>
    </section>
  );
}

/** A market's rules, read from the engine; a market without rules says so: the engine refuses a migration there. */
export function MarketPolicy({ market, headingLevel = 2 }: { readonly market: string; readonly headingLevel?: 2 | 3 }) {
  const policies = useGatewayQuery(PriceChangePoliciesDocument, {}, { staleTime: 5 * 60_000 });
  if (policies.isPending) return <Loading what="the market's rules" lines={6} />;
  if (policies.isError) return <ErrorPanel error={policies.error} retry={() => void policies.refetch()} />;
  const found = policies.data.markets.find((entry) => entry.code === market);
  if (found === undefined) return null;
  if (found.priceChangePolicy === null) {
    return <Callout icon="warning" tone="error">{found.name} has no rules yet for raising an existing subscriber's price (§8): the engine refuses a migration there until it has them.</Callout>;
  }
  return <PolicyBlocks policy={found.priceChangePolicy} marketName={found.name} headingLevel={headingLevel} />;
}
