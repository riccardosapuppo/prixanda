// The names the people see, in one place. Both are provisional, as the
// business book says at its start: the definitive ones are chosen and checked
// before publication. Everything else (folders, files, classes, keys) stays
// neutral, so a new name changes these two strings and nothing more.
export const BRAND = { platform: "Plancia", service: "Rione" } as const;

/**
 * Said wherever a visitor could take the demonstration for the real thing:
 * next to subscriptions, payments and passes on the site, and in the
 * console's frame (business book §13.3).
 */
export const DISCLAIMER = "Independent personal project. Fictional business and synthetic customer data. No real payments are processed.";

/** The label every simulated figure carries. */
export const SIMULATED_LABEL = "Simulated data";

/** Where the source of everything the demo runs is kept. */
export const SOURCE_URL = "https://github.com/riccardosapuppo/subscription-offers-platform";

/**
 * The demo in the browser (stage 8), in the same words in both apps: the
 * line at the foot of every page, and the panel that says what the sandbox
 * is, where its data stays, how to start over, what it cannot do, and what in
 * it is simulated and what is the real thing.
 */
export const SANDBOX = {
  /** The line at the foot, with "GitHub" the link to SOURCE_URL: before + link + after. */
  line: {
    before: "Your data stays in this browser. The full system runs the Python engine behind gRPC and PostgreSQL; the source is on ",
    link: "GitHub",
    after: ".",
  },
  about: {
    title: "About this sandbox",
    where: {
      title: "Where your data is",
      text: "In this browser only, in the IndexedDB storage of this address. Nothing you do here is sent anywhere.",
    },
    reset: {
      title: "Starting over",
      text: "Start over puts the demo back as it was built, in every tab. Clearing this site's data in the browser does the same.",
    },
    limits: {
      title: "What it cannot do",
      text: "Another browser or another device does not see your changes, and a private window loses them when it closes.",
    },
    simulated: {
      title: "Simulated",
      text: "The launch fault, the demo's clock, the payments and the student verification.",
    },
    real: {
      title: "The real thing",
      text: "The same engine code, the same database migrations and the same GraphQL schemas as the full system.",
    },
    startOver: "Start over",
    confirm: "Every change made in this browser is lost, in every tab, and the demo starts again from its first data.",
    confirmAction: "Yes, start over",
    keep: "Keep my changes",
    startingOver: "Starting over",
  },
} as const;
