// The site's resolvers: every field of public.graphql. They read the engine's
// public methods, and the subscriber's methods for the listener of the site's
// session, and pass on no field the schema does not name: the engine's
// messages carry floors, the price list's top-ups and changes, a quote's
// breakdown, ids of changes, subscriptions and payments, and none of it
// reaches a public field (test/public-contract.test.ts plants such values and
// looks for them in every answer). Where a list price or an offer price goes
// is public by decision (§1.2): its breakdown is a field of the site's own.
//
// Who the listener is comes from the session alone: no argument names a
// subscriber, and the engine's binding writes the session's subscriber id
// into every subscriber call (engine.ts).
import { create } from "@bufbuild/protobuf";
import { type Refusal, RefusalCode } from "contracts/commerce/v1/common";
import { type Confirmation, type Payment, PaymentSchema, PaymentState, PaymentStateSchema } from "contracts/commerce/v1/subscriptions";
import { enumName, idOrNull, money, optionalMoney, orNull } from "../convert.ts";
import { breach, gatewayError } from "../errors.ts";
import type {
  AudioQuality, PaymentState as PublicPaymentState, PrepaidCodeState, PriceChangeKind, PriceChangeState, Resolvers,
} from "../generated/public.ts";
import { positiveId } from "../ids.ts";
import type { PublicRefusalCode, PublicRefusalModel } from "../models.ts";
import { listenerOf } from "../policy.ts";
import { DateScalar, DateTimeScalar, LocalDateTimeScalar, MarketCodeScalar, MoneyScalar, PlanCodeScalar } from "../scalars.ts";

const AUDIO = new Map<string, AudioQuality>([["standard", "STANDARD"], ["lossless", "LOSSLESS"]]);

/** A quote's id is the engine's and opaque; the gateway refuses only what cannot be one. */
const QUOTE_ID = /^[A-Za-z0-9_-]{1,100}$/;
/**
 * A prepaid pass's code as people type it: the engine reads it in upper case,
 * without spaces or dashes, and decides whether it is one. The gateway refuses
 * only what cannot be: anything but letters, digits, spaces and dashes.
 */
const PREPAID_CODE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9 -]{1,100}$/;

/**
 * What the site says for a refusal of the engine: its own code, and a
 * sentence of the gateway's, never the engine's. The engine writes for the
 * console: its sentences name listeners and offers by their numbers ("Subscriber
 * #5003"), groups and caps the site does not show. The site's sentence may use
 * the refusal's facts that the site shows anyway: an offer's audience, in the
 * words of its page. A refusal not listed reads NOT_AVAILABLE.
 */
type Said = { readonly code: PublicRefusalCode; readonly sentence: (facts: Readonly<Record<string, string>>) => string };

const said = (code: PublicRefusalCode, sentence: string | Said["sentence"]): Said =>
  ({ code, sentence: typeof sentence === "string" ? () => sentence : sentence });

/**
 * Why a listener may not take an offer or a plan, from the engine's facts:
 * the offer's audience as its page words it ("It is for: verified students in
 * Italy who have never had a paid plan."), a student verification missing, or
 * another market.
 */
function notEligible(facts: Readonly<Record<string, string>>): string {
  const audience = facts["audience"]?.trim();
  if (audience) return `It is for: ${audience.charAt(0).toLowerCase()}${audience.slice(1)}.`;
  if (facts["check"] === "student") return "It needs a student verification that is valid today: verify first.";
  if (facts["market"]) return "It is not sold in your market.";
  return "You cannot take it.";
}

/** Asking for a quote: an offer that is not on sale is over, as far as a visitor can tell. */
const QUOTE_REFUSALS = new Map<RefusalCode, Said>([
  [RefusalCode.QUOTE_EXPIRED, said("OFFER_ENDED", "This offer is no longer on sale.")],
  [RefusalCode.NOT_ELIGIBLE, said("NOT_ELIGIBLE", notEligible)],
]);

