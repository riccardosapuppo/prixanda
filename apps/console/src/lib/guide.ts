// The demo's "Try this" (stage 8): the guided path in two minutes, as
// steps that tick themselves when they happen. Open the site and see its
// offers; create a campaign as Marketing; try to approve it yourself, and
// find you cannot; approve it as Finance; schedule its launch; cause a fault
// and skip to the launch, to watch the engine recover; find the campaign on
// the site.
//
// What happened is read where it is: the campaign's state, its signatures
// and its launch come from the engine; what only this browser knows (the
// campaign created here, the approval page seen by its author, the site
// opened) is kept in this browser's storage, for every tab of the console,
// and forgotten when the demo starts over.
export const GUIDE_KEY = "offers-demo-guide";

export type GuideRecord = {
  /** The campaign created in this browser that the steps follow: the latest one. */
  readonly changeId: string | null;
  /** Its author opened its approval page, and found no button. */
  readonly triedOwn: boolean;
  /** The site was opened from the guide. */
  readonly siteOpened: boolean;
  /** The site was opened again once the campaign was live. */
  readonly foundOnSite: boolean;
};

export const EMPTY_GUIDE: GuideRecord = { changeId: null, triedOwn: false, siteOpened: false, foundOnSite: false };

/** What the engine says about the campaign the steps follow. */
export type GuideFacts = {
  readonly state: string | null;
  /** Someone signed one of its versions. */
  readonly signed: boolean;
  /** Its launch is done, and a step of it was tried more than once: a fault and the recovery. */
  readonly recovered: boolean;
};

export const NO_FACTS: GuideFacts = { state: null, signed: false, recovered: false };

export type StepId = "site" | "create" | "own" | "approve" | "schedule" | "fault" | "found";

export type GuideStep = { readonly id: StepId; readonly words: string; readonly done: boolean };

const LIVE_OR_ON_ITS_WAY = new Set(["APPROVED", "SCHEDULED", "ACTIVE", "ENDED", "SUSPENDED"]);

/** The seven steps, each done or not. */
export function guideSteps(record: GuideRecord, facts: GuideFacts): readonly GuideStep[] {
  const ours = record.changeId !== null;
  return [
    { id: "site", words: "See the offers on the site", done: record.siteOpened },
    { id: "create", words: "Create a campaign, as Marketing", done: ours },
    { id: "own", words: "Try to approve it yourself", done: ours && record.triedOwn },
    { id: "approve", words: "Approve it, as Finance", done: ours && (facts.signed || LIVE_OR_ON_ITS_WAY.has(facts.state ?? "")) },
    { id: "schedule", words: "Schedule its launch", done: ours && (facts.state === "SCHEDULED" || facts.state === "ACTIVE") },
    { id: "fault", words: "Cause a fault, then skip to the launch", done: ours && facts.recovered },
    { id: "found", words: "Find it on the site", done: ours && record.foundOnSite },
  ];
}

/** The first step not done: where the person is. Null when every step is done. */
export function currentStep(steps: readonly GuideStep[]): StepId | null {
  return steps.find((step) => !step.done)?.id ?? null;
}

/** A launch's attempts of all its steps together: five when nothing failed (check, prepare, publish, notify, verify). */
export const STEPS_OF_A_LAUNCH = 5;

/** Whether a launch went through after a fault: done, with more attempts than its steps. */
export function recoveredFrom(launch: { readonly state: string; readonly attempts: number }): boolean {
  return launch.state === "DONE" && launch.attempts > STEPS_OF_A_LAUNCH;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

/** The record in this browser, or the empty one: a storage that refuses (a private window) is no record. */
export function readGuide(storage: Storage | null): GuideRecord {
  try {
    const text = storage?.getItem(GUIDE_KEY);
    if (!text) return EMPTY_GUIDE;
    const value = JSON.parse(text) as Partial<GuideRecord>;
    return {
      changeId: typeof value.changeId === "string" ? value.changeId : null,
      triedOwn: value.triedOwn === true,
      siteOpened: value.siteOpened === true,
      foundOnSite: value.foundOnSite === true,
    };
  } catch {
    return EMPTY_GUIDE;
  }
}

/** Keeps what happened; a new campaign starts its own steps again, past the site. */
export function nextGuide(record: GuideRecord, patch: Partial<GuideRecord>): GuideRecord {
  if (patch.changeId !== undefined && patch.changeId !== record.changeId) {
    return { ...record, triedOwn: false, foundOnSite: false, ...patch };
  }
  return { ...record, ...patch };
}

export function writeGuide(storage: Storage | null, record: GuideRecord): void {
  try {
    storage?.setItem(GUIDE_KEY, JSON.stringify(record));
  } catch {
    // A storage that refuses keeps nothing: the steps tick again from the engine's data where they can.
  }
}

export function clearGuide(storage: Storage | null): void {
  try {
    storage?.removeItem(GUIDE_KEY);
  } catch {
    // nothing kept, nothing to forget
  }
}
