// What a launch shows (business book §7.5, §14.6). The engine activates a
// scheduled change step by step (check, prepare, publish, notify, verify),
// each step in a transaction of its own, beginning a minute before the
// change's first start. A step that fails is tried again after a growing
// wait (5, 15, 45 and 135 seconds), and after 5 failures in a row the launch
// fails and opens an incident; a check that finds a clash or a later price
// refuses it at once. Until the publish step is done, the catalog of before
// stays live: no part of the change is on the site.
//
// Here are the words and looks the console gives all that, and what the
// on-call engineer may still do with a launch, by the engine's own rules
// (services/commerce, engine/launches.py: retry and cancel).
import type { IconName } from "design";
import type { IncidentKind, IncidentState, LaunchRunQuery, LaunchRunsQuery, LaunchState } from "../graphql/generated.ts";
import { formatInstantIn } from "./time.ts";

export type LaunchSummary = LaunchRunsQuery["launches"]["nodes"][number];
export type LaunchDetail = NonNullable<LaunchRunQuery["launch"]>;
export type LaunchStep = LaunchDetail["steps"][number];

/** The steps in the order the engine runs them, with the name the console gives each. */
export const STEP_NAME: Readonly<Record<string, string>> = {
  check: "Check",
  prepare: "Prepare",
  publish: "Publish",
  notify: "Tell the site",
  verify: "Verify from outside",
};

export const MAX_FAILURES = 5;

/** Where a launch's timeline is. */
export function launchHref(id: string): string {
  return `/launches/run/?id=${id}`;
}

type Look = { readonly word: string; readonly look: "waiting" | "rejected" | "done" | "approved" | "draft" | "ended"; readonly icon: IconName };

export const LAUNCH_LOOK: Readonly<Record<LaunchState, Look>> = {
  RUNNING: { word: "Running", look: "waiting", icon: "hourglass-medium" },
  DONE: { word: "Published", look: "done", icon: "check-circle" },
  FAILED: { word: "Failed", look: "rejected", icon: "x-circle" },
  REFUSED: { word: "Refused", look: "rejected", icon: "prohibit" },
  CANCELLED: { word: "Cancelled", look: "ended", icon: "x" },
};

/** A running launch that waits to try a failed step again. */
export function waiting(launch: Pick<LaunchSummary, "state" | "retryAt">): boolean {
  return launch.state === "RUNNING" && launch.retryAt !== null;
}

/** The launch's state as a chip says it: a running launch that waits says so. */
export function launchLook(launch: Pick<LaunchSummary, "state" | "retryAt">): Look {
  return waiting(launch) ? { word: "Waiting to try again", look: "waiting", icon: "clock-countdown" } : LAUNCH_LOOK[launch.state];
}

export type StepLook = "done" | "running" | "failed" | "retrying" | "to-do";

export const STEP_LOOK: Readonly<Record<StepLook, Look>> = {
  done: { word: "Done", look: "done", icon: "check" },
  running: { word: "Running", look: "waiting", icon: "hourglass-medium" },
  failed: { word: "Failed", look: "rejected", icon: "x-circle" },
  retrying: { word: "Failed, tried again soon", look: "waiting", icon: "clock-countdown" },
  "to-do": { word: "To do", look: "draft", icon: "circle-dashed" },
};

/** How a step stands: a failed step of a launch that waits is tried again; of a stopped launch, it stays failed. */
export function stepLook(step: Pick<LaunchStep, "state">, launch: Pick<LaunchSummary, "state" | "retryAt">): StepLook {
  switch (step.state) {
    case "DONE":
      return "done";
    case "RUNNING":
      return "running";
    case "FAILED":
      return waiting(launch) ? "retrying" : "failed";
    case "PENDING":
      return "to-do";
  }
}

/** "3 done, 1 failed, 1 to do": the steps counted by how they stand, in that order, without the empty ones. */
export function stepCounts(steps: readonly Pick<LaunchStep, "state">[], launch: Pick<LaunchSummary, "state" | "retryAt">): string {
  const order: readonly StepLook[] = ["done", "running", "retrying", "failed", "to-do"];
  const words: Readonly<Record<StepLook, string>> = { done: "done", running: "running", retrying: "to be tried again", failed: "failed", "to-do": "to do" };
  const counted = order.map((look) => ({ look, count: steps.filter((step) => stepLook(step, launch) === look).length })).filter((entry) => entry.count > 0);
  return counted.map((entry) => `${entry.count} ${words[entry.look]}`).join(", ");
}

/** Whether the change reached the site: the publish step is done (or, in a list without steps, a snapshot went live). */
export function published(launch: Pick<LaunchSummary, "state" | "snapshotAfter"> & { readonly steps?: readonly Pick<LaunchStep, "name" | "state">[] }): boolean {
  if (launch.steps && launch.steps.length) return launch.steps.some((step) => step.name === "publish" && step.state === "DONE");
  return launch.state === "DONE" || launch.snapshotAfter !== null;
}

/**
 * What the launch itself did, as it happened: the catalog its publish step put
 * live and when, or, until then, the catalog of before that stayed live. It
 * is history: a change suspended or ended afterwards does not rewrite it.
 */
export type Publication = { readonly published: boolean; readonly catalog: string | null; readonly at: string | null; readonly words: string };

