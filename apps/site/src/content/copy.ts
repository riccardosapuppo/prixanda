// The site's interface text, in one place. English by design (business book
// §15: no translations; prices are still written the way each country writes
// them). The service's name is BRAND.service, so a new name changes one
// string. No figure lives here: prices, shares, months and dates come from the
// API's answers.
import { BRAND, DISCLAIMER, SIMULATED_LABEL } from "design";

const service = BRAND.service;

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
  nav: { label: service, plans: "Plans", account: "Account", menu: "Menu", skip: "Skip to the content" },
  plans: {
    title: "Plans and prices",
    marketLabel: "Prices for",
    vatNote: "VAT included",
    perMonth: "a month",
    free: "Free",
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
    monthsAt: (months: number) => `a month for ${months} ${months === 1 ? "month" : "months"}, VAT included`,
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
  quote: {
    title: "Your price, from the engine",
    holds: (time: string) => `This quote holds until ${time}.`,
    then: "then",
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
    UNAUTHENTICATED: "Your demo session has ended. Enter again as a demo listener.",
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
