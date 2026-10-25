// The rounds of asking again while something waits for the payment provider
// (business book §4.5): a round opens when something starts to wait, and
// again each time the visitor checks again; it lasts its limit, and then the
// asking stops and the page says the provider has not answered yet. A
// provider that keeps a payment pending is so asked for a limited time after
// every check, and said to be slow every time.
//
// It knows nothing of React, and is given its timer, so that a test drives it
// with a clock of its own; the hook useMeWhileWaiting holds one for a page.

/** What starts and stops a round's limit: the page's setTimeout, or a test's clock. */
export type RoundTimer = {
  start(done: () => void, ms: number): unknown;
  stop(handle: unknown): void;
};

const pageTimer: RoundTimer = {
  start: (done, ms) => setTimeout(done, ms),
  stop: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class WaitRounds {
  readonly #limitMs: number;
  readonly #changed: () => void;
  readonly #timer: RoundTimer;
  #waiting = false;
  #handle: unknown = null;
  #timedOut = false;

  /** `changed` is called whenever timedOut changes, for the page to show it. */
  constructor(limitMs: number, changed: () => void, timer: RoundTimer = pageTimer) {
    this.#limitMs = limitMs;
    this.#changed = changed;
    this.#timer = timer;
  }

  /** Whether to keep asking: until a round runs out with nothing answered. */
  get asking(): boolean {
    return !this.#timedOut;
  }

  /** Whether a round ran out with something still waiting: the page says the provider has not answered yet. */
  get timedOut(): boolean {
    return this.#timedOut;
  }

  /** What waits now: starting to wait opens a round, and nothing waiting any more ends it. */
  follow(waiting: boolean): void {
    if (waiting === this.#waiting) return;
    this.#waiting = waiting;
    if (waiting) this.#open();
    else this.#end();
  }

  /** The visitor checks again: while something still waits, a new round, as long as the first. */
  checkAgain(): void {
    if (this.#waiting) this.#open();
  }

  /** The page goes: no round outlives it. */
  dispose(): void {
    this.#stop();
    this.#waiting = false;
    this.#timedOut = false;
  }

  #open(): void {
    this.#stop();
    this.#set(false);
    this.#handle = this.#timer.start(() => {
      this.#handle = null;
      this.#set(true);
    }, this.#limitMs);
  }

  #end(): void {
    this.#stop();
    this.#set(false);
  }

  #stop(): void {
    if (this.#handle !== null) this.#timer.stop(this.#handle);
    this.#handle = null;
  }

  #set(timedOut: boolean): void {
    if (this.#timedOut === timedOut) return;
    this.#timedOut = timedOut;
    this.#changed();
  }
}