const VERIFICATION_REFUSALS = new Map<RefusalCode, Said>([
  [RefusalCode.NOT_ELIGIBLE, said("NOT_ELIGIBLE", "The student verification found no student record for you.")],
]);

const SUBSCRIPTION_REFUSALS = new Map<RefusalCode, Said>([
  [RefusalCode.QUOTE_EXPIRED, said("QUOTE_EXPIRED", "This quote has expired, or its offer is no longer on sale: ask for a new quote.")],
  [RefusalCode.NOT_ELIGIBLE, said("NOT_ELIGIBLE", notEligible)],
  [RefusalCode.ALREADY_SUBSCRIBED, said("ALREADY_SUBSCRIBED", "A paid subscription of yours is already running.")],
  [RefusalCode.NOT_COMBINABLE, said("NOT_COMBINABLE",
    "You already took an offer that does not combine with this one: offers of the same kind never stack (§10.3).")],
  [RefusalCode.CAP_REACHED, said("CAP_REACHED", "This offer has been taken as many times as it can be.")],
  [RefusalCode.PAYMENT_DECLINED, said("PAYMENT_DECLINED", "The payment provider declined the charge, so no subscription was made.")],
]);

/** Answering a price change: the engine's WRONG_STATE is another answer than the one given, or a window that ended. */
const ANSWER_REFUSALS = new Map<RefusalCode, Said>([
  [RefusalCode.WRONG_STATE, said("ANSWER_CLOSED", "This price change takes no other answer now: you answered it already, or the time to answer has ended.")],
]);

/** Buying a prepaid pass (§9): the engine takes its price from the pass on sale in the buyer's market. */
const PURCHASE_REFUSALS = new Map<RefusalCode, Said>([
  [RefusalCode.NOT_ELIGIBLE, said("NOT_ELIGIBLE", "This pass is not sold in your market.")],
]);

/** Activating a code: the engine's WRONG_STATE is a code whose payment is pending or declined, or that was used, or that expired. */
const ACTIVATION_REFUSALS = new Map<RefusalCode, Said>([
  [RefusalCode.NOT_ELIGIBLE, said("NOT_ELIGIBLE", "This code is for a pass of another market.")],
  [RefusalCode.ALREADY_SUBSCRIBED, said("ALREADY_SUBSCRIBED",
    "A paid subscription of yours is already running: a prepaid pass can be activated once it has ended.")],
  [RefusalCode.WRONG_STATE, said("CODE_NOT_USABLE",
    "This code cannot be activated: its payment has not gone through, it has been used, or its time to be activated has ended.")],
]);

const PREPAID_CODE_STATES: Readonly<Record<string, PrepaidCodeState>> = {
  pending: "PENDING", ready: "READY", activated: "ACTIVATED", expired: "EXPIRED", failed: "FAILED",
};

const PRICE_CHANGE_KINDS: Readonly<Record<string, PriceChangeKind>> = { consent: "CONSENT", notice: "NOTICE" };
const PRICE_CHANGE_STATES: Readonly<Record<string, PriceChangeState>> = {
  waiting: "WAITING", accepted: "ACCEPTED", declined: "DECLINED", lapsed: "LAPSED", new_price: "NEW_PRICE",
};

/** A value the engine sends in words, read through its table; an unknown one breaks the contract, never passes as another. */
function lookup<T>(table: Readonly<Record<string, T>>, key: string, what: string): T {
  const found = Object.hasOwn(table, key) ? table[key] : undefined;
  return found ?? breach(`${what} ${JSON.stringify(key)}`);
}

