// The site's interface text, in one place. English by design (business book
// §15: no translations; prices are still written the way each country writes
// them). The service's name is BRAND.service, so a new name changes one
// string. No figure lives here: prices, shares, months and dates come from the
// API's answers and are only put into these sentences.
import { BRAND, DISCLAIMER, SIMULATED_LABEL } from "design";

const service = BRAND.service;
const months = (count: number) => `${count} ${count === 1 ? "month" : "months"}`;

export const copy = {
  service,
  /** The pair at the top of every page, and the footer's sentence (§13.3). */
  frame: {
    project: "Independent personal project",
    simulated: SIMULATED_LABEL,
    footer: `${service} is a fictional service in a personal project. No real payments, no real accounts; the arithmetic on this site is real.`,
  },
  /** Next to the step where a visitor could take the demonstration for a purchase, and only there. */
  disclaimer: DISCLAIMER,
  nav: { label: service, plans: "Plans", account: "Account", skip: "Skip to the content" },
  plans: {
    title: "Plans and prices",
    marketLabel: "Prices for",
    vatNote: "VAT included",
    perMonth: "a month",
    onNow: "On now",
    noOffers: "No campaign is running in this market today.",
    lines: {
      free: "The whole catalogue. Six skips an hour, standard quality.",
      individual: "Lossless, offline, skip as much as you like.",
      duo: "Two accounts, one bill.",
      family: "Up to five accounts, one bill.",
      student: "Individual at a student price. Needs a student check, valid 12 months.",
    } as Readonly<Record<string, string>>,
  },
  campaign: {
    vatIncluded: "VAT included",
    usualPrice: "Usual price",
    monthsAt: (count: number) => `a month for ${months(count)}, VAT included`,
    month: (n: number) => `Month ${n}`,
    then: (planName: string) => `Then the ${planName} price in force`,
    takeBy: (day: string) => `Take it by ${day}.`,
    checkStudent: "Check I'm a student",
    studentCheckNote: "You check your student status once, and the check lasts 12 months.",
    take: (planName: string) => `Choose ${planName}`,
    studentsIn: (marketName: string) => `Students in ${marketName}`,
    planIn: (planName: string, marketName: string) => `${planName} in ${marketName}`,
    gone: {
      title: "This campaign isn't on sale",
      body: "It isn't on sale in this market now: it has ended, or it hasn't started yet. The plans and their prices are still there.",
      action: "See the plans",
    },
    missing: {
      title: "Which campaign?",
      body: "This address names no campaign. The campaigns on sale are listed with the plans.",
      action: "See the plans",
    },
  },
  /** The promise to the artists, told once on a campaign page, from the engine's breakdown of the offer price. */
  promise: {
    label: "The artists' share of this offer",
    topUp: (price: string, topUp: string, artists: string) =>
      `Your ${price} is below what the artists' minimum needs, so ${service} adds ${topUp} a month and they still get ${artists}.`,
    covered: (price: string, artists: string) => `Of your ${price}, ${artists} goes to the artists you play. Every month.`,
    fromYou: (price: string) => `from your ${price}`,
    addedBy: `added by ${service}`,
    total: "to the artists you play, every month",
    minimum: (minimum: string) => `never less than ${minimum}`,
  },
  /** DEMONSTRATION MODE: the entrance picks one of the demo's invented listeners. Not a sign-in. */
  entrance: {
    title: "Enter as a demo listener",
    lede: `Pick one of ${service}'s invented listeners. Their data is simulated, nobody types anything personal, and it isn't a sign-in.`,
    legend: "Demo listeners",
    enter: "Enter as this listener",
    switch: "Switch listener",
    inOtherMarket: (marketName: string) => `In ${marketName}: this campaign is not sold there.`,
  },
  check: {
    title: "Student check",
    note: "The provider is simulated: it knows the demo's listeners, and nobody types personal data. A check lasts 12 months.",
    action: "Check with the provider",
    verified: (until: string) => `Verified as a student by the simulated provider, valid until ${until}.`,
    refused: "Not verified as a student",
  },
  checkout: {
    title: "Confirm your demo subscription",
    confirm: "Confirm demo subscription",
    note: "Nothing is charged and no contract is made: the payment step is simulated. The price, the months at that price and what you pay after them are the engine's, worked out as they would be for real.",
    perMonthFor: (price: string, count: number) => `${price} a month for ${months(count)}`,
    then: (price: string, planName: string) => `then ${price} a month, the ${planName} price in force at that time`,
    atList: (price: string) => `${price} a month`,
    vat: "VAT included",
    holds: (time: string) => `This price holds until ${time}.`,
    askAgain: "Ask for the price again",
    back: "Back",
    asking: "Asking the engine for your price",
    subscribing: "Subscribing",
  },
  refusal: {
    notForYou: "This offer isn't for this listener",
    whoFor: (audience: string) => `It is for: ${audience.charAt(0).toLowerCase()}${audience.slice(1)}.`,
    stillPlan: (planName: string, price: string) => `${planName} is still there at ${price} a month.`,
    seePlans: "See the plans",
    seeAccount: "See the account",
    expired: "This price has expired",
    other: "This can't be done now",
  },
  account: {
    title: "Account",
    demo: "Demo listener: an invented person with simulated data.",
    nobody: "Nobody has entered on this browser yet.",
    plan: "Plan",
    price: "Price",
    offer: "Offer",
    after: "After the offer",
    nextBilling: "Next billing date",
    studentCheck: "Student check",
    perMonth: (price: string) => `${price} a month`,
    planIn: (planName: string, marketName: string) => `${planName}, ${marketName}`,
    offerLeft: (title: string, left: number, total: number) => `${title}: ${left} of ${months(total)} left at this price`,
    fullFrom: (price: string, day: string) => `${price} a month from ${day}`,
    nextCharge: (day: string, price: string) => `${day}, ${price}`,
    noCheck: "Not checked",
    checkValid: (until: string) => `Valid until ${until}, simulated provider`,
    checkExpired: (lastDay: string) => `Expired: it was valid until ${lastDay}`,
    free: "On Free: the whole catalogue, six skips an hour, standard quality.",
    seePlans: "See the plans",
    payment: {
      title: "First month's payment",
      pending: "Waiting for the payment provider. It is simulated, and answers within seconds.",
      succeeded: "Paid. The simulated provider took the first month.",
      failed: "The payment provider declined the first month. The paid subscription ends today, and the account is on Free from tomorrow.",
      slow: "The payment provider hasn't answered yet. The subscription is running meanwhile; check again in a moment.",
      checkAgain: "Check again",
    },
    receipt: {
      title: "Demo receipt",
      noMoney: "No money moved.",
      number: "Receipt",
      amount: "Amount",
      issued: "Issued",
      reference: "Provider's reference",
    },
  },
  states: {
    loading: "Loading",
    retry: "Try again",
    reference: (requestId: string) => `Reference ${requestId}`,
  },
  errors: {
    UNREACHABLE: `We can't reach ${service} right now. Check your connection, then try again.`,
    ENGINE_UNAVAILABLE: "Prices are not available for a moment. Try again in a few seconds.",
    RATE_LIMITED: "Too many requests from this browser for now. Wait a little, then try again.",
    NOT_FOUND: "This is no longer here.",
    BAD_USER_INPUT: "That request was not understood. Reload the page and try again.",
    UNAUTHENTICATED: "The demo session has ended. Enter again as a demo listener.",
    FORBIDDEN: "This page can't be used from here.",
    INTERNAL: "Something went wrong on our side. Try again in a moment.",
  },
  notFound: {
    title: "Nothing here",
    body: `This address doesn't lead to a page of ${service}.`,
    action: "See the plans",
  },
} as const;

export type ErrorCopyKey = keyof typeof copy.errors;
