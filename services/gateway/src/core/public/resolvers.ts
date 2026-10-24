// The site's resolvers: every field of public.graphql. They read the engine's
// public methods, and the subscriber's methods for the listener of the site's
// session, and pass on no field the schema does not name: the engine's
// messages carry floors, breakdowns, ids of changes and of subscriptions, and
// none of it reaches a public field (test/public-contract.test.ts plants such
// values and looks for them in every answer).
//
// Who the listener is comes from the session alone: no argument names a
// subscriber, and the engine's binding writes the session's subscriber id
// into every subscriber call (engine.ts).
import { create } from "@bufbuild/protobuf";
import { type Refusal, RefusalCode } from "contracts/commerce/v1/common";
import { type Confirmation, type Payment, PaymentSchema, PaymentState, PaymentStateSchema } from "contracts/commerce/v1/subscriptions";
import { enumName, idOrNull, money, optionalMoney, orNull } from "../convert.ts";
import { breach, gatewayError } from "../errors.ts";
import type { AudioQuality, PaymentState as PublicPaymentState, Resolvers } from "../generated/public.ts";
import { positiveId } from "../ids.ts";
import type { PublicRefusalCode, PublicRefusalModel } from "../models.ts";
import { listenerOf } from "../policy.ts";
import { DateScalar, DateTimeScalar, LocalDateTimeScalar, MarketCodeScalar, MoneyScalar, PlanCodeScalar } from "../scalars.ts";

const AUDIO = new Map<string, AudioQuality>([["standard", "STANDARD"], ["lossless", "LOSSLESS"]]);

/** A quote's id is the engine's and opaque; the gateway refuses only what cannot be one. */
const QUOTE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * What the site says for a refusal of the engine: its own code, and the
 * engine's sentence (null) or one of its own. The engine's sentence travels
 * only where it names nothing but what the site already shows; where it names
 * what the console sets and the site does not show (an offer's
 * non-combinability group, its cap on redemptions), the gateway says it in its
 * own words. A refusal not listed reads NOT_AVAILABLE and a fixed sentence,
 * so nothing internal travels in its words.
 */
type Said = { readonly code: PublicRefusalCode; readonly sentence: string | null };

/** Asking for a quote: an offer that is not on sale is over, as far as a visitor can tell. */
const QUOTE_REFUSALS = new Map<RefusalCode, Said>([
  [RefusalCode.QUOTE_EXPIRED, { code: "OFFER_ENDED", sentence: null }],
  [RefusalCode.NOT_ELIGIBLE, { code: "NOT_ELIGIBLE", sentence: null }],
]);

const VERIFICATION_REFUSALS = new Map<RefusalCode, Said>([
  [RefusalCode.NOT_ELIGIBLE, { code: "NOT_ELIGIBLE", sentence: null }],
]);

const SUBSCRIPTION_REFUSALS = new Map<RefusalCode, Said>([
  [RefusalCode.QUOTE_EXPIRED, { code: "QUOTE_EXPIRED", sentence: null }],
  [RefusalCode.NOT_ELIGIBLE, { code: "NOT_ELIGIBLE", sentence: null }],
  [RefusalCode.ALREADY_SUBSCRIBED, { code: "ALREADY_SUBSCRIBED", sentence: null }],
  [RefusalCode.NOT_COMBINABLE, {
    code: "NOT_COMBINABLE",
    sentence: "You already took an offer that does not combine with this one: offers of the same kind never stack (§10.3).",
  }],
  [RefusalCode.CAP_REACHED, { code: "CAP_REACHED", sentence: "This offer has been taken as many times as it can be." }],
  [RefusalCode.PAYMENT_DECLINED, { code: "PAYMENT_DECLINED", sentence: "The payment provider declined the charge, so no subscription was made." }],
]);

function refusal(table: ReadonlyMap<RefusalCode, Said>, otherwise: string, refused: Refusal): PublicRefusalModel {
  const said = table.get(refused.code);
  return said
    ? { $typeName: "gateway.PublicRefusal", code: said.code, reason: said.sentence ?? refused.reason }
    : { $typeName: "gateway.PublicRefusal", code: "NOT_AVAILABLE", reason: otherwise };
}

/**
 * The first month's payment of a confirmation. An engine that charges after
 * the confirmation, through its outbox (stage 6), sends the payment, PENDING;
 * one that charged at the confirmation sent only the receipt, which is a
 * payment that succeeded then. The site reads one shape from both.
 */