function refusal(table: ReadonlyMap<RefusalCode, Said>, otherwise: string, refused: Refusal): PublicRefusalModel {
  const known = table.get(refused.code);
  return known
    ? { $typeName: "gateway.PublicRefusal", code: known.code, reason: known.sentence(refused.facts) }
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
    prepaidPasses: async (_root, { market }, context) => (await context.engine.catalog.listPrepaidPasses({ market })).passes,
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
    // The price change is named by its id; the listener is the session's, so another listener's is not found.
    answerPriceChange: async (_root, { priceChangeId, accept }, context) => {
      const id = positiveId(priceChangeId);
      if (id === null) throw gatewayError("BAD_USER_INPUT", "priceChangeId is not the id of a price change");
      const answer = await context.engine.subscribers.answerPriceChange({ priceChangeId: id, accept });
      if (answer.outcome.case === "priceChange") return answer.outcome.value;
      if (answer.outcome.case === "refusal") return refusal(ANSWER_REFUSALS, "This answer cannot be given here right now.", answer.outcome.value);
      return breach("AnswerPriceChange answered with neither a price change nor a refusal");
    },
    // The site names the pass and never its price: the engine takes it from
    // the pass on sale in the listener's market (§4.5, §9).
    buyPrepaidPass: async (_root, { passId }, context) => {
      const id = positiveId(passId);
      if (id === null) throw gatewayError("BAD_USER_INPUT", "passId is not the id of a prepaid pass");
      const answer = await context.engine.subscribers.buyPrepaidPass({ passId: id });
      if (answer.outcome.case === "code") return answer.outcome.value;
      if (answer.outcome.case === "refusal") return refusal(PURCHASE_REFUSALS, "This pass cannot be bought here right now.", answer.outcome.value);
      return breach("BuyPrepaidPass answered with neither a code nor a refusal");
    },
    // Whoever holds the code may activate it: it can be a gift. The listener is the session's.
    activatePrepaidPass: async (_root, { code }, context) => {
      if (!PREPAID_CODE.test(code)) throw gatewayError("BAD_USER_INPUT", "code is not the code of a prepaid pass");
      const answer = await context.engine.subscribers.activatePrepaidPass({ code });
      if (answer.outcome.case === "subscription") return answer.outcome.value;
      if (answer.outcome.case === "refusal") return refusal(ACTIVATION_REFUSALS, "This code cannot be activated here right now.", answer.outcome.value);
      return breach("ActivatePrepaidPass answered with neither a subscription nor a refusal");
    },
  },

  Market: {
    code: (market) => market.code,
    name: (market) => market.name,
    currency: (market) => market.currency,
    timeZone: (market) => market.timeZone,
    vatBasisPoints: (market) => market.vatBp,
    artistsMinimum: (market) => money(market.artistsMinimum, `market ${market.code}'s artists' minimum`),
  },
  // Where a price goes: public by decision, the promise of §1.2. The floor, which the console reads beside it, is not.
  PriceBreakdown: {
    price: (breakdown) => money(breakdown.price, "breakdown price"),
    vat: (breakdown) => money(breakdown.vat, "breakdown VAT"),
    net: (breakdown) => money(breakdown.net, "breakdown net"),
    artists: (breakdown) => money(breakdown.artists, "breakdown artists"),
    topUp: (breakdown) => money(breakdown.topUp, "breakdown top-up"),
    paymentCosts: (breakdown) => money(breakdown.paymentCosts, "breakdown payment costs"),
    companyKeeps: (breakdown) => money(breakdown.encoreKeeps, "breakdown margin"),
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
    breakdown: (plan) => plan.breakdown ?? null,
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
    // The engine of stage 5 sends none; stage 6 adds it at the offer price.
    breakdown: (offer) => offer.breakdown ?? null,
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
    priceChanges: (account) => account.priceChanges,
    prepaidCodes: (account) => account.prepaidCodes,
  },
  PrepaidPass: {
    id: (pass) => pass.passId,
    market: (pass) => pass.market,
    title: (pass) => pass.title,
    plan: (pass) => pass.plan,
    months: (pass) => pass.months,
    price: (pass) => money(pass.price, `prepaid pass ${pass.passId}'s price`),
    codeValidMonths: (pass) => pass.codeValidMonths,
    text: (pass) => pass.text,
    terms: (pass) => pass.terms,
  },
  // Who activated a code is not shown: the engine names a listener there, and a code can be a gift.
  PrepaidCode: {
    code: (code) => code.code,
    passId: (code) => code.passId,
    title: (code) => code.title,
    plan: (code) => code.plan,
    market: (code) => code.market,
    months: (code) => code.months,
    price: (code) => money(code.price, "a prepaid code's price"),
    boughtAt: (code) => code.soldAt,
    validUntil: (code) => code.validUntil,
    state: (code) => lookup(PREPAID_CODE_STATES, code.state, "prepaid code state"),
    payment: (code) => code.payment ?? breach("a prepaid code came without its payment"),
    activatedOn: (code) => orNull(code.activatedOn),
  },
  PrepaidPurchase: {
    prepaidCode: (code) => code,
  },
  PrepaidPurchaseResult: {
    __resolveType: (result) => (result.$typeName === "gateway.PublicRefusal" ? "Refusal" : "PrepaidPurchase"),
  },
  PrepaidActivationResult: {
    __resolveType: (result) => (result.$typeName === "gateway.PublicRefusal" ? "Refusal" : "Subscription"),
  },
  // Every date here is the engine's, worked out on the listener's own billing days: the site writes them as they are.
  PriceChange: {
    id: (change) => change.priceChangeId,
    plan: (change) => change.plan,
    oldPrice: (change) => money(change.oldPrice, "a price change's old price"),
    newPrice: (change) => money(change.newPrice, "a price change's new price"),
    kind: (change) => lookup(PRICE_CHANGE_KINDS, change.kind, "price change kind"),
    sentAt: (change) => change.sentAt,
    windowEnds: (change) => change.windowEnds ?? breach("a price change has no window"),
    newSubscribersFrom: (change) => change.newSubscribersFrom ?? breach("a price change has no start for new subscribers"),
    state: (change) => lookup(PRICE_CHANGE_STATES, change.state, "price change state"),
    newPriceFrom: (change) => orNull(change.newPriceFrom),
    appliesFrom: (change) => orNull(change.appliesFrom),
    ifNoLeavesOn: (change) => orNull(change.ifNoLeavesOn),
    leavesOn: (change) => orNull(change.leavesOn),
    ifNoAnswer: (change) => change.ifNoAnswer,
    legalBasis: (change) => change.legalBasis,
  },
  PriceChangeResult: {
    __resolveType: (result) => (result.$typeName === "gateway.PublicRefusal" ? "Refusal" : "PriceChange"),
  },
  Subscription: {
    plan: (subscription) => subscription.plan,
    market: (subscription) => subscription.market,
    paid: (subscription) => subscription.paid,
    price: (subscription) => money(subscription.price, "the subscription's price"),
    startedOn: (subscription) => subscription.startedOn,
    // A prepaid pass is never charged: the engine keeps the day its months turn, which is no charge to show.
    billingDay: (subscription) => (subscription.billingDay === 0 || subscription.prepaidCode !== "" ? null : subscription.billingDay),
    offerTitle: (subscription) => orNull(subscription.offerTitle),
    offerMonths: (subscription) => subscription.offerMonths,
    offerMonthsLeft: (subscription) => subscription.offerMonthsLeft,
    fullPriceFrom: (subscription) => orNull(subscription.fullPriceFrom),
    fullPrice: (subscription) => optionalMoney(subscription.fullPrice),
    nextBillingOn: (subscription) => orNull(subscription.nextBillingOn),
    nextCharge: (subscription) => optionalMoney(subscription.nextCharge),
    endsOn: (subscription) => orNull(subscription.endsOn),
    prepaidCode: (subscription) => orNull(subscription.prepaidCode),
    prepaidPrice: (subscription) => optionalMoney(subscription.prepaidPrice),
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