export function publication(launch: Pick<LaunchDetail, "state" | "snapshotBefore" | "snapshotAfter" | "steps">): Publication {
  const step = launch.steps.find((entry) => entry.name === "publish");
  if (published(launch)) {
    return {
      published: true, catalog: launch.snapshotAfter, at: step?.finishedAt ?? null,
      words: `It published catalog #${launch.snapshotAfter ?? "?"}, with the change in it, in one piece${step && step.attempts > 1 ? `, on its publish step's attempt ${step.attempts} of ${MAX_FAILURES}` : ""}.`,
    };
  }
  if (launch.state === "RUNNING") {
    return { published: false, catalog: launch.snapshotBefore, at: null, words: `Nothing yet: catalog #${launch.snapshotBefore ?? "?"} stays live until the publish step is done.` };
  }
  return {
    published: false, catalog: launch.snapshotBefore, at: null,
    words: launch.state === "CANCELLED" ? "Nothing: it was given up before it published, and the catalog of before stayed live." : `Nothing: catalog #${launch.snapshotBefore ?? "?"} stayed live, and no part of the change reached the site.`,
  };
}

/** The change's state now, in a sentence about the site. */
const ON_THE_SITE: Readonly<Record<string, string>> = {
  ACTIVE: "is live on the site",
  SUSPENDED: "is suspended: it is not on the site",
  ENDED: "has ended: it is not on the site any more",
  CANCELLED: "is cancelled: it is not on the site",
  SCHEDULED: "is scheduled, not on the site yet",
  APPROVED: "is approved, not on the site yet",
};

/**
 * What is true now, which a finished launch does not follow: the change's
 * state today (read with the launch) and the catalog live today (the newest
 * one the log says was published). differs, when today is not what the
 * launch left: the change it published is not live any more, or a later
 * catalog is the live one.
 */
export type Now = { readonly catalog: string | null; readonly words: string; readonly differs: string | null };

export function now(launch: Pick<LaunchDetail, "title" | "version" | "state" | "snapshotBefore" | "snapshotAfter" | "steps" | "change">, liveCatalog: string | null): Now {
  const words = `${launch.title} v${launch.version} ${ON_THE_SITE[launch.change.state] ?? "is not on the site"}.`;
  const left = publication(launch);
  if (!left.published) return { catalog: liveCatalog, words, differs: null };
  if (launch.change.state !== "ACTIVE") {
    const word = ON_THE_SITE[launch.change.state]?.split(":")[0]?.replace(/^is |^has /, "") ?? launch.change.state.toLowerCase();
    return {
      catalog: liveCatalog, words,
      differs: `Not what this launch left: it published catalog #${left.catalog ?? "?"} with the change live; since then the change was ${word}${liveCatalog && liveCatalog !== left.catalog ? `, and catalog #${liveCatalog} is the live one` : ""}.`,
    };
  }
  if (liveCatalog !== null && liveCatalog !== left.catalog) {
    return { catalog: liveCatalog, words, differs: `Catalog #${liveCatalog} is the live one now, published after this launch's #${left.catalog ?? "?"}; the change is still in it.` };
  }
  return { catalog: liveCatalog, words, differs: null };
}

/**
 * What the on-call engineer may still do, by the engine's rules: try again a
 * failed, refused or waiting launch, from the step that stopped it; give up a
 * launch that has not published (its change is then cancelled, with the
 * reason). A published change leaves the site by being suspended instead.
 */
export function launchActions(launch: Pick<LaunchDetail, "state" | "retryAt" | "snapshotAfter" | "steps">): { readonly retry: boolean; readonly cancel: boolean } {
  const stopped = launch.state === "FAILED" || launch.state === "REFUSED";
  return {
    retry: stopped || waiting(launch),
    cancel: (stopped || launch.state === "RUNNING") && !published(launch),
  };
}

export const INCIDENT_KIND: Readonly<Record<IncidentKind, string>> = {
  LATE: "Not live 5 minutes after its start",
  FAILED: `A step failed ${MAX_FAILURES} times`,
  REFUSED: "Refused at its check",
};

export const INCIDENT_LOOK: Readonly<Record<IncidentState, Look>> = {
  OPEN: { word: "Open", look: "rejected", icon: "warning" },
  RECOVERED: { word: "Recovered on its own", look: "done", icon: "arrows-clockwise" },
  RESOLVED: { word: "Resolved by a person", look: "done", icon: "check-circle" },
};

/**
 * The engine's words about a launch (a cause, a resolution, an incident's
 * summary) as a sentence for people: a capital first, and every instant it
 * names read in the market's time, "26 Oct 08:59:05 Rome", not as ISO 8601.
 */
export function launchWords(text: string, zone: string, options: { readonly capital?: boolean } = {}): string {
  const read = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, (instant) => formatInstantIn(instant, zone, { seconds: true }));
  return options.capital === false ? read : `${read.charAt(0).toUpperCase()}${read.slice(1)}`;
}

/** "+0.41 s", "+5.6 s", "+2 min 15 s": how long after the launch began. */
export function elapsed(from: string, to: string): string {
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  if (ms < 10_000) return `+${(ms / 1000).toFixed(2)} s`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `+${minutes} min${seconds ? ` ${seconds} s` : ""}`;
}
