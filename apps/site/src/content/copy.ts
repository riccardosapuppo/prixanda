// The site's interface text, in one place. English by design (business book
// §15: no translations; prices are still written the way each country writes
// them). The service's name is BRAND.service, so a new name changes one
// string. No figure lives here: prices, shares, months and dates come from the
// API's answers and are only put into these sentences.
import { BRAND, DISCLAIMER, SIMULATED_LABEL } from "design";

const service = BRAND.service;
const months = (count: number) => `${count} ${count === 1 ? "month" : "months"}`;
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"] as const;
/** A small count in words, the way a sentence says it: two accounts, six skips. */
const inWords = (count: number) => WORDS[count] ?? String(count);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What a plan includes, as the API says it. */
type Includes = { readonly seats: number; readonly skipsPerHour: number | null; readonly audio: string; readonly offline: boolean };

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
  nav: { label: service, plans: "Plans", releases: "New releases", sessions: "Listening sessions", account: "Account", menu: "Menu", skip: "Skip to the content" },
  home: {
    title: { before: `${service} streams records from `, strong: "small labels", after: " in Italy, France, Germany and the UK." },
    sessionTitle: (label: string) => `${label} session`,
    listen: "Listen to the session",
    coverNote: (technique: string, label: string) => `${technique}, from the ${label} house style. Generated from the record's seed.`,
  },
  promise: {
    label: "The promise to the artists",
    title: { before: "At least ", after: " of every paid plan goes to the artists. Every month." },
    lede: (minimum: string) => `If a discount pushes the artists' share below ${minimum}, we pay the difference ourselves.`,
    small: (minimum: string) => `The artists' share is a fixed part of the price without VAT, never less than ${minimum}.`,
    caption: (market: string) => `What one month of each paid plan gives the artists in ${market}.`,
    neverLess: (minimum: string) => `Never less than ${minimum}`,
    topUp: (plan: string, topUp: string, minimum: string) => `${plan}: includes ${topUp} that ${service} adds to reach the ${minimum} minimum.`,
  },
  plans: {
    title: "Plans",
    marketLabel: "Prices for",
    vatNote: "VAT included",
    perMonth: "a month",
    toArtists: (amount: string) => `${amount} to the artists`,
    whereGoes: { before: "Where your ", after: " goes" },
    rows: {
      artists: "To the artists you play",
      keeps: `What ${service} keeps`,
      payment: "Card and payment costs",
      vat: (rate: string) => `VAT (${rate}), to the tax office`,
    },
    topUpNote: (topUp: string, minimum: string) => `Includes ${topUp} that ${service} adds to reach the ${minimum} minimum.`,
    cordTag: (minimum: string) => `never less than ${minimum}`,
    legend: "Plan",
    choose: (plan: string) => `Choose ${plan}`,
    monthVat: "a month, VAT included",
    freeLine: "Every demo listener starts on Free.",
    freeAction: "Enter as a demo listener",
    seeAccount: "See the account",
    gets: {
      title: "What you get", seats: "Accounts", skips: "Skips", sound: "Sound", offline: "Offline", unlimited: "Unlimited",
      perHour: (n: number) => `${n} an hour`, lossless: "Lossless", standard: "Standard", yes: "Yes", no: "No",
    },
    onNow: (title: string, price: string, months: number) => `On now: ${title}, ${price} a month for ${months} ${months === 1 ? "month" : "months"}`,
    noOffers: "No campaign is running in this market today.",
    /** A plan's line under its name; the counts in it are the plan's own, from the API. */
    line: (code: string, includes: Includes): string => {
      const sound = includes.audio === "LOSSLESS" ? "lossless" : "standard";
      switch (code) {
        case "free":
          return includes.skipsPerHour === null
            ? `The whole catalogue, ${sound} quality.`
            : `The whole catalogue. ${capital(inWords(includes.skipsPerHour))} skips an hour, ${sound} quality.`;
        case "individual":
          return `${capital(sound)}, ${includes.offline ? "offline, " : ""}${includes.skipsPerHour === null ? "skip as much as you like" : `${inWords(includes.skipsPerHour)} skips an hour`}.`;
        case "duo":
          return `${capital(inWords(includes.seats))} accounts, one bill.`;
        case "family":
          return `Up to ${inWords(includes.seats)} accounts, one bill.`;
        case "student":
          return "Individual at a student price. Needs a student check, valid 12 months.";
        default:
          return "";
      }
    },
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
  campaignPromise: {
    label: "The artists' share of this offer",
    topUp: (price: string, topUp: string, artists: string) =>
      `Your ${price} is below what the artists' minimum needs, so ${service} adds ${topUp} a month and they still get ${artists}.`,
    covered: (price: string, artists: string) => `Of your ${price}, ${artists} goes to the artists you play. Every month.`,
    fromYou: (price: string) => `from your ${price}`,
    addedBy: `added by ${service}`,
    total: "to the artists you play, every month",
    minimum: (minimum: string) => `never less than ${minimum}`,
  },
  catalogue: {
    releases: "New releases",
    labelFacts: (market: string, records: number, technique: string) => `${market}, ${records} ${records === 1 ? "record" : "records"}, ${technique} covers`,
    tracks: (tracks: number, time: string) => `${tracks} tracks, ${time}`,
    sessions: "Listening sessions",
    sessionFacts: (records: number, tracks: number) => `${records} ${records === 1 ? "record" : "records"}, ${tracks} tracks`,
    listen: "Listen",
    listenTo: (label: string) => ` to the ${label} session`,
  },
  session: {
    back: "All listening sessions",
    title: (label: string) => `${label} session`,
    facts: (market: string, records: number, tracks: number, time: string, technique: string) =>
      `${market}, ${records} ${records === 1 ? "record" : "records"}, ${tracks} tracks, ${time}. Covers printed as ${technique}s, generated.`,
    player: "Player",
    position: "Position in the session",
    now: (track: number, tracks: number) => `Track ${track} of ${tracks}.`,
    play: "Play",
    playOn: "Play on",
    pause: "Pause",
    previous: "Previous record",
    next: "Next record",
    simulated: "Simulated: no sound, no stream. Pressing play only moves the clock.",
    running: "Running order",
    from: (tracks: number, time: string, start: string) => `${tracks} tracks, ${time}. From ${start}`,
    playing: "Playing",
    paused: "Paused",
    first: "First",
    played: "Played",
    missing: { title: "Which session?", body: "This address names no listening session.", action: "All listening sessions" },
  },
  /** DEMONSTRATION MODE: the entrance picks one of the demo's invented listeners. Not a sign-in. */
  entrance: {
    title: "Enter as a demo listener",
    lede: `Pick one of ${service}'s invented listeners. Their data is simulated, nobody types anything personal, and it isn't a sign-in.`,
    legend: "Demo listeners",
    enter: "Enter as this listener",
    switch: "Switch listener",
    inOtherMarket: (marketName: string) => `In ${marketName}: this campaign is not sold there.`,
    otherPrices: (marketName: string, here: string) => `In ${marketName}: the prices here are for ${here}.`,
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
    planNotForYou: "This plan isn't for this listener",
    otherMarket: {
      title: "These are another market's prices",
      body: (theirs: string, here: string) =>
        `This listener is in ${theirs}, and these are the prices for ${here}. A listener subscribes at the prices of their own market.`,
      action: (theirs: string) => `See the prices for ${theirs}`,
    },
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
