// The site's resolvers: every field of public.graphql. They read the engine's
// public methods only, act for nobody, and pass on no field the schema does
// not name: the engine's messages carry floors, breakdowns and ids of
// changes, and none of it reaches a public field (test/public-contract.test.ts
// plants such values and looks for them in every answer).
import { RefusalCode } from "contracts/commerce/v1/common";
import { idOrNull, money, optionalMoney, orNull } from "../convert.ts";
import { breach, gatewayError } from "../errors.ts";
import type { AudioQuality, QuoteRefusalCode, Resolvers } from "../generated/public.ts";
import { positiveId } from "../ids.ts";
import type { PublicQuoteRefusalModel } from "../models.ts";
import { DateTimeScalar, LocalDateTimeScalar, MarketCodeScalar, MoneyScalar, PlanCodeScalar } from "../scalars.ts";

const AUDIO: Readonly<Record<string, AudioQuality>> = { standard: "STANDARD", lossless: "LOSSLESS" };

/**
 * What the site may say about a refused quote. The engine's sentence is kept
 * for the two refusals written for a visitor; any other refusal reads the
 * same fixed sentence, so nothing internal travels in its words.
 */
function quoteRefusal(code: RefusalCode, reason: string): PublicQuoteRefusalModel {
  const public_: Partial<Record<RefusalCode, QuoteRefusalCode>> = {
    [RefusalCode.QUOTE_EXPIRED]: "OFFER_ENDED",
    [RefusalCode.NOT_ELIGIBLE]: "NOT_ELIGIBLE",
  };
  const mapped = public_[code];
  return mapped
    ? { $typeName: "gateway.QuoteRefusal", code: mapped, reason }
    : { $typeName: "gateway.QuoteRefusal", code: "NOT_AVAILABLE", reason: "This plan cannot be quoted here right now." };
}

export const publicResolvers: Resolvers = {
  Money: MoneyScalar,
  LocalDateTime: LocalDateTimeScalar,
  DateTime: DateTimeScalar,
  MarketCode: MarketCodeScalar,
  PlanCode: PlanCodeScalar,

  Query: {
    markets: async (_root, _args, context) => (await context.engine.catalog.listMarkets({})).markets,
    plans: async (_root, { market }, context) => (await context.engine.catalog.listPlans({ market, at: "" })).plans,
    prices: async (_root, { market, plan }, context) =>
      (await context.engine.catalog.getPriceList({ market, plan: plan ?? "" })).entries,
    offers: async (_root, { market }, context) => (await context.engine.catalog.listOffers({ market, at: "" })).offers,
  },

  Mutation: {
    // The site never sends a price: it names the plan, the market and the
    // offer, and the engine quotes (§4.5). A visitor not signed in yet is
    // subscriber 0; eligibility is checked again when they subscribe.
    requestQuote: async (_root, { plan, market, offerId }, context) => {
      const offer = offerId === null || offerId === undefined ? "0" : positiveId(offerId);
      if (offer === null) throw gatewayError("BAD_USER_INPUT", "offerId is not an offer id");
      const answer = await context.engine.quotes.getQuote({ plan, market, offerId: offer, subscriberId: "0" });
      if (answer.outcome.case === "quote") return answer.outcome.value;
      if (answer.outcome.case === "refusal") return quoteRefusal(answer.outcome.value.code, answer.outcome.value.reason);
      return breach("GetQuote answered with neither a quote nor a refusal");
    },
  },

  Market: {
    code: (market) => market.code,
    name: (market) => market.name,
    currency: (market) => market.currency,
    timeZone: (market) => market.timeZone,
  },
  Entitlements: {
    skipsPerHour: (entitlements) => (entitlements.skipsPerHour === 0 ? null : entitlements.skipsPerHour),
    audio: (entitlements) => AUDIO[entitlements.audio] ?? breach(`audio quality ${JSON.stringify(entitlements.audio)}`),
    offline: (entitlements) => entitlements.offline,
    seats: (entitlements) => entitlements.seats,
    needsStudentCheck: (entitlements) => entitlements.needsStudentCheck,
  },
  Plan: {
    code: (plan) => plan.id,
    name: (plan) => plan.name,
    paid: (plan) => plan.paid,
    entitlements: (plan) => plan.entitlements ?? breach(`plan ${plan.id} has no entitlements`),
    listPrice: (plan) => optionalMoney(plan.listPrice),
  },
  ListPrice: {
    plan: (entry) => entry.plan,
    market: (entry) => entry.market,
    amount: (entry) => money(entry.amount, `price ${entry.id}`),
    validFrom: (entry) => entry.validFromLocal,
    validUntil: (entry) => orNull(entry.validUntilLocal),
  },
  MarketTime: {
    local: (time) => time.local,
    utc: (time) => time.utc,
  },
  Offer: {
    id: (offer) => offer.offerId,
    market: (offer) => offer.market,
    plan: (offer) => offer.plan,
    title: (offer) => offer.title,
    text: (offer) => offer.text,
    terms: (offer) => offer.terms,
    price: (offer) => money(offer.price, `offer ${offer.offerId}`),
    listPrice: (offer) => money(offer.listPrice, `offer ${offer.offerId}'s list price`),
    monthsAtOfferPrice: (offer) => offer.monthsAtOfferPrice,
    takeableUntil: (offer) => offer.takeableUntil ?? null,
    audience: (offer) => offer.audience,
    needsStudentCheck: (offer) => offer.needsStudentCheck,
  },
  Quote: {
    id: (quote) => quote.quoteId,
    plan: (quote) => quote.plan,
    market: (quote) => quote.market,
    price: (quote) => money(quote.price, `quote ${quote.quoteId}`),
    listPrice: (quote) => money(quote.listPrice, `quote ${quote.quoteId}'s list price`),
    monthsAtPrice: (quote) => quote.monthsAtPrice,
    thenPrice: (quote) => money(quote.thenPrice, `quote ${quote.quoteId}'s price after the offer`),
    expiresAt: (quote) => quote.expiresAt,
    offerId: (quote) => idOrNull(quote.offerId),
  },
  QuoteRefusal: {
    code: (refusal) => refusal.code,
    reason: (refusal) => refusal.reason,
  },
  QuoteResult: {
    __resolveType: (result) => (result.$typeName === "gateway.QuoteRefusal" ? "QuoteRefusal" : "Quote"),
  },
};
