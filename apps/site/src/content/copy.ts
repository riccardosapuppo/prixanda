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
/** What an offer for an artist's listeners asks of their listening, as the API says it (§14.2). */
type Listening = { readonly artist: string; readonly minSeconds: number; readonly withinDays: number };

const count = (n: number) => n.toLocaleString("en-GB");
/** A time of listening as the engine words it: 7,200 seconds as 2 hours, 5,400 as 90 minutes, 45 as 45 seconds. */
function listeningTime(seconds: number): string {
  for (const [unit, size] of [["hour", 3_600], ["minute", 60]] as const) {
    if (seconds % size === 0) return `${count(seconds / size)} ${unit}${seconds === size ? "" : "s"}`;
  }
  return `${count(seconds)} ${seconds === 1 ? "second" : "seconds"}`;
}

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
  nav: {
    label: service, plans: "Plans", releases: "New releases", sessions: "Listening sessions", gift: "Gift a pass", account: "Account", menu: "Menu",
    skip: "Skip to the content",
  },
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
      body: "It isn't on sale in this market now, or not to you: it has ended, it hasn't started yet, or it is only for some listeners. The plans and their prices are still there.",
      action: "See the plans",
    },
    missing: {
      title: "Which campaign?",
      body: "This address names no campaign. The campaigns on sale are listed with the plans.",
      action: "See the plans",
    },
  },
  /**
   * An offer for an artist's listeners (§14.2). Only they are shown it
   * (§6.8), so it says who it is for as what they did; the artist, the time
   * and the days are the API's.
   */
  listening: {
    forListeners: (rule: Listening) =>
      `For listeners who played ${rule.artist} for more than ${listeningTime(rule.minSeconds)} in the last ${rule.withinDays === 1 ? "day" : `${count(rule.withinDays)} days`}.`,
    /** The campaign page's tag. */
    tag: (artist: string) => `Listeners of ${artist}`,
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
  /**
   * The prepaid pass on the home (§9): its title, words and terms are the
   * pass's own, as the console published them; the price and the months are
   * the engine's. A demonstration: the payment is simulated.
   */
  gift: {
    buy: "Get a demo gift code",
    once: "paid once, VAT included",
    soldIn: (title: string, market: string, price: string) => `${title}: sold in ${market} only, at ${price}.`,
    showMarket: (market: string) => `Show prices for ${market}`,
    neverRenews: "The code never renews",
    figure: (months: number) => `${months} ${months === 1 ? "month" : "months"}, paid once`,
    elsewhere: (market: string, here: string) => `In ${market}: this pass is sold in ${here} only.`,
    otherMarket: {
      title: "This pass is sold in another market",
      body: (theirs: string, here: string) => `This listener is in ${theirs}, and this pass is sold in ${here}. A listener buys at the prices of their own market.`,
    },
    confirm: {
      title: "Confirm your demo purchase",
      summary: (title: string, market: string) => `${title}, ${market}`,
      price: (price: string) => `${price} once, VAT included`,
      gives: (months: number, plan: string, valid: number) =>
        `${months} ${months === 1 ? "month" : "months"} of ${plan} from the day the code is activated, never charged and never renewed. The code can be activated for ${valid} ${valid === 1 ? "month" : "months"}.`,
      note: "Nothing is charged and no contract is made: the payment step is simulated. The price is the engine's, as the pass is on sale in this market.",
      action: "Confirm the demo purchase",
      buying: "Buying",
    },
    pendingTitle: "Your code is on its way",
    waiting: "Waiting for the payment provider. It is simulated, and answers within seconds.",
    slow: "The payment provider hasn't answered yet. Check again in a moment: the code is in the account as soon as it answers.",
    failed: "The payment provider declined the payment: this code will never work.",
    checkAgain: "Check again",
    receipt: {
      title: "Demo receipt: no money moved.",
      code: "Your code",
      validUntil: (day: string) => `Activate it by ${day}. It works once.`,
      give: "Give it, or activate it yourself in the account.",
      copy: "Copy the code",
      copied: "Copied",
      account: "See the account",
      again: "Back to the gift pass",
    },
    refused: "This pass can't be bought now",
  },
  /** A price change of the running subscription (§8): every date in these sentences is the engine's. */
  priceChange: {
    title: (plan: string) => `Your ${plan} plan price is changing`,
    law: "The law",
    choice: `${service}'s choice`,
    choiceTag: "Not a legal requirement",
    answering: "Sending your answer",
    refused: "This answer can't be given now",
    consent: {
      now: (oldPrice: string, from: string, plan: string, market: string, newPrice: string) =>
        `You pay ${oldPrice} a month. From ${from}, new ${plan} subscribers in ${market} pay ${newPrice}.`,
      ask: (newPrice: string) => `We'd like you to pay ${newPrice} too, and we need your yes before we can charge it.`,
      ifYes: (newPrice: string, day: string) => `If you say yes: you pay ${newPrice} from your billing date on ${day}.`,
      ifNo: (deadline: string, plan: string, day: string) =>
        `If you say no, or don't answer by ${deadline}: your ${plan} plan ends on ${day}, when the month you've paid for runs out, and the account moves to Free.`,
      ifNoOther: (deadline: string) => `If you say no, or don't answer by ${deadline}: ${service} applies its choice for this market, below.`,
      yes: (newPrice: string) => `Yes, move me to ${newPrice}`,
      no: (plan: string, day: string) => `No, end my ${plan} plan on ${day}`,
      noPlain: "No, I don't accept",
      silence: (deadline: string) => `If we don't hear from you by ${deadline}, we take it as a no.`,
      lanes: {
        today: "Today",
        yes: "If you say yes",
        no: (deadline: string) => `If you say no, or don't answer by ${deadline}`,
        free: "Free",
      },
    },
    notice: {
      now: (oldPrice: string, newPrice: string, day: string) => `You pay ${oldPrice} a month. From your billing date on ${day}, you pay ${newPrice}.`,
      newSubscribers: (plan: string, market: string, from: string) => `New ${plan} subscribers in ${market} pay it from ${from}.`,
      leave: (day: string) => `You can leave before the new price: your plan then ends on ${day}, and the account moves to Free.`,
      leaveAction: (day: string) => `Leave on ${day}`,
      closes: (deadline: string) => `You can choose to leave until ${deadline}.`,
    },
    outcome: {
      accepted: "Your answer: yes",
      acceptedWhat: (newPrice: string, day: string) => `You pay ${newPrice} a month from your billing date on ${day}.`,
      declined: "Your answer: no",
      declinedWhat: (plan: string, day: string) => `Your ${plan} plan ends on ${day}, when the month you've paid for runs out, and the account moves to Free.`,
      lapsed: "No answer by the deadline: that counts as no",
      left: "You chose to leave",
      leftWhat: (plan: string, day: string) => `Your ${plan} plan ends on ${day}, before the new price is charged, and the account moves to Free.`,
      newPrice: "The new price applies",
      newPriceWhat: (newPrice: string, day: string) => `You pay ${newPrice} a month from ${day}.`,
      choiceApplies: `${service}'s choice for this market applies, as written below.`,
    },
  },
  /**
   * The demo's sandbox starting in this browser (stage 8): its steps are the
   * worker's own words. The line at the foot and the panel about the sandbox
   * are the two apps' shared words (design's SANDBOX).
   */
  sandbox: {
    starting: "Starting the demo in this browser",
    firstVisit: "The first visit takes a few seconds: the database, Python and the engine start here, on your device.",
    step: (done: number, of: number) => `Step ${done} of ${of}`,
    waiting: "Waiting for the demo to start",
    failedTitle: "The demo can't start in this browser",
    missing: (what: string) => `This browser does not offer ${what}, which the demo needs to run here.`,
    worker: (reason: string) => `The demo stopped while starting: ${reason}`,
    advice: "Open it in a normal window of a recent Chrome, Edge, Firefox or Safari: a private window may refuse the storage the demo needs.",
    otherBuild: "Another version of the demo is open in another tab of this browser. Close the other tabs of the demo, then reload this one.",
    reload: "Reload",
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
    ends: "Paid plan ends",
    endsOn: (day: string) => `${day}, then Free`,
    endsWithoutYes: (day: string) => `${day}, unless you say yes`,
    prepaid: (price: string) => `Prepaid: ${price}, paid once`,
    prepaidNever: "Never charged, never renewed",
    codes: {
      title: "Your prepaid codes",
      lede: "Each code works once. Give it, or activate it yourself below.",
      bought: (day: string, price: string) => `Bought on ${day}, ${price}`,
      activateBy: (day: string) => `Activate by ${day}`,
      state: {
        PENDING: "Payment pending",
        READY: "Ready to give or activate",
        ACTIVATED: "Activated",
        EXPIRED: "Expired",
        FAILED: "Payment declined",
      } as Readonly<Record<string, string>>,
      activatedOn: (day: string) => `Activated on ${day}`,
      expiredOn: (day: string) => `Not activated by ${day}`,
    },
    activate: {
      title: "Activate a code",
      lede: "A prepaid code gives its months of a plan from today: never charged, never renewed, then Free.",
      label: "Code",
      hint: "Three groups of four letters and digits.",
      shape: "A code is three groups of four letters and digits, as on the receipt: check it and try again.",
      action: "Activate",
      activating: "Activating",
      refused: "This code can't be activated",
      done: (plan: string, day: string) => `Activated: ${plan} until ${day}, then Free.`,
    },
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