function paymentOf(confirmation: Confirmation): Payment {
  if (confirmation.payment) return confirmation.payment;
  const receipt = confirmation.receipt ?? breach("the confirmation has neither a payment nor a receipt");
  return create(PaymentSchema, {
    state: PaymentState.SUCCEEDED,
    ...(receipt.amount ? { amount: receipt.amount } : {}),
    provider: receipt.provider,
    requestedAt: receipt.issuedAt,
    settledAt: receipt.issuedAt,
    receipt,
  });
}

export const publicResolvers: Resolvers = {
  Money: MoneyScalar,
  LocalDateTime: LocalDateTimeScalar,
  DateTime: DateTimeScalar,
  Date: DateScalar,
  MarketCode: MarketCodeScalar,
  PlanCode: PlanCodeScalar,

  Query: {
    markets: async (_root, _args, context) => (await context.engine.catalog.listMarkets({})).markets,
    plans: async (_root, { market }, context) => (await context.engine.catalog.listPlans({ market, at: "" })).plans,
    prices: async (_root, { market, plan }, context) =>
      (await context.engine.catalog.getPriceList({ market, plan: plan ?? "" })).entries,
    offers: async (_root, { market }, context) => (await context.engine.catalog.listOffers({ market, at: "" })).offers,
    // Without the site's sessions (in production) nobody can be chosen, so the entrance offers nobody.
    demoListeners: async (_root, _args, context) =>
      context.sessions === null ? [] : (await context.engine.subscribers.listDemoListeners({})).listeners,
    me: (_root, _args, context) => context.sessions?.current() ?? null,
  },

  Mutation: {
    // The site never sends a price: it names the plan, the market and the
    // offer, and the engine quotes (§4.5). Signed in, the quote is the
    // session's listener's, and the engine checks their eligibility now and
    // again when they subscribe; a visitor not signed in is subscriber 0.
    requestQuote: async (_root, { plan, market, offerId }, context) => {
      const offer = offerId === null || offerId === undefined ? "0" : positiveId(offerId);
      if (offer === null) throw gatewayError("BAD_USER_INPUT", "offerId is not an offer id");
      const subscriberId = listenerOf(context)?.subscriberId ?? "0";
      const answer = await context.engine.quotes.getQuote({ plan, market, offerId: offer, subscriberId });
      if (answer.outcome.case === "quote") return answer.outcome.value;
      if (answer.outcome.case === "refusal") return refusal(QUOTE_REFUSALS, "This plan cannot be quoted here right now.", answer.outcome.value);
      return breach("GetQuote answered with neither a quote nor a refusal");
    },
    // DEMONSTRATION MODE: the browser picks one of the demo's listeners, as
    // the engine lists them, and never anybody else; from then on the
    // session, not the browser, says who the site acts for.
    signInAsListener: async (_root, { listenerId }, context) => {
      const sessions = context.sessions;
      if (sessions === null) {
        throw gatewayError("FORBIDDEN", "Choosing one of the demo's listeners is a demonstration, and this gateway runs in production, where a real site signs its listeners in.");
      }
      const id = positiveId(listenerId);
      if (id === null) throw gatewayError("BAD_USER_INPUT", "listenerId is not the id of one of the demo's listeners");
      const { listeners } = await context.engine.subscribers.listDemoListeners({});
      const chosen = listeners.find((listener) => listener.subscriberId === id);
      if (chosen === undefined) throw gatewayError("NOT_FOUND", `No demo listener ${id}: choose one of demoListeners.`);
      return sessions.start({ subscriberId: chosen.subscriberId, market: chosen.market, title: chosen.title });
    },
    signOutListener: (_root, _args, context) => context.sessions?.end() ?? false,
    verifyStudent: async (_root, _args, context) => {
      const answer = await context.engine.subscribers.verifyStudent({});
      if (answer.outcome.case === "verification") return answer.outcome.value;
      if (answer.outcome.case === "refusal") return refusal(VERIFICATION_REFUSALS, "The student verification cannot be done here right now.", answer.outcome.value);
      return breach("VerifyStudent answered with neither a verification nor a refusal");
    },
    // The quote's id is all the site sends: the price is the quote's, saved by
    // the engine when it quoted (§4.5), and the listener is the session's.
    confirmSubscription: async (_root, { quoteId }, context) => {
      if (!QUOTE_ID.test(quoteId)) throw gatewayError("BAD_USER_INPUT", "quoteId is the id requestQuote returned");
      const answer = await context.engine.subscribers.confirmQuote({ quoteId });
      if (answer.outcome.case === "confirmation") return answer.outcome.value;
      if (answer.outcome.case === "refusal") return refusal(SUBSCRIPTION_REFUSALS, "This subscription cannot be made here right now.", answer.outcome.value);
      return breach("ConfirmQuote answered with neither a confirmation nor a refusal");
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
    audio: (entitlements) => AUDIO.get(entitlements.audio) ?? breach(`audio quality ${JSON.stringify(entitlements.audio)}`),
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
  DemoListener: {
    id: (listener) => listener.subscriberId,
    market: (listener) => listener.market,
    title: (listener) => listener.title,
    label: (listener) => listener.label,
    plan: (listener) => orNull(listener.plan),
    studentVerified: (listener) => listener.studentVerified,
  },
  Me: {
    id: (me) => me.viewer.subscriberId,
    market: (me) => me.viewer.market,
    title: (me) => me.viewer.title,
    csrfToken: (me) => me.csrfToken,
    expiresAt: (me) => me.expiresAt.toISOString(),
    // The session's listener, which the engine's binding names: the parent says nothing the session does not.
    account: async (_me, _args, context) =>
      (await context.engine.subscribers.getAccount({})).account ?? breach("GetAccount answered without an account"),
  },
  Account: {
    market: (account) => account.market,
    subscription: (account) => account.subscription ?? breach("the account has no subscription"),
    payment: (account) => account.payment ?? null,
    studentVerification: (account) => account.studentVerification ?? null,
  },
  Subscription: {
    plan: (subscription) => subscription.plan,
    market: (subscription) => subscription.market,
    paid: (subscription) => subscription.paid,
    price: (subscription) => money(subscription.price, "the subscription's price"),
    startedOn: (subscription) => subscription.startedOn,
    billingDay: (subscription) => (subscription.billingDay === 0 ? null : subscription.billingDay),
    offerTitle: (subscription) => orNull(subscription.offerTitle),
    offerMonths: (subscription) => subscription.offerMonths,
    offerMonthsLeft: (subscription) => subscription.offerMonthsLeft,
    fullPriceFrom: (subscription) => orNull(subscription.fullPriceFrom),
    fullPrice: (subscription) => optionalMoney(subscription.fullPrice),
    nextBillingOn: (subscription) => orNull(subscription.nextBillingOn),
    nextCharge: (subscription) => optionalMoney(subscription.nextCharge),
  },
  StudentVerification: {
    verifiedOn: (verification) => verification.verifiedOn,
    validUntil: (verification) => verification.validUntil,
    provider: (verification) => verification.provider,
    valid: (verification) => verification.valid,
  },
  Receipt: {
    id: (receipt) => receipt.receiptId,
    amount: (receipt) => money(receipt.amount, "the receipt's amount"),
    issuedAt: (receipt) => receipt.issuedAt,
    provider: (receipt) => receipt.provider,
    providerReference: (receipt) => receipt.providerReference,
    demonstration: (receipt) => receipt.demonstration,
    note: (receipt) => receipt.note,
  },
  Payment: {
    state: (payment) => enumName<PublicPaymentState>(PaymentStateSchema, payment.state, "payment state"),
    amount: (payment) => money(payment.amount, "the payment's amount"),
    provider: (payment) => payment.provider,
    requestedAt: (payment) => payment.requestedAt,
    settledAt: (payment) => orNull(payment.settledAt),
    receipt: (payment) => payment.receipt ?? null,
  },
  Confirmation: {
    subscription: (confirmation) => confirmation.subscription ?? breach("the confirmation has no subscription"),
    payment: (confirmation) => paymentOf(confirmation),
  },
  Refusal: {
    code: (refused) => refused.code,
    reason: (refused) => refused.reason,
  },
  QuoteResult: {
    __resolveType: (result) => (result.$typeName === "gateway.PublicRefusal" ? "Refusal" : "Quote"),
  },
  VerificationResult: {
    __resolveType: (result) => (result.$typeName === "gateway.PublicRefusal" ? "Refusal" : "StudentVerification"),
  },
  SubscriptionResult: {
    __resolveType: (result) => (result.$typeName === "gateway.PublicRefusal" ? "Refusal" : "Confirmation"),
  },
};
